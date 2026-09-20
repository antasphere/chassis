import { AsyncLocalStorage } from 'node:async_hooks';
import type { JWTPayload } from 'jose';
import { and, eq, ne } from 'drizzle-orm';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { account, user as userTable, userOnboarding, type Db } from '@antasphere/chassis-db';
import type { Logger } from '../logger.js';
import { HubJwtVerifier } from './hub-jwt.js';
import type { ReconcilePassOutcome } from './hub-reconcile.js';
import type { LoginAccessToken } from './hub-user-client.js';

/**
 * "Sign in with Antasphere" — the cloud edition's SSO entrance
 * (internal/federation.md, user-scoped federation). This module owns everything
 * hub-SSO:
 *
 *  - the relying-party provider config for better-auth's `genericOAuth`
 *    plugin (registered by identity/better-auth.ts ONLY when the instance
 *    boots EDITION=cloud — an oss boot never constructs this class);
 *  - `HubJwtVerifier`: remote-JWKS verification of hub-minted JWTs (hard
 *    iss/aud pinning, RS256 allowlist, cached keys + one forced refresh);
 *  - the per-login ASSERTION handoff (an AsyncLocalStorage scope spanning
 *    the callback request — see `runWithLoginScope`);
 *  - the per-login work better-auth does not know about: identity guard,
 *    D10 email re-sync, and the FAIL-CLOSED login reconcile (the org
 *    projection) — a cloud login whose reconcile pass fails must not exist.
 *
 * Identity comes from the ID TOKEN ONLY (aud = HUB_CLIENT_ID). The access
 * token is never claim-bearing for the tool: the SSO code exchange sends
 * RFC 8707 `resource = <hub>/mcp` (the `tokenResource` seam constant shared
 * with hub-grant.ts), so the callback access token is HUB-audienced — a
 * bearer for the hub's own `/api/v1`, which the login-time reconcile uses
 * to read the user's org list AS THE USER. Org claims are gone from the
 * login path entirely; the hub's caller-scoped `GET /orgs` is the ONE
 * source of org/membership truth. Refresh + between-logins reads live in
 * hub-grant.ts / hub-user-client.ts; SSO scopes carry `offline_access
 * account:read` so the grant persists on the account row, plus
 * `orgs:create` (HUB_SSO_SCOPES below) for the one write the tool makes at
 * the hub as the user.
 */

/**
 * providerId of the hub relying party — the discovery method name in
 * `/api/v1/instance`, the better-auth callback path segment
 * (`/api/v1/auth/oauth2/callback/antasphere` — the redirect URI in the
 * hub's TOOL_REGISTRY entry), and the D9 trusted-provider key.
 */
export const HUB_SSO_PROVIDER_ID = 'antasphere';

/**
 * What one hub login asserts about the USER, extracted from the VERIFIED
 * id_token (aud = our client id). No org half: org truth is read live from
 * the hub, never from token claims.
 */
