import { and, eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { symmetricDecrypt } from 'better-auth/crypto';
import { account, type Db } from '@antasphere/chassis-db';
import type { Logger } from '../logger.js';
import { isLikelyEncrypted } from './hub-grant.js';
import { HUB_SSO_PROVIDER_ID } from './hub-sso.js';

/**
 * RP-initiated logout against the hub (SL-2, internal/federation.md): "one
 * concept of being logged in" needs logout-anywhere to end the HUB session,
 * not just the local one. The hub's oauth-provider plugin exposes
 * `GET /oauth2/end-session` (RP-initiated logout); this module builds the
 * URL the browser must VISIT to end the anchor session — the local revoke
 * itself happens in api/sso-logout.ts regardless of whether a URL could be
 * built.
 *
 * Everything here FAILS SOFT to `null` ("no hub leg — local signout only"):
 * a logout must never be blocked by a missing id_token, a hub outage, or a
 * malformed discovery document. Pinned 1.6.15 plugin facts this leans on
 * (re-verify on ANY Better Auth / oauth-provider bump):
 *
 *  - the id_token is stored PLAINTEXT on the `account` row —
 *    `encryptOAuthTokens` wraps only access/refresh tokens (setTokenUtil,
 *    dist/oauth2/utils.mjs; idToken is written raw in
 *    generic-oauth/routes.mjs + oauth2/link-account.mjs). The read below is
 *    still encrypted-TOLERANT (the hub-grant isLikelyEncrypted mirror) so a
 *    future bump that starts encrypting it cannot break logout;
 *  - the end-session endpoint HARD-FAILS on an id_token_hint without a
 *    `sid` claim ("id token missing session") — pre-flip id_tokens (minted
 *    before the hub client's enableEndSession flip) carry none, so a
 *    sid-less token degrades HERE to null instead of bouncing the user
 *    through a hub error;
 *  - verification there is signature-only (jose compactVerify against the
 *    hub JWKS) — an EXPIRED id_token is still a usable hint, so no expiry
 *    check happens here either;
 *  - `post_logout_redirect_uri` must EXACT-match the client's registered
 *    postLogoutRedirectUris — the cross-repo contract pins
 *    `<PUBLIC_BASE_URL>/login?signed_out=1`, seeded in the hub registry.
 */

/** The pinned post-logout landing (cross-repo contract — match EXACTLY). */
export function postLogoutRedirectUri(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '') + '/login?signed_out=1';
}

export interface HubLogoutOptions {
  db: Db;
  /** Hub OIDC issuer (HUB_ISSUER_URL) — discovery derives from it. */
  issuerUrl: string;
  /** This instance's public origin — the post-logout landing derives from it. */
  publicBaseUrl: string;
  /**
   * Better Auth's token-encryption key material (`(await
   * auth.$context).secretConfig`) — only ever consulted when a stored
   * id_token LOOKS encrypted (future-bump insurance; today's are plaintext).
   */
  key: () => Promise<Parameters<typeof symmetricDecrypt>[0]['key']>;
  logger: Logger;
  /** Discovery fetch timeout — a slow hub must never hang a logout. */
  discoveryTimeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export class HubLogoutService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Discovery-cached end-session endpoint; failures are retried per call. */
  private endpointCache: string | null = null;

  constructor(private readonly opts: HubLogoutOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.discoveryTimeoutMs ?? 3_000;
  }

  /**
   * The hub end-session URL for this user's CURRENT hub session, or null
   * when no usable hub leg exists (no `antasphere` account row, no stored
   * id_token, a sid-less pre-flip id_token, or an unreachable/endpoint-less
   * discovery document). The caller revokes the local session and clears
   * the hint EITHER WAY — null only means the browser skips the hub bounce.
   */
  async endSessionUrl(userId: string): Promise<string | null> {
    try {
      const idToken = await this.readIdToken(userId);
      if (!idToken) return null;
      // decode (NOT verify) — we only need the sid presence check; the hub
      // verifies the hint's signature itself on presentation.
      let sid: unknown;
      try {
        sid = decodeJwt(idToken).sid;
      } catch {
        return null; // not a JWT — nothing presentable
      }
      if (typeof sid !== 'string' || !sid) {
        // Pre-flip id_token (rollout caveat): the hub would hard-fail the
        // hint, so degrade to a local-only signout until the next login
        // stores a sid-carrying token.
        this.opts.logger.info({ userId }, 'hub logout: stored id_token carries no sid — local signout only');
        return null;
      }
      const endpoint = await this.endSessionEndpoint();
      if (!endpoint) return null;
      const url = new URL(endpoint);
      url.searchParams.set('id_token_hint', idToken);
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri(this.opts.publicBaseUrl));
      return url.toString();
    } catch (err) {
      this.opts.logger.warn({ err, userId }, 'hub logout: end-session URL build failed — local signout only');
      return null;
    }
  }

  /** The user's stored hub id_token, plaintext/encrypted-tolerant. */
  private async readIdToken(userId: string): Promise<string | null> {
    const [row] = await this.opts.db
      .select({ idToken: account.idToken })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .limit(1);
    const stored = row?.idToken;
    if (!stored) return null;
    // A JWT (dots, base64url) never matches isLikelyEncrypted, so today's
    // plaintext tokens pass straight through; a future encrypted value gets
    // one decrypt attempt and fails soft.
    if (!isLikelyEncrypted(stored)) return stored;
    try {
      return await symmetricDecrypt({ key: await this.opts.key(), data: stored });
    } catch (err) {
      this.opts.logger.warn({ err, userId }, 'hub logout: stored id_token failed to decrypt');
      return null;
    }
  }

  /** Discovery read, cached on success; a failed fetch retries next call. */
  private async endSessionEndpoint(): Promise<string | null> {
    if (this.endpointCache) return this.endpointCache;
    const discoveryUrl = this.opts.issuerUrl.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    try {
      const res = await this.fetchImpl(discoveryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!res.ok) {
        this.opts.logger.warn({ status: res.status }, 'hub logout: discovery answered non-2xx');
        return null;
      }
      const doc = (await res.json()) as { end_session_endpoint?: unknown };
      const endpoint = doc.end_session_endpoint;
      if (typeof endpoint !== 'string' || !endpoint) {
        // A hub predating the end-session flip advertises none — degrade.
        this.opts.logger.info('hub logout: discovery carries no end_session_endpoint — local signout only');
        return null;
      }
      this.endpointCache = endpoint;
      return endpoint;
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub logout: discovery unreachable — local signout only');
      return null;
    }
  }
}

/**
 * The Set-Cookie header value that CLEARS the shared SSO hint cookie —
 * mirroring the hub-set attributes exactly (cross-repo contract: Domain on
 * the shared parent, Path=/, SameSite=Lax, Secure on https, NOT HttpOnly)
 * so the browser matches and expires the hub's cookie rather than minting a
 * host-only shadow. Max-Age=0 is the deletion.
 */
export function hintCookieClearHeader(opts: { name: string; domain: string; secure: boolean }): string {
  return `${opts.name}=; Max-Age=0; Domain=${opts.domain}; Path=/; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}
