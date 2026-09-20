import type { MiddlewareHandler } from 'hono';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { ACTIVE_WORKSPACE_HEADER, type Principal } from '@antasphere/chassis-contract';
import type { PlatformRegistry } from '../platform/registry.js';
import { WorkspaceMismatchError } from '../apikeys/service.js';
import { apiError } from '../api/errors.js';
import {
  quotaHeaderEntries,
  type ClientIpFn,
  type QuotaDecision,
  type RequestQuotaService
} from './rate-limit.js';
import { looksLikeJwt } from './scopes.js';

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal | null;
    /** The tool's `guest_forbidden` sentence, set by `authContext` for `requireNonGuest()` to answer with. */
    guestForbiddenMessage: string;
  }
}

/** Paths under /api/v1 that are reachable without any credential. */
const PUBLIC_API_PATHS = new Set([
  '/api/v1/instance',
  '/api/v1/setup',
  '/api/v1/openapi.json',
  // CLI email-OTP sign-in (api/cli-auth.ts): pre-auth by definition — the
  // flow exists to OBTAIN a credential. Both are rate-limited in api/index.ts.
  '/api/v1/cli/auth/request',
  '/api/v1/cli/auth/complete',
  // CLI cross-tool connect (api/sso-connect.ts, cloud edition): pre-auth by
  // the same definition — the hub-minted exchange JWT in the body IS the
  // credential, verified hard by the handler. Rate-limited in api/index.ts.
  // The entry is inert on oss: the route is never registered there, so the
  // path falls through to the JSON 404 terminator for every caller.
  '/api/v1/sso/cli-connect'
]);

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path) || path.startsWith('/api/v1/auth/');
}

/**
 * An edition's post-resolution verdict on an otherwise-valid principal.
 * `ok` with a `role` means "the caller's authoritative role just changed —
 * run THIS request under it"; a refusal carries the exact wire error. The
 * seam exists for the cloud edition's hub gates (org suspension + hub
 * membership re-assertion, internal/federation.md P4); oss never wires one.
 * The gate also sees WHAT is being asked (`request`), so a policy can exempt
 * specific surfaces (e.g. suspension keeping GET /me readable — the
 * visible-but-blocked posture); implementations may ignore it.
 */
export type PrincipalGateResult =
  { ok: true; role?: Principal['role'] } | { ok: false; status: 401 | 403; code: string; message: string };

export type PrincipalGate = (
  principal: Principal,
  request: { path: string; method: string }
) => Promise<PrincipalGateResult>;

export interface AuthContextDeps {
  registry: PlatformRegistry;
  /**
   * Resolves `Bearer <prefix>_...` API keys under the user-scoped selection
   * rule — `requested` is the request's X-Workspace-Id (or null). May throw
   * WorkspaceMismatchError for a valid PINNED key whose pin differs from the
   * header. Absent = keys rejected.
   */
  resolveApiKey?: (token: string, requested: string | null) => Promise<Principal | null>;
  /** Resolves OAuth Bearer JWTs (local JWKS verify + live membership selection). */
  resolveOauthJwt?: (token: string, requested: string | null) => Promise<Principal | null>;
  /** Distinguishes an API-key credential from other bearers. */
  isApiKeyToken: (token: string) => boolean;
  /** Failed key verifications consume from this bucket (per IP) — brute-force wall. */
  keyFailureLimiter?: RateLimiterAbstract;
  /** Client identity (socket address unless TRUST_PROXY opts into XFF). */
  clientIp: ClientIpFn;
  /** General per-principal request quota (I3). Absent = no general limit. */
  requestQuota?: RequestQuotaService;
  /**
   * Post-resolution principal veto (cloud edition only). Runs here — in the
   * single credential resolver — rather than inside any one identity path,
   * so sessions, API keys, AND OAuth bearers all pass the same gate
   * (internal/decisions/016). Absent (oss) = zero overhead, zero hub surface.
   */
  principalGate?: PrincipalGate | undefined;
  /**
   * The composed fail-closed scope allowlist (`createScopeAllowlist` in
   * scopes.ts: the chassis rules, then the tool's). `null` = the endpoint is
   * not open to machine principals. Required: a tool must state its list.
   */
  requiredScopeFor: (path: string, method: string) => string | null;
  /**
   * The tool's `guest_forbidden` sentence (`copy.guestForbidden`). Carried on
   * the request so `requireNonGuest()` keeps its argument-less call sites, in
   * the chassis and in the tool alike. Required: the chassis has no wording.
   */
  guestForbiddenMessage: string;
}