export interface HubSsoAssertion {
  /** Hub user id (`sub`) — matched against `account.accountId`, never a local user id. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/**
 * What one VERIFIED hub exchange JWT asserts (`POST /sso/cli-connect`,
 * internal/federation.md P5): the USER only. The H3 token still carries ONE
 * org's transitional claims through the hub's compat window, but the tool
 * reads none of them — org truth comes from the connect-time reconcile
 * (as-the-user `GET /orgs` with the grant the SAME H3 response delivered),
 * exactly like the browser login path.
 */
export interface HubConnectAssertion extends HubSsoAssertion {
  /** Unique per-token id — consumed one-time-use by the replay ledger. */
  jti: string;
  /** The token's own `exp` — how long the consumed jti must stay claimed. */
  expiresAt: Date;
}

/**
 * The minimal slice of better-auth's server API `provisionConnect` needs
 * (structural — `Auth` from identity/better-auth.ts satisfies it; typing it
 * here keeps hub-sso.ts free of an import cycle with that module). Going
 * through the INTERNAL ADAPTER is the point: `createOAuthUser` is the exact
 * call the genericOAuth callback makes for a browser-SSO JIT, so the
 * databaseHooks.user.create.after seam (`user.created` → the collaborator
 * grant sweep) fires identically, and the rows are byte-identical.
 */
export interface ConnectAuthSeam {
  $context: Promise<{
    internalAdapter: {
      createOAuthUser: (
        user: { email: string; name: string; emailVerified: boolean },
        account: { providerId: string; accountId: string }
      ) => Promise<{ user: { id: string } }>;
      linkAccount: (account: { providerId: string; accountId: string; userId: string }) => Promise<unknown>;
    };
  }>;
}

/**
 * The login-time face of the org reconciler (hub-reconcile.ts) — bound by
 * boot AFTER construction (the reconciler needs the auth context's secret,
 * which needs createAuth, which needs this service). Structural to avoid a
 * hard cycle.
 */
export interface LoginReconciler {
  forceReconcile(localUserId: string, login?: LoginAccessToken): Promise<ReconcilePassOutcome>;
}

/**
 * A login failure the after-hook converts into a clean, session-less
 * redirect back to /login?error=<code>. Codes are stable (the dashboard
 * maps them to copy); anything unexpected becomes `sso_login_failed`.
 * `/sso/cli-connect` reuses the same errors as 403 bodies —
 * `sso_link_refused` is its trusted-link refusal (never thrown on the
 * browser login path, where better-auth's own linking gate answers first).
 */
export class HubSsoLoginError extends Error {
  constructor(
    readonly code:
      | 'sso_assertion_missing'
      | 'sso_identity_conflict'
      | 'sso_email_conflict'
      | 'sso_link_refused'
      | 'sso_projection_failed'
      | 'sso_login_failed',
    message: string
  ) {
    super(message);
    this.name = 'HubSsoLoginError';
  }
}

/**
 * The assertion handoff (ADR 015, reshaped): the verified USER identity —
 * plus the raw hub-audienced access token the login reconcile presents —
 * exists in `getUserInfo` (PRE user-create); the per-login work runs in the
 * callback's after-hook (POST create). An AsyncLocalStorage scope
 * established around the whole auth request (api/index.ts wraps
 * `auth.handler`) carries it across: getUserInfo writes, the after-hook
 * takes. Being request-scoped, two concurrent logins can NEVER read each
 * other's assertion or token.
 */
export interface LoginScopeAssertion extends HubSsoAssertion {
  /** The callback access token (hub-audienced) — the login reconcile's bearer. */
  accessToken: string;
  accessTokenExpiresAt: Date | null;
}

interface LoginScope {
  assertion?: LoginScopeAssertion;
}

const loginScope = new AsyncLocalStorage<LoginScope>();

/**
 * The scopes the tool requests at hub sign-in — the ONE statement of the
 * list (the provider entry below spreads it; tests import it).
 *
 *  - `openid profile email`: the id_token identity.
 *  - `offline_access account:read`: the stored grant and its as-the-user
 *    `GET /orgs` reads (hub-grant.ts, hub-user-client.ts).
 *  - `orgs:create` (PRDCT-2443): the hub's DEDICATED scope for `POST /orgs`
 *    — it opens that one route, to a tool-registry client only.
 *    `account:write` does NOT open it and is deliberately not requested: a
 *    tool holds the narrowest write it needs, nothing account-wide.
 *
 * DEPLOY ORDER — THE HUB FIRST. The hub's authorize endpoint
 * (@better-auth/oauth-provider) validates every requested scope against the
 * CLIENT's registered scopes (its tool registry seeds them) and answers
 * `error=invalid_scope` for an unknown one — the WHOLE sign-in fails, for
 * every user, not just workspace creation. A hub that does not yet list
 * `orgs:create` for this client must never meet a tool that requests
 * it. A grant minted BEFORE this shipped simply lacks the scope: the hub
 * answers 403 `insufficient_scope` on create, which the route maps to 401
 * `hub_reauth_required` — one sign-in heals it.
 */
export const HUB_SSO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'account:read',
  'orgs:create'
] as const;

/**
 * Strict whitelist for per-call authorize params (the SL-1 silent-connect
 * seam): the dashboard's silent auto-connect passes
 * `additionalData: { prompt: 'none' }` on `POST /sign-in/oauth2`, and the
 * ONLY thing that may ever reach the hub's authorize URL from that
 * caller-controlled blob is the literal `prompt=none` pair — anything else
 * (other prompt values, extra keys) is dropped. Verified on better-auth
 * 1.6.15 (re-verify on ANY bump): `authorizationUrlParams` may be a
 * FUNCTION of the endpoint ctx (generic-oauth/types.d.mts), the sign-in
 * body carries `additionalData` (generic-oauth/routes.mjs — also threaded
 * into the state blob), and the function's return is applied to the
 * authorization URL via `createAuthorizationURL`'s `additionalParams`.
 */
