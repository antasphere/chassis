import { createLocalJWKSet, jwtVerify, type JWK, type JWTVerifyOptions } from 'jose';
import { type Db } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import { mcpResourceUrl, type Auth } from './better-auth.js';
import { isWorkspaceSelector, resolveMembership, type OnWorkspaceMiss } from './resolve-membership.js';

/**
 * OAuth Bearer-JWT resolution — the third credential path in auth-context.
 *
 * Access tokens are RS256 JWTs this instance minted itself (Better Auth jwt +
 * oauthProvider plugins), so verification is fully local: JWKS straight from
 * the jwt plugin (DB-backed, no HTTP), hard issuer / audience / algorithm /
 * expiry pinning. On top of the signature, every request re-resolves the
 * workspace membership LIVE — deactivating a member cuts token access on
 * their next request, not at token expiry. Scope enforcement stays in the
 * fail-closed allowlist gate (middleware/scopes.ts), identical to API keys.
 *
 * User-scoped credential model: a token identifies its USER ("act as you")
 * and carries NO workspace authority — claims are never an authorization
 * input. The request's target workspace comes from the X-Workspace-Id
 * selector through the shared resolveMembership rule (explicit → fail-closed
 * membership check; absent → the user's default, else oldest active), the
 * same rule sessions and API keys use.
 */
const JWKS_TTL_MS = 10 * 60 * 1000;

export class OauthJwtVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  // Per-instance cache: the process verifies its OWN tokens, keys rotate
  // rarely; on an unknown-signature failure we refetch once and retry.
  private jwksCache: { keySet: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null = null;

  constructor(
    private readonly auth: Auth,
    private readonly db: Db,
    publicBaseUrl: string,
    /** Cloud only: one cached reconcile on a well-formed selector miss. */
    private readonly onWorkspaceMiss?: OnWorkspaceMiss | undefined
  ) {
    this.issuer = publicBaseUrl;
    this.audience = mcpResourceUrl(publicBaseUrl);
  }

  private async keySet(forceRefresh = false) {
    if (!forceRefresh && this.jwksCache && Date.now() - this.jwksCache.fetchedAt < JWKS_TTL_MS) {
      return this.jwksCache.keySet;
    }
    const jwks = (await this.auth.api.getJwks()) as { keys: JWK[] };
    this.jwksCache = { keySet: createLocalJWKSet(jwks), fetchedAt: Date.now() };
    return this.jwksCache.keySet;
  }

  private async verify(token: string) {
    const options: JWTVerifyOptions = {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256'], // hard allowlist — implicitly rejects none/HS256
      clockTolerance: 5,
      requiredClaims: ['sub']
    };
    try {
      return await jwtVerify(token, await this.keySet(), options);
    } catch (err) {
      // One retry with fresh keys covers signing-key rotation mid-cache —
      // both directions: a token signed by a key the cache no longer trusts
      // (JWSSignatureVerificationFailed) and a token signed by a key MINTED
      // after the cache was warmed (JWKSNoMatchingKey — the rotate-signing-key
      // drill would otherwise answer 401 for up to JWKS_TTL_MS, ADR 023).
      if (
        err instanceof Error &&
        (err.name === 'JWSSignatureVerificationFailed' || err.name === 'JWKSNoMatchingKey')
      ) {
        return await jwtVerify(token, await this.keySet(true), options);
      }
      throw err;
    }
  }

  /**
   * Resolve a Bearer JWT to its principal, or null when the token fails
   * verification or no live membership answers the selection — the same
   * fail-closed semantics as the session and API-key paths.
   *
   * `requested` is the request's X-Workspace-Id (or null). Resolution is
   * verify → sub → resolveMembership(sub, requested): the LIVE membership
   * lookup is the instant-revocation point AND the whole workspace
   * authorization. A legacy `workspace_id` claim (minted before the
   * user-scoped model) is deliberately ignored — claims stopped being an
   * authorization input entirely.
   */
  async resolve(token: string, requested: string | null): Promise<Principal | null> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await this.verify(token));
    } catch {
      return null;
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return null;

    let member = await resolveMembership(this.db, sub, requested);
    if (!member && requested && this.onWorkspaceMiss && isWorkspaceSelector(requested)) {
      // Unknown-workspace retry (cloud): the JWT verified above — the miss
      // may be a hub org granted since the last reconcile pass. One cached
      // reconcile, one re-run of the SAME lookup — no recursion.
      await this.onWorkspaceMiss(sub, requested);
      member = await resolveMembership(this.db, sub, requested);
    }
    if (!member) return null;

    return {
      userId: sub,
      email: member.email,
      name: member.name,
      workspaceId: member.workspaceId,
      role: member.role,
      origin: member.origin,
      via: 'oauth',
      scopes: new Set(
        String(typeof payload.scope === 'string' ? payload.scope : '')
          .split(' ')
          .filter(Boolean)
      ),
      ...(member.accountRef ? { accountRef: member.accountRef } : {})
    };
  }
}
