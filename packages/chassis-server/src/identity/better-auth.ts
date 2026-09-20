import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, genericOAuth, jwt, twoFactor } from 'better-auth/plugins';
import { deleteSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';
import { oauthProvider } from '@better-auth/oauth-provider';
import { and, eq } from 'drizzle-orm';
import {
  account,
  instanceSettings,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
  workspaceMembers,
  type Db
} from '@antasphere/chassis-db';
import type { Env } from '../env.js';
import { HUB_SSO_PROVIDER_ID, HubSsoLoginError, type HubSsoService } from './hub-sso.js';
import { parseSuperadminEmails } from '../accounts/superadmin.js';
// Types only, erased at emit: this package EMITS DECLARATIONS (the app bundled
// the file and never did), and `Auth = ReturnType<typeof createAuth>` is an
// inferred type that names these two modules. TypeScript can only spell a
// module it has resolved in this program (TS2742 otherwise), so they are
// resolved here. Nothing is imported at run time.
import type {} from '@better-auth/core/db/adapter';
import type {} from 'better-call';

/**
 * The only file that touches better-auth's constructor. Everything else goes
 * through the identity module's exports or the IdentityProvider seam, so a
 * Better Auth upgrade (or replacement) stays contained.
 *
 * Password login is the self-host default (no SMTP dependency). Email OTP
 * auto-enables when an email driver is configured; Google when client
 * credentials are set. The twoFactor plugin offers OPT-IN per-user TOTP +
 * backup codes (ADR 009) — password and email-OTP sign-ins by an enrolled
 * user require the second factor; machine credentials never see one. The
 * jwt + oauthProvider plugins make every instance an OAuth 2.1 authorization
 * server for its own bundled /mcp endpoint (M6): RS256 access JWTs (15 min),
 * rotating refresh tokens, PKCE + dynamic client registration, issuance
 * gated on a LIVE active workspace membership.
 */
/** Credential events audited on Better-Auth-native routes. */
export type AccountEvent =
  | 'password_reset'
  | 'password_change'
  | 'email_change_request'
  | 'email_change'
  | 'two_factor_enroll'
  | 'two_factor_disable';

export interface CreateAuthOptions {
  db: Db;
  env: Pick<
    Env,
    | 'PUBLIC_BASE_URL'
    | 'GOOGLE_CLIENT_ID'
    | 'GOOGLE_CLIENT_SECRET'
    | 'OAUTH_DYNAMIC_CLIENT_REGISTRATION'
    | 'SUPERADMIN_EMAILS'
  >;
  authSecret: string;
  /**
   * The tool's OAuth scope list, in the ORDER it is published (discovery
   * `scopes_supported`, the consent screen, client registration defaults).
   * The chassis spells no scope name: the tool defines the list and hands it
   * in; the well-known documents read the same array from the tool.
   */
  oauthScopes: readonly string[];
  /**
   * Origins that are NEVER trusted, serving origin or not (PRDCT-1352): each
   * is filtered out of `trustedOrigins` and refused outright by the sign-in
   * Origin lock. Empty = nothing installed. A tool with a viewer passes its
   * viewer origin (author-controlled script runs there).
   */
  untrustedOrigins: readonly string[];
  /** When provided (an email driver delivers), the email-OTP login auto-enables. */
  sendOtp?: (params: { email: string; otp: string; type: string }) => Promise<void>;
  /**
   * When provided (an email driver delivers), self-serve password reset
   * auto-enables — POST /request-password-reset mails a link. Without it that
   * endpoint stays closed (400) and only the admin-generated reset link works.
   * On EDITION=cloud it is IGNORED: the whole reset surface refuses there
   * (D1 hub-only posture — see isPasswordResetPath and the before-hook).
   */
  sendResetPassword?: (params: { email: string; url: string; token: string }) => Promise<void>;
  /**
   * Confirmation mail to the OLD address when a VERIFIED user requests an
   * email change (the two-leg flow). Unverified users — the template's common
   * case — skip straight to the verification mail below.
   */
  sendChangeEmailConfirmation?: (params: {
    email: string;
    newEmail: string;
    url: string;
    token: string;
  }) => Promise<void>;
  /**
   * Verification mail to the NEW address — the final leg of every self-serve
   * email change. When provided (an email driver delivers), POST /change-email
   * opens; without it the endpoint answers 400 BEFORE any email lookup (no
   * enumeration oracle) and only the admin-generated change link works.
   */
  sendVerificationEmail?: (params: { email: string; url: string; token: string }) => Promise<void>;
  /**
   * Audit hook for credential events on Better-Auth-native routes (which
   * bypass the /api/v1 audit middleware). Fired best-effort by the caller.
   */
  onAccountEvent?: (event: AccountEvent, userId: string) => Promise<void>;
  /**
   * Fired from Better Auth's databaseHooks.user.create.after — the ONE seam
   * every account entrance passes through (setup, invitation accept, the
   * collaborator claim endpoint, any future SSO JIT), so a `user.created`
   * event is trustworthy by construction instead of depending on each call
   * site remembering to emit. Boot wires this to the platform event bus.
   */
  onUserCreated?: (user: { id: string; email: string }) => void;
  /**
   * Self-service account deletion guard, run by POST /delete-user BEFORE the
   * row cascade. Boot wires the AccountDeletionService here and translates
   * LastOwnerError into an APIError('BAD_REQUEST') so the route answers 400.
   */
  beforeUserDelete?: (userId: string) => Promise<void>;
  /** Completion hook, run AFTER the cascade (the audit row's system actor). */
  afterUserDelete?: (user: { id: string; email: string }) => Promise<void>;
  /**
   * The cloud edition's hub SSO binding (internal/federation.md, ADR 015).
   * Present ONLY when the instance boots EDITION=cloud: registers the
   * `antasphere` genericOAuth relying party, the D9 trusted-link config,
   * and the per-login callback after-hook (JIT projection + re-sync). An
   * oss boot passes nothing and carries zero SSO surface at runtime.
   */
  hubSso?: HubSsoService | undefined;
}

export const AUTH_BASE_PATH = '/api/v1/auth';

/**
 * The canonical OAuth resource identifier (JWT `aud`, RFC 8707) — the bundled
 * MCP endpoint. Derived from PUBLIC_BASE_URL at boot, never from its own env
 * var: AS and resource live on one origin, so the byte-identical-URL footgun
 * of the split dashboard+MCP deployment cannot exist here.
 */
export function mcpResourceUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '') + '/mcp';
}