export function ssoAuthorizationUrlParams(body: unknown): Record<string, string> {
  const additionalData = (body as { additionalData?: unknown } | null | undefined)?.additionalData;
  const prompt = (additionalData as { prompt?: unknown } | null | undefined)?.prompt;
  return prompt === 'none' ? { prompt: 'none' } : {};
}

export interface HubSsoOptions {
  db: Db;
  logger: Logger;
  /** The hub OIDC issuer (HUB_ISSUER_URL) — iss pin + discovery root. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * This instance's own OAuth resource identifier (`<PUBLIC_BASE_URL>/mcp`,
   * always derived, never configured) — the aud pin for H3 CONNECT tokens
   * (which the hub mints FOR this tool). Not used on the login path.
   */
  resourceUrl: string;
  /**
   * RFC 8707 `resource` for the SSO CODE EXCHANGE — `<hub>/mcp`
   * (hubApiResource), THE seam constant shared with hub-grant.ts: the
   * callback access token and every refreshed token are HUB-audienced and
   * callable at hub /api/v1. Null = omit the param (flips the whole flow
   * to opaque tokens in one line if the hub ever accepts them).
   */
  tokenResource: string | null;
  /** Dashboard origin for the failure redirects (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
}

export class HubSsoService {
  private readonly verifier: HubJwtVerifier;
  private reconciler: LoginReconciler | null = null;

  constructor(private readonly opts: HubSsoOptions) {
    this.verifier = new HubJwtVerifier(opts.issuerUrl);
  }

  /** Boot binds the reconciler once it exists (see LoginReconciler). */
  bindReconciler(reconciler: LoginReconciler): void {
    this.reconciler = reconciler;
  }

  /**
   * Establish the per-request login scope. api/index.ts wraps EVERY
   * /api/v1/auth/* request on cloud — an empty object store is free, and
   * wrapping unconditionally keeps the seam independent of better-auth's
   * internal routing.
   */
  runWithLoginScope<T>(fn: () => T): T {
    return loginScope.run({}, fn);
  }

  /** One-shot read of the assertion the current request's getUserInfo verified. */
  takeAssertion(): LoginScopeAssertion | undefined {
    const scope = loginScope.getStore();
    const assertion = scope?.assertion;
    if (scope) delete scope.assertion;
    return assertion;
  }

  /** Where a failed SSO login lands — the login page with a stable error code. */
  loginErrorUrl(code: string): string {
    return `${this.opts.publicBaseUrl.replace(/\/+$/, '')}/login?error=${encodeURIComponent(code)}`;
  }

  logLoginFailure(err: unknown, localUserId: string): void {
    this.opts.logger.warn(
      { err, localUserId },
      'hub SSO login failed after callback — session revoked, redirecting with error'
    );
  }

  /**
   * The genericOAuth provider entry for the hub. Notes that are POSTURE,
   * not accident:
   *
   *  - `scopes` (HUB_SSO_SCOPES) carry `offline_access account:read`: the
   *    grant IS the between-logins credential — better-auth persists the
   *    refresh token on the account row (encrypted; identity/better-auth.ts),
   *    and hub-grant.ts keeps it alive — and `orgs:create`, the hub's
   *    DEDICATED scope for `POST /orgs` (PRDCT-2443).
   *  - `tokenUrlParams.resource` (RFC 8707) is `tokenResource` — `<hub>/mcp`
   *    — so the minted access token is a bearer for the HUB's own API (the
   *    login reconcile + every between-logins read), never for ours.
   *  - `disableSignUp` stays UNSET: SSO IS the sanctioned signup entrance
   *    on cloud — the deliberate FOURTH switch next to the three
   *    closed-signup switches (CLAUDE.md invariant, internal/federation.md).
   *  - `getUserInfo` replaces the plugin's default entirely, so IT owns the
   *    emailVerified mapping — set from the hub's verified `email_verified`
   *    claim, never defaulted.
   */
  providerConfig(): GenericOAuthConfig {
    return {
      providerId: HUB_SSO_PROVIDER_ID,
      discoveryUrl: this.opts.issuerUrl.replace(/\/+$/, '') + '/.well-known/openid-configuration',
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      scopes: [...HUB_SSO_SCOPES],
      pkce: true,
      ...(this.opts.tokenResource ? { tokenUrlParams: { resource: this.opts.tokenResource } } : {}),
      // Per-call prompt=none passthrough for the silent auto-connect — the
      // strict whitelist above; nothing else from the caller's
      // additionalData ever reaches the hub authorize URL.
      authorizationUrlParams: (ctx) => ssoAuthorizationUrlParams(ctx.body),
      getUserInfo: (tokens) => this.getUserInfo(tokens)
    };
  }