/**
 * The single credential resolver: every /api/v1 request passes through here
 * and comes out with c.get('principal') set (or a 401/403 for bad machine
 * credentials). Three paths, one output shape:
 *
 *  - session cookie → IdentityProvider.resolve (live membership re-check)
 *  - Bearer API key → O(1) key lookup (M2)
 *  - Bearer JWT → OAuth access token this instance minted: local JWKS
 *    verification + live membership re-check (M6)
 *
 * Machine principals additionally pass the fail-closed scope allowlist:
 * endpoints not consciously listed in scopes.ts are unreachable with a key
 * or token, whatever the underlying user's role is.
 */
export function authContext({
  registry,
  resolveApiKey,
  resolveOauthJwt,
  isApiKeyToken,
  keyFailureLimiter,
  clientIp,
  requestQuota,
  principalGate,
  requiredScopeFor,
  guestForbiddenMessage
}: AuthContextDeps): MiddlewareHandler {
  return async (c, next) => {
    c.set('principal', null);
    c.set('guestForbiddenMessage', guestForbiddenMessage);

    if (isPublicApiPath(c.req.path)) {
      return next();
    }

    const authHeader = c.req.header('authorization')?.trim() ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() ?? null;

    // The universal per-request workspace selector (user-scoped credential
    // model): EVERY credential kind resolves it through the shared
    // resolveMembership rule — sessions inside the identity provider,
    // machine credentials via the threaded `requested` below. A PINNED API
    // key is the one exception: it always resolves its pin, and a header
    // naming a different workspace is rejected loudly (403 below) instead of
    // being silently served the pinned one.
    const requested = c.req.header(ACTIVE_WORKSPACE_HEADER)?.trim() || null;

    let principal: Principal | null = null;

    if (bearer && looksLikeJwt(bearer)) {
      if (!resolveOauthJwt) {
        return apiError(c, 401, 'oauth_not_enabled', 'OAuth bearer tokens are not enabled on this instance');
      }
      principal = await resolveOauthJwt(bearer, requested);
      if (!principal) {
        return apiError(c, 401, 'invalid_token', 'OAuth bearer token is invalid, expired, or revoked');
      }
    } else if (bearer && isApiKeyToken(bearer)) {
      if (!resolveApiKey) {
        return apiError(c, 401, 'invalid_api_key', 'API key not recognized');
      }
      const ip = clientIp(c);
      if (keyFailureLimiter) {
        const bucket = await keyFailureLimiter.get(ip).catch(() => null);
        if (bucket && bucket.remainingPoints <= 0 && bucket.msBeforeNext > 0) {
          return apiError(c, 429, 'rate_limited', 'Too many failed API key attempts');
        }
      }
      try {
        principal = await resolveApiKey(bearer, requested);
      } catch (cause) {
        // A VALID pinned key + a mismatching selector: a client bug or a
        // confused-deputy attempt — loud 403, and no failure-limiter charge
        // (the credential itself verified fine).
        if (cause instanceof WorkspaceMismatchError) {
          return apiError(c, 403, 'workspace_mismatch', 'This credential is pinned to a different workspace');
        }
        throw cause;
      }
      if (!principal) {
        if (keyFailureLimiter) await keyFailureLimiter.consume(ip).catch(() => {});
        return apiError(c, 401, 'invalid_api_key', 'API key not recognized');
      }
    } else if (bearer) {
      return apiError(c, 401, 'unsupported_credential', 'Unrecognized bearer credential format');
    } else {
      principal = await registry.identity.resolve({
        headers: c.req.raw.headers,
        path: c.req.path,
        method: c.req.method,
        requestId: c.get('requestId')
      });
    }

    // General per-principal request quota (I3), consumed BEFORE the scope
    // gate so even fail-closed 403 hammering is bounded — once a credential
    // resolves, the quota is the outermost cost control. The bucket key is
    // derived from the principal (see principalBucketKey), never a header.
    // Sessions are included: the default quota is far above any dashboard's
    // request rate, and a hijacked/scripted session is the same cost vector.
    let quota: QuotaDecision | null = null;
    if (principal && requestQuota) {
      quota = await requestQuota.consume(principal);
      if (quota && !quota.ok) {
        for (const [name, value] of quotaHeaderEntries(quota)) c.header(name, value);
        c.header('Retry-After', String(quota.retryAfterSeconds ?? Math.max(1, quota.resetSeconds)));
        return apiError(c, 429, 'rate_limited', 'API request quota exceeded, slow down');
      }
    }

    // Edition principal gate (cloud: hub org-status + membership
    // re-assertion, internal/federation.md P4). AFTER the quota — hammering a
    // suspended org stays rate-bounded — and BEFORE the scope gate, so a
    // definitive hub refusal wins over any per-endpoint outcome. Cache-first
    // inside; the hub is never a hard round-trip in the hot path.
    if (principal && principalGate) {
      const verdict = await principalGate(principal, { path: c.req.path, method: c.req.method });
      if (!verdict.ok) {
        return apiError(c, verdict.status, verdict.code, verdict.message);
      }
      // A freshly synced hub role applies to THIS request (D11): a demoted
      // admin loses admin surfaces now, a promoted member gains them now.
      if (verdict.role !== undefined && verdict.role !== principal.role) {
        principal = { ...principal, role: verdict.role };
      }
    }

    // Fail-closed scope gate for machine principals only.
    if (principal?.scopes) {
      const needed = requiredScopeFor(c.req.path, c.req.method);
      if (!needed) {
        return apiError(c, 403, 'endpoint_not_allowed', 'This endpoint is not available to this credential');
      }
      if (!principal.scopes.has(needed)) {
        return apiError(c, 403, 'insufficient_scope', `This credential was not granted "${needed}"`);
      }
    }

    c.set('principal', principal);
    if (!quota) return next();

    // Success path: stamp the quota headers on whatever response the route
    // produced (set on c.res so streamed/raw Response bodies get them too),
    // letting well-behaved agents self-throttle before hitting 429s.
    await next();
    for (const [name, value] of quotaHeaderEntries(quota)) c.res.headers.set(name, value);
    return;
  };
}