export type Auth = ReturnType<typeof createAuth>;

/** Metadata URI fields a registering client may present to users (RFC 7591). */
const CLIENT_METADATA_URI_FIELDS = ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri'] as const;

/**
 * Every Better Auth route that can SET or RESET a local password with no
 * current-password proof, enumerated against the pinned 1.6.22 surface
 * (re-enumerated on the 1.6.15 → 1.6.22 bump, 2026-08-29, ADR 001; the
 * dist-wide createAuthEndpoint path+method diff was one added route in the
 * unregistered oauth-popup plugin, nothing removed)
 * (re-verify on ANY Better Auth bump):
 *
 *  - core emailAndPassword: POST /request-password-reset,
 *    POST /reset-password, GET /reset-password/:token (the mailed callback);
 *  - emailOTP plugin (active whenever a mailer delivers):
 *    POST /email-otp/request-password-reset, POST /email-otp/reset-password,
 *    and the deprecated POST /forget-password/email-otp alias;
 *  - core /set-password (the passwordless-ADD route): included as bump
 *    insurance. In 1.6.22 its endpoint is `createAuthEndpoint.serverOnly`;
 *    in 1.6.15 it was registered PATHLESS
 *    (update-user.mjs — `createAuthEndpoint({ method, body, use })` with no
 *    path arg), so better-call's router SKIPS it (`!endpoint.path` →
 *    `continue`, router.mjs) and it is unreachable over HTTP today — the one
 *    route that could otherwise let a passwordless hub-JIT user ADD a
 *    credential and then /sign-in/email. A future bump could give it a path;
 *    a security allowlist must not depend on that accident, so guard it now
 *    (denying an unreachable path is a no-op until it isn't).
 *
 * Ruled OUT of this predicate on purpose, against the same 1.6.22 surface:
 *  - /change-password proves the CURRENT password AND requires an existing
 *    credential account (CREDENTIAL_ACCOUNT_NOT_FOUND otherwise), so a
 *    hub-JIT user — who has neither — cannot set a password through it;
 *  - admin /admin/set-user-password and the phoneNumber reset routes live in
 *    the admin / phoneNumber plugins, neither of which this instance
 *    registers (only genericOAuth, emailOTP, twoFactor, jwt, oauthProvider),
 *    so they are never mounted;
 *  - /sign-up/email is closed by the sign-up switches + the before-hook.
 *
 * On EDITION=cloud these are the SSO-bypass entrance the D1 hub-only posture
 * closes (internal/federation.md, ADR 017): a hub-JIT user (no credential
 * account) could otherwise mail themselves a reset, SET a local password,
 * and mint sessions via /sign-in/email that skip the per-login hub re-sync.
 * P4's re-assertion still gates every such session, so this is posture, not
 * an attacker hole — but the entrance must not exist. /sign-in/email itself
 * stays wired (the break-glass operator door).
 * `ctx.path` here is the ROUTE PATTERN (e.g. '/reset-password/:token'), so
 * prefix matching covers the tokened callback.
 */
function isPasswordResetPath(path: string): boolean {
  return (
    path.startsWith('/request-password-reset') ||
    path.startsWith('/reset-password') ||
    path.startsWith('/forget-password') ||
    path.startsWith('/email-otp/request-password-reset') ||
    path.startsWith('/email-otp/reset-password') ||
    path.startsWith('/set-password')
  );
}