  /**
   * Verify the callback id_token and extract the USER assertion. Returning
   * null makes the plugin fail the login with a clean error redirect — the
   * fail-closed path for every bad token (wrong iss/aud, expired, bad
   * signature, malformed claims). The access token is NOT verified here —
   * it is hub-audienced, never claim-bearing for us; it rides the login
   * scope as the reconcile's bearer, and the HUB verifies it on use.
   */
  private async getUserInfo(tokens: {
    accessToken?: string | undefined;
    idToken?: string | undefined;
    accessTokenExpiresAt?: Date | undefined;
  }): Promise<{ id: string; email: string; name: string; emailVerified: boolean } | null> {
    try {
      if (!tokens.idToken) throw new Error('token response carried no id_token (openid is always scoped)');
      if (!tokens.accessToken) throw new Error('token response carried no access token');
      const idClaims = await this.verifier.verify(tokens.idToken, this.opts.clientId);
      const assertion = buildUserAssertion(idClaims);
      const scope = loginScope.getStore();
      if (scope) {
        scope.assertion = {
          ...assertion,
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt ?? null
        };
      } else {
        // No scope means the auth mount was not wrapped — the after-hook
        // will fail this login closed (sso_assertion_missing). Say why.
        this.opts.logger.error(
          'hub SSO: getUserInfo ran outside a login scope — the callback after-hook will refuse this login'
        );
      }
      return {
        id: assertion.sub,
        email: assertion.email,
        name: assertion.name,
        emailVerified: assertion.emailVerified
      };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub SSO: callback token rejected');
      return null;
    }
  }

  /**
   * The per-login work (after-hook, newSession-gated, JIT and returning
   * users alike), in fail-closed order:
   *
   *  1. single-hub-identity guard — undo an email-match link that would
   *     merge two hub subjects into one local user;
   *  2. email re-sync (D10) with the explicit duplicate-email collision
   *     path (fail the login, corrupt nothing);
   *  3. the FAIL-CLOSED login reconcile: one forced pass reading the user's
   *     org list from the hub with the callback access token — reconcile IS
   *     the projection now. A pass that does not definitively succeed
   *     throws `sso_projection_failed` (session revoked, error redirect):
   *     a cloud login without its projection must not exist.
   *
   * Throws HubSsoLoginError; the caller revokes the just-minted session and
   * redirects. Any other throw is mapped to the generic failure code there.
   */
  async assertLogin(localUserId: string, assertion: LoginScopeAssertion): Promise<void> {
    await this.guardSingleHubIdentity(localUserId, assertion.sub);
    await this.syncEmail(localUserId, assertion);
    if (!this.reconciler) {
      // Boot always binds on cloud; a missing binding is a wiring bug and
      // must fail the login closed, never mint an unprojected session.
      throw new HubSsoLoginError('sso_projection_failed', 'no login reconciler bound (boot wiring bug)');
    }
    const outcome = await this.reconciler.forceReconcile(localUserId, {
      accessToken: assertion.accessToken,
      expiresAt: assertion.accessTokenExpiresAt
    });
    if (outcome !== 'ok') {
      throw new HubSsoLoginError('sso_projection_failed', `login reconcile pass failed (${outcome})`);
    }
    // SL-6: lazily mark the first login for the tool-local onboarding seam.
    // AFTER the reconcile 'ok' (a revoked login must not leave a row) and
    // strictly BEST-EFFORT: this write is NEVER a login failure mode — a
    // failed insert just means the row appears on the NEXT login, and the
    // banner semantics (`NOT EXISTS dismissed row` = welcome owed) already
    // show the welcome without any row at all. ON CONFLICT DO NOTHING keeps
    // returning logins from touching an existing (possibly dismissed) row.
    try {
      await this.opts.db.insert(userOnboarding).values({ userId: localUserId }).onConflictDoNothing();
    } catch (err) {
      this.opts.logger.warn(
        { err, localUserId },
        'onboarding first-login insert failed — retry-safe (the welcome stays owed), login unaffected'
      );
    }
  }