/** Route guard: 401 when unauthenticated. */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('principal')) {
      return apiError(c, 401, 'unauthenticated', 'Authentication required');
    }
    return next();
  };
}

/**
 * Route guard (D2, internal/federation.md P6): an `origin='guest'` membership
 * belongs to an EXTERNAL per-resource collaborator — it exists so the platform
 * can resolve them to a principal at all, not to make them a workspace
 * actor. Guests keep every ADR 013 per-resource surface their grant opens
 * (read, version push, share tokens, annotations on THAT resource) but are
 * refused resource creation and workspace-level surfaces on BOTH editions.
 * Judges the resolved principal, so sessions, API keys, and OAuth bearers
 * all pass the same gate. 403 — the surfaces this guards are flat,
 * documented workspace surfaces, not probeable per-grant resources, so the
 * ADR 013 hide-existence 404 posture does not apply here (same stance as
 * requireRole).
 */
export function requireNonGuest(): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) {
      return apiError(c, 401, 'unauthenticated', 'Authentication required');
    }
    if (principal.origin === 'guest') {
      // A principal only ever comes out of `authContext`, which set the sentence first.
      return apiError(c, 403, 'guest_forbidden', c.get('guestForbiddenMessage'));
    }
    return next();
  };
}

const ROLE_RANK = { member: 0, admin: 1, owner: 2 } as const;

/** Route guard: 403 below the required role. */
export function requireRole(min: keyof typeof ROLE_RANK): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) {
      return apiError(c, 401, 'unauthenticated', 'Authentication required');
    }
    if (ROLE_RANK[principal.role] < ROLE_RANK[min]) {
      return apiError(c, 403, 'forbidden', `Requires ${min} role`);
    }
    return next();
  };
}