/**
 * Every emailOTP route that can MINT A SESSION from an emailed code — or
 * mail such a code — enumerated against the pinned 1.6.22 surface
 * (re-enumerated on the 1.6.15 → 1.6.22 bump, 2026-08-29: the plugin's nine
 * routes are byte-identical in path and method)
 * (plugins/email-otp/routes.mjs; re-verify on ANY Better Auth bump):
 *
 *  - POST /sign-in/email-otp: the sign-in mint — verifies the code, then
 *    UNCONDITIONALLY createSession + setSessionCookie;
 *  - POST /email-otp/verify-email: flips emailVerified, and mints a session
 *    ONLY under emailVerification.autoSignInAfterVerification — UNSET on
 *    this instance, so it mints nothing today. Guarded as config insurance
 *    (the same stance as /set-password in isPasswordResetPath): a future
 *    config change must not silently open an SSO-bypassing session mint,
 *    and no client of this instance calls the route (the email-change
 *    landing is the core tokened GET /verify-email, untouched);
 *  - POST /email-otp/send-verification-otp: the mail leg. With this close,
 *    EVERY redemption route for every OTP type refuses on cloud (sign-in +
 *    verify-email here, the reset trio in isPasswordResetPath), so a sent
 *    code could only ever be a dead letter — refuse the send rather than
 *    mail codes that cannot work.
 *
 * Ruled OUT on purpose, against the same 1.6.22 surface:
 *  - POST /email-otp/check-verification-otp verifies WITHOUT consuming and
 *    mints nothing (no createSession in its handler); with the send leg
 *    closed there is nothing to check anyway;
 *  - POST /email-otp/request-email-change + POST /email-otp/change-email
 *    (the plugin's two remaining routes, unchanged at 1.6.22): both run behind
 *    sensitiveSessionMiddleware — an EXISTING fresh session is their entry
 *    condition, so neither is a session ENTRANCE (change-email's
 *    setSessionCookie only re-sets the cookie of the session it already
 *    required) — and both answer 400 unless the plugin option
 *    `changeEmail.enabled` is set, which this instance never sets (the
 *    core tokened /change-email flow is the email-change surface; on cloud
 *    it is hidden and D10 re-syncs email from the hub anyway). If
 *    changeEmail is ever enabled, re-rule them here;
 *  - createVerificationOTP / getVerificationOTP are registered PATHLESS in
 *    1.6.15 and `createAuthEndpoint.serverOnly` in 1.6.22 (routes.mjs), so
 *    better-call's router skips them: server-side only, unreachable over
 *    HTTP (same accident /set-password documents — do not rely on it);
 *  - /sign-in/email-otp is the plugin's ONLY /sign-in/* route; the twoFactor
 *    plugin mints only from a pending first factor, magic-link/phone are not
 *    registered here.
 *
 * On EDITION=cloud this pair is the last non-SSO HUMAN session entrance
 * under the D1 hub-only posture (the reset surface closed at P8; ADR 017 §7
 * recorded the OTP sign-in KNOWN-OPEN pending a charter call — now taken):
 * every cloud credential must trace through "Sign in with Antasphere" so
 * the hub's audit log is the complete access record. P4's re-assertion
 * already gated every OTP session, so this is posture, not an attacker
 * hole. The CLI counterpart (/cli/auth/*) closes in api/cli-auth.ts;
 * /sign-in/email stays wired (the break-glass operator door, which the
 * string '/sign-in/email-otp' does not prefix-match); oss keeps the full
 * OTP login unchanged.
 */
function isOtpSignInPath(path: string): boolean {
  return (
    path.startsWith('/sign-in/email-otp') ||
    path.startsWith('/email-otp/verify-email') ||
    path.startsWith('/email-otp/send-verification-otp')
  );
}

/**
 * The two Better Auth core routes that hand a caller the PROVIDER GRANT
 * stored on their own `account` row, in PLAINTEXT (PRDCT-1354, findings
 * AUTH-3 + AUTH-7; better-auth 1.6.22 `api/routes/account.mjs` (both routes
 * present unchanged at the 1.6.15 → 1.6.22 bump, 2026-08-29) — re-verify
 * the enumeration on ANY bump):
 *
 *  - POST /get-access-token → `{ accessToken, idToken, accessTokenExpiresAt,
 *    scopes }`, refreshing first when the stored token is within 5 s of
 *    expiry;
 *  - POST /refresh-token → the same PLUS `refreshToken`, and it ALWAYS
 *    refreshes.
 *
 * Both are closed here, on BOTH editions, because both are pure subtraction:
 * nothing in this repo, the SDK, the CLI, the dashboard, or the MCP server
 * calls either one (grep `get-access-token` / `refresh-token`), and no
 * server-side caller exists either — the hub grant's own refresh is
 * `HubGrantService.postRefresh`, which posts to the hub's token endpoint
 * directly and never goes through this route. The plugin-owned OAuth
 * endpoints this instance DOES serve (`/oauth2/token`, `/oauth2/authorize`,
 * …) are separate paths and untouched.
 *
 * Why they must not exist, even though `resolveUserId` requires a session
 * for any HTTP caller (so they are not a cross-USER surface):
 *
 *  1. The `/auth/*` mount is registered BEFORE `authContext`
 *     (`api/index.ts`), so neither route sees the fail-closed scope
 *     allowlist, the per-principal quota, the idempotency claim, or the
 *     audit middleware. Any session-bearing caller — including a browser
 *     tricked into a same-site POST, or anything that reaches the cookie —
 *     reads the grant with no record left behind, which defeats the whole
 *     point of `encryptOAuthTokens: true` (encryption at rest is worthless
 *     next to an unlogged plaintext read endpoint).
 *  2. On cloud the grant in question is the HUB grant, i.e. the credential
 *     the user-scoped federation is built on (ADR 019). Handing it out in
 *     plaintext hands out the ability to read that user's hub orgs directly.
 *  3. `/refresh-token` additionally ROTATES that grant OUTSIDE the
 *     `pg_advisory_lock(7432004, hashtext(userId))` single-flight ADR 019
 *     requires. The hub's RFC 9700 reuse detection makes an unserialized
 *     double-refresh a grant-family-KILLING event, so this route is a
 *     denial-of-service any logged-in user can trigger from a browser tab.
 *     (The hub-side half of that hardening is PRDCT-1370.)
 *
 * `ctx.path` is the route pattern, and neither route has path params, so an
 * exact match is enough; startsWith would also swallow future siblings, but
 * an allowlist-shaped closure should deny exactly what it has verified.
 */