  /**
   * Verify a hub-minted exchange JWT (`POST /sso/cli-connect`, the H3
   * counterpart — internal/federation.md P5) and extract its assertion. The
   * chain, every link fail-closed:
   *
   *  1. `HubJwtVerifier.verify` — hub JWKS signature, `iss` pinned to the
   *     hub, `aud` pinned to OUR resource URL (a token minted for another
   *     tool dies here; a tool-minted MCP token dies on `iss`),
   *     RS256 allowlist, expiry (5 s tolerance).
   *  2. `exp` REQUIRED — jose only validates expiry when the claim exists,
   *     and the replay ledger needs a bound; a token without one is a
   *     contract break, refused.
   *  3. `purpose === 'sso-connect'` REQUIRED — a hub ACCESS token carries
   *     no purpose claim and dies here even if iss/aud ever matched.
   *  4. `jti` REQUIRED (bounded) — the caller consumes it one-time-use.
   *
   * The token's TRANSITIONAL org claims (workspace_id/role/workspace_name,
   * kept by the hub through the compat window) are deliberately NOT read —
   * org truth comes from the connect-time reconcile, never a claim.
   *
   * Throws on any failure; the route maps every throw to one uniform 401
   * (no oracle distinguishing replay from expiry from a foreign audience).
   */
  async verifyConnectToken(token: string): Promise<HubConnectAssertion> {
    const claims = await this.verifier.verify(token, this.opts.resourceUrl);
    if (typeof claims.exp !== 'number') throw new Error('exchange token carries no exp');
    if (claims.purpose !== 'sso-connect') {
      throw new Error('token is not an sso-connect exchange token (purpose claim)');
    }
    const jti = claims.jti;
    if (typeof jti !== 'string' || !jti || jti.length > 256) {
      throw new Error('exchange token carries no usable jti');
    }
    const sub = claims.sub;
    if (typeof sub !== 'string' || !sub) throw new Error('exchange token carries no sub');
    const email = claims.email;
    if (typeof email !== 'string' || !email.includes('@')) {
      throw new Error('exchange token carries no usable email claim');
    }
    const normalizedEmail = email.toLowerCase();
    return {
      sub,
      email: normalizedEmail,
      // The hub mints exchange tokens only for a live, authenticated hub
      // user — an identity whose email the hub itself verified (H3 re-reads
      // emailVerified LIVE at mint). The H3 contract carries no
      // email_verified or name claim, so the honest mirror of the SSO
      // id_token's `email_verified: true` is asserted here, and the display
      // name falls back exactly like an SSO login with a blank profile name.
      emailVerified: true,
      name: normalizedEmail.split('@')[0]!,
      jti,
      expiresAt: new Date(claims.exp * 1000)
    };
  }