function isProviderGrantPath(path: string): boolean {
  return path === '/get-access-token' || path === '/refresh-token';
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Better Auth `trustedOrigins` (PRDCT-1352): the configured public origin plus
 * the origin the request was served on (localhost, previews, any domain behind
 * a TLS-terminating proxy) — MINUS the viewer origin, which is author-
 * controlled script's origin and is never trusted, serving origin or
 * not. The host gate keeps the auth surface off that hostname; this is the
 * second lock behind it. Exported pure so a unit test can pin the exclusion.
 */
export function trustedOriginsFor(
  publicBaseUrl: string,
  untrustedOrigins: readonly string[]
): (request?: Request) => string[] {
  return (request) => {
    const origins = [publicBaseUrl];
    try {
      if (request) origins.push(new URL(request.url).origin);
    } catch {
      // unparseable request URL — explicit origin only
    }
    return untrustedOrigins.length > 0
      ? origins.filter((origin) => !untrustedOrigins.includes(origin))
      : origins;
  };
}

/**
 * The sign-in Origin lock (M9 login-CSRF hardening + PRDCT-1352): a sign-in
 * that presents an Origin must present a trusted one — the serving origin or
 * Better Auth's own trusted list — and the viewer origin is refused OUTRIGHT,
 * even as the serving origin: author script must never mint a session on the
 * hostname it runs on. Exported pure so a unit test can pin both arms.
 */
export function signInOriginRefused(input: {
  origin: string;
  servingOrigin: string | null;
  untrustedOrigins: readonly string[];
  isTrustedOrigin: (origin: string) => boolean;
}): boolean {
  const { origin, servingOrigin, untrustedOrigins, isTrustedOrigin } = input;
  if (untrustedOrigins.includes(origin)) return true;
  return origin !== servingOrigin && !isTrustedOrigin(origin);
}

export function createAuth({
  db,
  env,
  authSecret,
  oauthScopes,
  untrustedOrigins,
  sendOtp,
  sendResetPassword,
  sendChangeEmailConfirmation,
  sendVerificationEmail,
  onAccountEvent,
  onUserCreated,
  beforeUserDelete,
  afterUserDelete,
  hubSso
}: CreateAuthOptions) {
  const isHttps = env.PUBLIC_BASE_URL.startsWith('https://');
  const resource = mcpResourceUrl(env.PUBLIC_BASE_URL);

  /**
   * Cloud only: may this email take the local password door? The setup
   * operator (instance_settings.operator_user_id — the durable record,
   * CLOUD-3) and the SUPERADMIN_EMAILS allowlist; nobody else.
   */
  const isLocalSignInAllowed = async (email: string): Promise<boolean> => {
    if (parseSuperadminEmails(env.SUPERADMIN_EMAILS).has(email)) return true;
    const [row] = await db
      .select({ email: user.email })
      .from(instanceSettings)
      .innerJoin(user, eq(user.id, instanceSettings.operatorUserId))
      .limit(1);
    return row?.email?.toLowerCase() === email;
  };

  /**
   * The JWT issuance gate (user-scoped credential model): a grant is the
   * USER — "consent to act as you" — so issuance requires only that the
   * user holds AT LEAST ONE live active membership on this instance, and
   * the minted claims carry NO workspace. The request-time workspace comes
   * from the X-Workspace-Id selector against the user's live memberships
   * (identity/oauth-jwt.ts); a claim could only ever go stale against that.
   *
   * Runs on the authorization_code AND refresh_token grants; throwing
   * aborts issuance with an RFC 6749 error body. It is NOT what revokes a
   * deactivated member's access, though: a refresh without the RFC 8707
   * `resource` param still mints an OPAQUE token that never passes through
   * here. The real enforcement is resource-side — every request re-checks
   * the live membership (and an opaque token fails the bearer gate's
   * looksLikeJwt outright), so whatever a refresh mints is rejected at
   * every resource. Verified live (M9).
   */
  async function userAccessClaims(user: { id: string; email: string } | null | undefined) {
    if (!user?.id) {
      throw new APIError('FORBIDDEN', {
        error: 'access_denied',
        error_description: 'Token issuance requires a user-bound grant'
      });
    }
    const [row] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.isActive, true)))
      .limit(1);
    if (!row) {
      throw new APIError('FORBIDDEN', {
        error: 'access_denied',
        error_description: 'This account has no active membership on this instance'
      });
    }
    return { email: user.email };
  }

  return betterAuth({
    plugins: [
      // Cloud edition only (hubSso is constructed iff EDITION=cloud): the
      // "Sign in with Antasphere" relying party. `disableSignUp` is
      // DELIBERATELY unset on this provider — hub SSO is the sanctioned
      // account entrance on cloud, the conscious FOURTH switch next to the
      // three closed-signup switches (internal/federation.md). Discovery, token
      // exchange (with RFC 8707 `resource`), and token verification all
      // live in the provider config hub-sso.ts builds.
      ...(hubSso ? [genericOAuth({ config: [hubSso.providerConfig()] })] : []),
      ...(sendOtp
        ? [
            emailOTP({
              // Closed instance: OTP signs in EXISTING accounts only — without
              // this, an OTP send to any unknown email would mint a user.
              disableSignUp: true,
              async sendVerificationOTP({ email, otp, type }) {
                await sendOtp({ email, otp, type });
              }
            })
          ]
        : []),
      // Optional per-user 2FA: TOTP + one-time backup codes (ADR 009). NO
      // otpOptions.sendOTP — an emailed code as "second factor" would collapse
      // into the first factor for anyone who controls the mailbox. Enrollment
      // is password-gated and pending until the user proves a working
      // authenticator by verifying one TOTP code; disable is password-gated.
      // Sign-up stays closed: the plugin adds no account-creating route.
      twoFactor({
        // Label shown in authenticator apps — the instance's own host.
        issuer: new URL(env.PUBLIC_BASE_URL).host
      }),
      jwt({
        // JWTs exist ONLY as OAuth access tokens — never attach a signed JWT
        // to plain session responses (recommended with an oauth provider).
        disableSettingJwtHeader: true,
        // RS256 over the default EdDSA: broadest verifier compatibility.
        jwks: { keyPairConfig: { alg: 'RS256' } },
        // Clean origin (no /api/v1/auth path) as the OAuth issuer — the exact
        // `iss` oauth-jwt.ts pins, and the root of the RFC 8414 discovery
        // documents re-served by routes/wellknown.ts.
        jwt: { issuer: env.PUBLIC_BASE_URL }
      }),
      oauthProvider({
        // SPA routes; the API-side validation is Better Auth's signed query.
        loginPage: '/login',
        consentPage: '/oauth/consent',
        scopes: [...oauthScopes],
        // `resource` (RFC 8707) must be the bundled MCP endpoint — its exact `aud`.
        validAudiences: [resource],
        // No M2M clients: every token is bound to a consenting user.
        grantTypes: ['authorization_code', 'refresh_token'],
        // MCP clients (claude.ai, Claude Desktop) register themselves via
        // RFC 7591 without a session. Registration alone grants nothing —
        // tokens still require login + consent + an active membership — and
        // the register endpoint is rate-limited in api/index.ts.
        //
        // PLT-29: it is still an anonymous write to the authorization server's
        // client table, so an operator gets a switch rather than a hardcoded
        // posture. OAUTH_DYNAMIC_CLIENT_REGISTRATION=false turns BOTH flags
        // off and /oauth2/register refuses everyone.
        //
        // THE DEFAULT IS DELIBERATELY UNCHANGED (true): the MCP connector
        // story depends on open registration, and the fleet-wide decision on
        // whether that posture should change belongs to the OIDC audit, not to
        // this hardening pass. This adds the control and nothing else.
        allowDynamicClientRegistration: env.OAUTH_DYNAMIC_CLIENT_REGISTRATION,
        allowUnauthenticatedClientRegistration: env.OAUTH_DYNAMIC_CLIENT_REGISTRATION,
        clientRegistrationDefaultScopes: [...oauthScopes],
        clientRegistrationAllowedScopes: [...oauthScopes],
        // Short access tokens: stateless JWTs can't be revoked, so revocation
        // latency == remaining lifetime. Refresh tokens rotate (reuse detected).
        accessTokenExpiresIn: 900, // 15 min
        refreshTokenExpiresIn: 60 * 60 * 24 * 365, // 365 days (sliding; see the session note)
        customAccessTokenClaims: async ({ user }) => userAccessClaims(user),
        // Grants are user-scoped ("act as you"): consents bind NOTHING —
        // the explicit `undefined` referenceId is the no-binding wiring
        // (the plugin type requires the key whenever postLogin exists).
        // `page` + `shouldRedirect` are required by the type too; the
        // constant false keeps the flow on the consent page itself.
        postLogin: {
          page: '/oauth/consent',
          shouldRedirect: () => false,
          consentReferenceId: async () => undefined
        },
        // Root discovery documents are re-served by routes/wellknown.ts.
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true }
      })
    ],
    // Google social sign-in is a SELF-HOST option only. On EDITION=cloud
    // (hubSso present) the provider is NOT registered at all — even with
    // GOOGLE_CLIENT_ID/SECRET set — so /sign-in/social and
    // /oauth2/callback/google mint nothing there. Under the D1 hub-only
    // posture the sole sanctioned human entrance is "Sign in with
    // Antasphere" (the `antasphere` genericOAuth provider), with
    // /sign-in/email kept as the deliberate break-glass door; a live Google
    // provider would be a NON-hub session entrance that defeats the
    // audit-completeness guarantee (every cloud login must trace through the
    // hub). Gating on !hubSso — not on "operator didn't set the env var" —
    // makes the guarantee hold by construction (defense in depth against
    // misconfiguration), mirroring the OTP closures. oss is unchanged: with
    // the credentials set, Google signs in accounts that already exist
    // (disableSignUp — the callback never creates), one of the three
    // closed-signup switches.
    socialProviders:
      !hubSso && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              disableSignUp: true
            }
          }
        : {},
    account: {
      // OAuth provider tokens on the `account` row are encrypted at rest —
      // on cloud that row IS the user's hub grant (offline_access refresh
      // token, identity/hub-grant.ts), which must never sit plaintext in a
      // dump. Enabled on BOTH editions (oss: Google tokens, when
      // configured). CONFIG-ONLY: no schema change (drift:check proves),
      // and retroactively safe — the decrypt passes legacy PLAINTEXT values
      // through untouched (dist/oauth2/utils.mjs isLikelyEncrypted, verified
      // on 1.6.15 and again on 1.6.22;
      // hub-grant.ts mirrors the same rule). The key is the auth context's
      // secretConfig (= this instance's AUTH_SECRET under our string-secret
      // config). Re-verify both facts on any Better Auth bump.
      encryptOAuthTokens: true,
      // D9 (cloud only): the hub is a TRUSTED provider — its verified email
      // assertion may link onto an existing local account of the same
      // address (the setup operator's entrance under hub-only login).
      // Keeping requireLocalEmailVerified true (stated, not defaulted)
      // means a parked UNVERIFIED local account can never be taken over via
      // SSO; the cloud setup flow mints the operator emailVerified=true for
      // exactly this reason (internal/federation.md, pinned by edition tests).
      ...(hubSso
        ? {
            accountLinking: {
              trustedProviders: [HUB_SSO_PROVIDER_ID],
              requireLocalEmailVerified: true
            }
          }
        : {})
    },
    baseURL: env.PUBLIC_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: authSecret,
    // Cloud only: OAuth-callback error redirects land on the LOGIN PAGE.
    // Verified on 1.6.15 and 1.6.22 (re-verify on ANY bump): the genericOAuth callback
    // resolves `onAPIError.errorURL || <authBase>/error` and redirects an
    // AS error (`?error=login_required` from a prompt=none authorize,
    // `?error=access_denied`, …) there BEFORE parseState runs
    // (generic-oauth/routes.mjs) — errorCallbackURL never sees these, so
    // without this the silent-connect bounce would dead-end on better-auth's
    // own /error page. The dashboard maps the ?error=… code to copy (and the
    // silent-connect lattice treats the login_required family as a quiet
    // hint-clear, Stage E). oss stays byte-identical: key absent, the
    // pre-change default error landing untouched.
    ...(hubSso ? { onAPIError: { errorURL: env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/login' } } : {}),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user,
        session,
        account,
        verification,
        jwks,
        oauthClient,
        oauthAccessToken,
        oauthRefreshToken,
        oauthConsent,
        twoFactor: twoFactorTable
      }
    }),
    user: {
      // Self-serve email change. Enabled unconditionally: without a
      // delivering email driver POST /change-email answers 400 BEFORE the
      // email lookup (no enumeration oracle), so the switch is safe. Tokens
      // are stateless HS256 JWTs signed with the auth secret (1h expiry,
      // not revocable). Template users are typically emailVerified=false, so
      // the COMMON flow is single-leg: one verification mail to the NEW
      // address; the confirmation-to-old-address leg only runs for verified
      // users.
      changeEmail: {
        enabled: true,
        ...(sendChangeEmailConfirmation
          ? {
              sendChangeEmailConfirmation: async ({
                user,
                newEmail,
                url,
                token
              }: {
                user: { email: string };
                newEmail: string;
                url: string;
                token: string;
              }) => {
                await sendChangeEmailConfirmation({ email: user.email, newEmail, url, token });
              }
            }
          : {})
      },
      // Self-service account deletion (GDPR erasure). NO
      // sendDeleteAccountVerification: the password path works with zero
      // SMTP. Known Better Auth default, documented not fought: a session
      // younger than freshAge (24h) may delete WITHOUT a password
      // server-side; the dashboard always collects the password (every
      // template user has a credential account). See ADR 006.
      deleteUser: {
        enabled: true,
        beforeDelete: async (user: { id: string }) => {
          await beforeUserDelete?.(user.id);
        },
        afterDelete: async (user: { id: string; email: string }) => {
          await afterUserDelete?.({ id: user.id, email: user.email });
        }
      }
    },
    emailVerification: {
      expiresIn: 3600,
      ...(sendVerificationEmail
        ? {
            sendVerificationEmail: async ({
              user,
              url,
              token
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              // `user.email` is already the NEW address on the change-email leg.
              await sendVerificationEmail({ email: user.email, url, token });
            }
          }
        : {}),
      // Fires when GET /verify-email flips a user to verified — the email
      // change landing. Also fires on a hypothetical plain verify-email
      // (acceptable: the audit row records a verification event either way).
      afterEmailVerification: async (user: { id: string }) => {
        if (user?.id) await onAccountEvent?.('email_change', user.id);
      }
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // Recovery/change implies a possibly-compromised account: drop the
      // other sessions on a reset. Applies to self-serve AND admin-minted
      // reset links (both land on POST /reset-password).
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        await onAccountEvent?.('password_reset', user.id);
      },
      // Self-serve reset exists only with a delivering email driver; without
      // it, /request-password-reset returns 400 (no user-enumeration oracle).
      // Cloud never wires it (defense in depth under the before-hook refusal
      // above): no reset mail can even be BUILT on that edition.
      ...(sendResetPassword && !hubSso
        ? {
            resetPasswordTokenExpiresIn: 3600,
            sendResetPassword: async ({
              user,
              url,
              token
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              await sendResetPassword({ email: user.email, url, token });
            }
          }
        : {})
    },
    hooks: {
      // Accounts enter through setup or invitations only. HTTP sign-up is
      // closed: ctx.request exists exactly when the call arrived over HTTP;
      // server-side auth.api.signUpEmail calls (setup, invitation accept)
      // carry no request and pass.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/sign-up') && ctx.request) {
          throw new APIError('FORBIDDEN', {
            message: 'Sign-up is closed on this instance — ask an admin for an invitation'
          });
        }
        // Cloud edition (D1, hub-only login): the ENTIRE local password-reset
        // surface refuses — see isPasswordResetPath for the enumerated routes
        // and why. Unconditional (no ctx.request escape hatch like sign-up's):
        // nothing server-side consumes these paths, so a server-side caller
        // appearing would itself be a posture regression. oss is untouched
        // (hubSso exists only on EDITION=cloud boots).
        if (hubSso && isPasswordResetPath(ctx.path)) {
          throw new APIError('FORBIDDEN', {
            message:
              'Password reset is disabled on this edition — credentials are managed at the Antasphere hub'
          });
        }
        // Cloud edition (D1, hub-only login): the emailOTP SIGN-IN surface
        // refuses too — see isOtpSignInPath for the enumerated routes and
        // why. Same unconditional stance as the reset closure (no
        // ctx.request escape hatch): the one server-side consumer of these
        // paths, /cli/auth/request's sendVerificationOTP delegate, refuses
        // at its own route first on cloud (cli_otp_disabled), so a
        // server-side caller reaching this would itself be a posture
        // regression. oss is untouched (hubSso exists only on cloud boots).
        if (hubSso && isOtpSignInPath(ctx.path)) {
          throw new APIError('FORBIDDEN', {
            code: 'otp_signin_disabled',
            message: 'Email-code sign-in is disabled on this edition — use "Sign in with Antasphere"'
          });
        }
        // BOTH editions: the provider-grant read/rotate routes are closed —
        // see isProviderGrantPath for the enumeration and the three reasons.
        // Unconditional (no `ctx.request` escape hatch): nothing server-side
        // calls them either, so a server-side caller appearing would itself
        // be the regression this guard exists to catch.
        // Cloud edition (CLOUD-1 / AUTH-13, PRDCT-1356): unlinking the
        // `antasphere` provider is refused. The /auth/* mount sits BEFORE
        // authContext (isPublicApiPath), so the principal gate never saw
        // this route; a hub user who unlinked kept their origin='hub'
        // memberships while every later reconcile took the `no_link` branch
        // — the one fail-open outcome — cached like a success. Enforcement
        // must not be switchable by its subject. (The reconciler now also
        // fails CLOSED on no_link for a principal holding hub-origin rows.)
        if (hubSso && ctx.path === '/unlink-account') {
          const providerId = (ctx.body as { providerId?: unknown } | undefined)?.providerId;
          if (providerId === 'antasphere') {
            throw new APIError('FORBIDDEN', {
              code: 'hub_unlink_forbidden',
              message: 'The Antasphere link cannot be removed on this edition — it is the identity itself'
            });
          }
        }
        // Cloud edition (EDIT-2, PRDCT-1356): /sign-in/email stays WIRED as
        // the break-glass door, but it is a door for the OPERATOR and the
        // SUPERADMIN_EMAILS allowlist only. Every other local credential on
        // a cloud instance (pre-flip users, a leftover invitation account)
        // would otherwise be a permanent non-SSO entrance that never sees
        // the hub's audit log. Decided on the presented email; unknown
        // addresses answer the same 403 (no account oracle).
        if (hubSso && ctx.path === '/sign-in/email' && ctx.request) {
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '')
            .trim()
            .toLowerCase();
          if (!email || !(await isLocalSignInAllowed(email))) {
            throw new APIError('FORBIDDEN', {
              code: 'local_signin_disabled',
              message:
                'Password sign-in is reserved for the instance operator on this edition — use "Sign in with Antasphere"'
            });
          }
        }
        if (isProviderGrantPath(ctx.path)) {
          throw new APIError('FORBIDDEN', {
            code: 'provider_grant_forbidden',
            message: 'This endpoint is disabled — provider tokens are never handed to callers'
          });
        }
        // Login-CSRF (session fixation) hardening: Better Auth's own origin
        // check deliberately SKIPS requests carrying neither cookies nor
        // Sec-Fetch metadata (progressive enhancement for non-browser
        // clients), which leaves legacy browsers open to a cross-site login
        // POST. Close the gap on the credential-issuing sign-in surface: a
        // sign-in that DOES present an Origin must present a trusted one —
        // trust evaluation is Better Auth's own isTrustedOrigin plus the
        // serving origin (mirroring the trustedOrigins function below).
        // CLI/SDK/MCP flows send no Origin header and are untouched; the
        // OAuth token/register endpoints keep their deliberate public
        // wildcard-CORS posture (middleware/oauth-public.ts).
        if (ctx.path.startsWith('/sign-in') && ctx.request) {
          const origin = ctx.request.headers.get('origin');
          if (origin) {
            let servingOrigin: string | null = null;
            try {
              servingOrigin = new URL(ctx.request.url).origin;
            } catch {
              // unparseable request URL — judge by the trusted list only
            }
            if (
              signInOriginRefused({
                origin,
                servingOrigin,
                untrustedOrigins,
                isTrustedOrigin: (o) => ctx.context.isTrustedOrigin(o)
              })
            ) {
              throw new APIError('FORBIDDEN', { message: 'Invalid origin' });
            }
          }
        }
        // PRDCT-1437 door 1 (the change-email consume existence oracle) is
        // closed at the mount wrapper in api/index.ts, not here: it needs to
        // rewrite the REQUEST before Better Auth reads the token, which a
        // before-hook's `ctx.query` mutation does not reach (the endpoint reads
        // its own parsed query). See `rewriteChangeEmailCollision` there.
        // The plugin scheme-checks only redirect_uris — reject javascript:/data:
        // metadata URIs on every client write path (unauthenticated DCR AND the
        // session-gated create/update-client endpoints) so a stored javascript:
        // URI can never reach a render site. The consent page also validates at
        // render (defense in depth).
        if (
          ctx.path === '/oauth2/register' ||
          ctx.path === '/oauth2/create-client' ||
          ctx.path === '/oauth2/update-client'
        ) {
          const raw = ctx.body as Record<string, unknown> | undefined;
          // register/create-client carry the fields at the top level;
          // update-client nests them under `update`.
          const meta = (raw?.update ?? raw) as Record<string, unknown> | undefined;
          for (const field of CLIENT_METADATA_URI_FIELDS) {
            const value = meta?.[field];
            if (value != null && value !== '' && !isHttpUrl(value)) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_client_metadata',
                error_description: `${field} must be an http(s) URL`
              });
            }
          }
        }
      }),
      // A successful /change-password or /change-email reaches the after-hook
      // (an error throws before it) — audit them here since Better Auth
      // routes bypass the /api/v1 audit middleware. Reset is audited via
      // onPasswordReset above; the email-change LANDING (the verify-email
      // consumption) via afterEmailVerification.
      after: createAuthMiddleware(async (ctx) => {
        // Hub SSO per-login work (cloud only) — the callback after-hook.
        // Fires for JIT AND returning users; `ctx.context.newSession` is the
        // success discriminator (set by setSessionCookie before the redirect
        // throw, never on the plugin's error exits — S1(b)). The verified
        // assertion crosses from getUserInfo via the request-scoped login
        // scope (ADR 015); everything here FAILS CLOSED: no assertion or a
        // failed projection revokes the just-minted session — a cloud login
        // without its hub-asserted workspace projection must not exist.
        if (hubSso && ctx.path === '/oauth2/callback/:providerId') {
          const providerId = (ctx as { params?: Record<string, string> }).params?.providerId;
          if (providerId === HUB_SSO_PROVIDER_ID) {
            const data = ctx.context.newSession;
            if (!data?.user) return; // error exits mint no session — nothing to assert
            const assertion = hubSso.takeAssertion();
            try {
              if (!assertion) {
                throw new HubSsoLoginError(
                  'sso_assertion_missing',
                  'callback succeeded but no verified hub assertion reached the after-hook'
                );
              }
              await hubSso.assertLogin(data.user.id, assertion);
            } catch (err) {
              hubSso.logLoginFailure(err, data.user.id);
              // Same undo dance as the 2FA interstitial below: drop the
              // session row, expire the cookie, clear newSession, then
              // replace the success redirect with the error redirect.
              await ctx.context.internalAdapter.deleteSession(data.session.token);
              deleteSessionCookie(ctx, true);
              ctx.context.setNewSession(null);
              const code = err instanceof HubSsoLoginError ? err.code : 'sso_login_failed';
              throw ctx.redirect(hubSso.loginErrorUrl(code));
            }
            return;
          }
        }
        if (ctx.path === '/change-password') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('password_change', userId);
        }
        if (ctx.path === '/change-email') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('email_change_request', userId);
        }
        // 2FA credential-material events (both routes are session-gated).
        // Enroll = secret + backup codes issued (activation completes on the
        // first verified TOTP); disable = secret + backup codes destroyed.
        if (ctx.path === '/two-factor/enable') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('two_factor_enroll', userId);
        }
        if (ctx.path === '/two-factor/disable') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('two_factor_disable', userId);
        }
        // Close the email-OTP second-factor bypass: the twoFactor plugin's
        // own sign-in hook covers /sign-in/email (password) but NOT
        // /sign-in/email-otp, so an emailed one-time code would sign a
        // 2FA-enabled user straight in — collapsing 2FA to mailbox control.
        // Mirror the plugin's dance (verified against 1.6.22
        // plugins/two-factor/index.mjs; re-verify on ANY Better Auth bump):
        // drop the just-minted session, park the pending sign-in in the
        // verification table behind the signed `two_factor` cookie, park the
        // per-challenge attempt counter next to it, and answer
        // { twoFactorRedirect } so /two-factor/verify-totp (or a backup code)
        // completes it. A 2FA-enabled user always has a verified TOTP secret
        // — activation is the only path that sets user.twoFactorEnabled.
        // The `2fa-attempts-<identifier>` row is NOT optional since 1.6.22:
        // verifyTwoFactor's beginAttempt CONSUMES it on every verify and
        // throws INVALID_TWO_FACTOR_COOKIE (401) when it is missing, so a
        // mirror that parks only the `2fa-` row hands the user a pending
        // state no factor can ever complete (PRDCT-1344; the hub hit the
        // same trap on its own bump).
        if (ctx.path === '/sign-in/email-otp') {
          const data = ctx.context.newSession;
          if (!data?.user || !(data.user as { twoFactorEnabled?: boolean }).twoFactorEnabled) return;
          deleteSessionCookie(ctx, true);
          await ctx.context.internalAdapter.deleteSession(data.session.token);
          ctx.context.setNewSession(null);
          const maxAge = 600; // the plugin's twoFactorCookieMaxAge default
          const twoFactorCookie = ctx.context.createAuthCookie('two_factor', { maxAge });
          const identifier = `2fa-${generateRandomString(20)}`;
          const expiresAt = new Date(Date.now() + maxAge * 1000);
          await ctx.context.internalAdapter.createVerificationValue({
            value: data.user.id,
            identifier,
            expiresAt
          });
          await ctx.context.internalAdapter.createVerificationValue({
            value: '0',
            identifier: `2fa-attempts-${identifier}`,
            expiresAt
          });
          await ctx.setSignedCookie(
            twoFactorCookie.name,
            identifier,
            ctx.context.secret,
            twoFactorCookie.attributes
          );
          return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
        }
      })
    },
    // Adapter-level hooks: config only, NOT schema — the drift guard's
    // generated auth-schema is unaffected (verified via drift:check).
    databaseHooks: {
      user: {
        create: {
          // Every entrance (setup's signUpEmail, invitation accept, the
          // collaborator claim endpoint, a future SSO JIT) creates the row
          // through the internal adapter, so this is the single trustworthy
          // `user.created` seam. Synchronous dispatch onto the event bus;
          // subscriber failures are isolated there and never fail account
          // creation.
          after: async (user: { id: string; email: string }) => {
            onUserCreated?.({ id: user.id, email: user.email });
          }
        }
      }
    },
    // Sessions, split by edition (SL-5, "one concept of being logged in"):
    //
    //  - oss keeps the template's long-lived SLIDING sessions, byte-identical
    //    (safe because the auth-context middleware re-checks workspace
    //    membership on every request — instant revocation).
    //  - cloud runs 30-day FIXED (non-sliding) sessions: the tool session is
    //    a PROJECTION of the hub anchor session, and a sliding projection
    //    would never re-dance — it would let the anchor die under an active
    //    user. A fixed expiry forces a silent prompt=none re-derivation from
    //    the anchor at most every 30 days, and each re-derivation's authorize
    //    touch slides the HUB session forward (the anchor stays alive off
    //    activity on ANY tool). The knob is `disableSessionRefresh` — pinned
    //    on 1.6.15 and 1.6.22 (dist/api/routes/session.mjs is its ONLY reader:
    //    `needsRefresh` goes false, so expiresAt never advances on use;
    //    re-verify on ANY bump). `updateAge` is left at its default there —
    //    it is dead config once refresh is disabled. CONFIG-ONLY: no schema
    //    change (drift:check proves).
    session: hubSso
      ? {
          expiresIn: 60 * 60 * 24 * 30,
          disableSessionRefresh: true
        }
      : {
          expiresIn: 60 * 60 * 24 * 365,
          updateAge: 60 * 60 * 24
        },
    advanced: {
      useSecureCookies: isHttps
    },
    // Trust the serving origin (works on localhost, previews, any domain)
    // plus the configured public origin behind a TLS-terminating proxy.
    // Serving origin + public origin, never the viewer origin (see trustedOriginsFor).
    trustedOrigins: trustedOriginsFor(env.PUBLIC_BASE_URL, untrustedOrigins)
  });
}