  /**
   * JIT-provision for `/sso/cli-connect`: resolve-or-create the local user
   * for a VERIFIED connect assertion, then run the USER half of the
   * per-login work — identity guard, D10 email sync. NO org projection
   * happens here: the route stores the H3 grant (`acquireFromConnect`) and
   * runs the same fail-closed reconcile as a browser login — the reconcile
   * IS the projection, on the connect path too. User resolution mirrors
   * better-auth's own OAuth linking exactly (oauth2/link-account.mjs on the
   * pinned 1.6.15):
   *
   *  1. account row (providerId='antasphere', accountId=sub) → that user;
   *  2. else a local user holding the asserted email → TRUSTED LINK (D9),
   *     but only onto a VERIFIED local email (requireLocalEmailVerified —
   *     an attacker-parked unverified account can never be taken over);
   *  3. else create user + account through the internal adapter's
   *     `createOAuthUser` — the genericOAuth JIT call, so the
   *     databaseHooks.user.create.after seam (`user.created` → collaborator
   *     grant sweep) fires exactly as it would for a browser SSO signup.
   *
   * Two concurrent first-connects race the create; the loser's unique-email
   * violation is caught and resolved by re-running the lookup (the Phase 5
   * duplicate-account lesson).
   */
  async provisionConnect(
    auth: ConnectAuthSeam,
    assertion: HubConnectAssertion
  ): Promise<{ user: { id: string; email: string; name: string } }> {
    let userId = await this.resolveConnectUser(auth, assertion, true);
    if (userId === null) {
      // Lost the create race: the winner's rows are committed now (the
      // adapter's transaction passthrough) — one retry must resolve.
      userId = await this.resolveConnectUser(auth, assertion, false);
      if (userId === null) {
        throw new HubSsoLoginError('sso_login_failed', 'user provisioning raced and re-lookup failed');
      }
    }
    await this.guardSingleHubIdentity(userId, assertion.sub);
    await this.syncEmail(userId, assertion);
    // Re-read AFTER the D10 sync may have just rewritten the email; the
    // response must carry what the database now holds.
    const [row] = await this.opts.db
      .select({ id: userTable.id, email: userTable.email, name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    if (!row) throw new HubSsoLoginError('sso_login_failed', 'user row missing after provisioning');
    return { user: row };
  }

  /**
   * The connect path's fail-closed projection pass: one forced reconcile
   * reading the user's org list AS THE USER with their freshly stored (or
   * pre-existing) grant. Returns the pass's own outcome — the route mints a
   * key ONLY on 'ok' (never a born-dead key).
   */
  async reconcileConnect(localUserId: string): Promise<ReconcilePassOutcome> {
    if (!this.reconciler) {
      // Boot always binds on cloud; a missing binding is a wiring bug and
      // must refuse the connect, never mint an unprojected key.
      throw new HubSsoLoginError('sso_projection_failed', 'no login reconciler bound (boot wiring bug)');
    }
    return this.reconciler.forceReconcile(localUserId);
  }

  /**
   * One resolution pass (see provisionConnect). Returns the local user id,
   * or null when `mayCreate` and the create lost a uniqueness race —
   * signalling the caller to re-run with the winner's rows visible.
   */
  private async resolveConnectUser(
    auth: ConnectAuthSeam,
    assertion: HubConnectAssertion,
    mayCreate: boolean
  ): Promise<string | null> {
    const db = this.opts.db;
    const [linked] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, HUB_SSO_PROVIDER_ID), eq(account.accountId, assertion.sub)))
      .limit(1);
    if (linked) return linked.userId;

    const [existing] = await db
      .select({ id: userTable.id, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, assertion.email))
      .limit(1);
    const authCtx = await auth.$context;
    if (existing) {
      if (!existing.emailVerified) {
        // requireLocalEmailVerified, mirrored: linking a trusted provider
        // onto an UNVERIFIED local account is the classic pre-registration
        // takeover — refuse, exactly like the browser SSO path does.
        throw new HubSsoLoginError(
          'sso_link_refused',
          'a local account holds this email but its address is unverified — refusing the trusted link'
        );
      }
      await authCtx.internalAdapter.linkAccount({
        providerId: HUB_SSO_PROVIDER_ID,
        accountId: assertion.sub,
        userId: existing.id
      });
      return existing.id;
    }
    if (!mayCreate) return null;
    try {
      const created = await authCtx.internalAdapter.createOAuthUser(
        { email: assertion.email, name: assertion.name, emailVerified: assertion.emailVerified },
        { providerId: HUB_SSO_PROVIDER_ID, accountId: assertion.sub }
      );
      return created.user.id;
    } catch (err) {
      // The only expected failure is the unique-email (or duplicate-link)
      // violation from a concurrent first-connect — resolvable by retry.
      this.opts.logger.warn({ err }, 'sso cli-connect: JIT create raced — retrying resolution');
      return null;
    }
  }

  /**
   * A local user may hold AT MOST ONE hub identity. The dangerous path:
   * hub user B's email was changed (hub-side, verified there) to an address
   * some local user A still carries because A's projection is stale — B's
   * first login then finds no account row, matches A by email, and the D9
   * trusted link merges B onto A's local user (and A's resources). Detect the
   * second `antasphere` accountId, DELETE the NEWEST link row, and fail the
   * login. The conflict clears when A next logs in (their email re-syncs
   * away) or an operator intervenes.
   *
   * The undo keys on RECENCY, not on the current login's `sub`. On the
   * normal conflict they are the same row (the trusted link just inserted
   * it). They differ only in residue states where TWO rows pre-exist — a
   * crash between better-auth's link and this hook, or a second identity
   * linked via the explicit /oauth2/link flow (which mints no session, so
   * this guard never saw it). Deleting the current-sub row there would let
   * the ESTABLISHED identity's own login destroy itself (and two
   * concurrent conflicting logins destroy BOTH rows, stranding the user);
   * the newest row is always the intruding link, never the long-standing
   * identity, so the user self-heals on retry.
   */
  private async guardSingleHubIdentity(localUserId: string, sub: string): Promise<void> {
    const rows = await this.opts.db
      .select({ accountId: account.accountId, createdAt: account.createdAt })
      .from(account)
      .where(and(eq(account.userId, localUserId), eq(account.providerId, HUB_SSO_PROVIDER_ID)));
    if (!rows.some((r) => r.accountId !== sub)) return;
    const newest = [...rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.accountId.localeCompare(a.accountId)
    )[0]!;
    await this.opts.db
      .delete(account)
      .where(
        and(
          eq(account.userId, localUserId),
          eq(account.providerId, HUB_SSO_PROVIDER_ID),
          eq(account.accountId, newest.accountId)
        )
      );
    throw new HubSsoLoginError(
      'sso_identity_conflict',
      `hub subject ${sub} maps to a local user already linked to a different hub subject — newest link undone`
    );
  }

  /**
   * D10: the hub is the identity source on cloud, so the local email FOLLOWS
   * the (verified) hub email at every login — email-keyed features (the
   * collaborator grant sweep) must see the current address. A collision with
   * another local user's email fails the login cleanly; the unique
   * constraint on user.email backstops the read-then-write race.
   */
  private async syncEmail(localUserId: string, assertion: HubSsoAssertion): Promise<void> {
    const email = assertion.email.toLowerCase();
    const [row] = await this.opts.db
      .select({ email: userTable.email, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.id, localUserId))
      .limit(1);
    if (!row) throw new HubSsoLoginError('sso_login_failed', 'user row missing after callback');
    const emailChanged = row.email !== email;
    // For an UNCHANGED address, emailVerified is a LATCH: once this instance
    // holds the address as verified, a weaker hub assertion never flips it
    // back — break-glass (api/break-glass.ts) refuses unverified users, so a
    // downward sync could close the operator door if the hub's posture ever
    // allowed an unverified login. A CHANGED address takes the hub's
    // asserted state honestly (the new mailbox is unproven). Mirrors
    // better-auth's own overrideUserInfo semantics.
    const emailVerified = emailChanged
      ? assertion.emailVerified
      : row.emailVerified || assertion.emailVerified;
    if (!emailChanged && row.emailVerified === emailVerified) return;
    if (emailChanged) {
      const [holder] = await this.opts.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(and(eq(userTable.email, email), ne(userTable.id, localUserId)))
        .limit(1);
      if (holder) {
        throw new HubSsoLoginError(
          'sso_email_conflict',
          `hub-asserted email is already held by another local user — refusing to sync`
        );
      }
    }
    try {
      await this.opts.db
        .update(userTable)
        .set({ email, emailVerified, updatedAt: new Date() })
        .where(eq(userTable.id, localUserId));
    } catch {
      // Concurrent claim of the same address between check and write.
      throw new HubSsoLoginError('sso_email_conflict', 'email sync lost a uniqueness race');
    }
  }
}

/** The SSO-login user assertion, from the VERIFIED id_token ONLY. */
function buildUserAssertion(idClaims: JWTPayload): HubSsoAssertion {
  const sub = idClaims.sub;
  if (typeof sub !== 'string' || !sub) throw new Error('id_token carries no sub');
  const email = idClaims.email;
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new Error('id_token carries no usable email claim');
  }
  const normalizedEmail = email.toLowerCase();
  const rawName = idClaims.name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName : normalizedEmail.split('@')[0]!;
  return {
    sub,
    email: normalizedEmail,
    emailVerified: idClaims.email_verified === true,
    name
  };
}
