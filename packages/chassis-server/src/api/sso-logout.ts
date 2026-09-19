import type { OpenAPIHono } from '@hono/zod-openapi';
import { ssoLogoutRoute } from '@antasphere/chassis-contract/routes';
import type { Auth } from '../identity/better-auth.js';
import { hintCookieClearHeader, type HubLogoutService } from '../identity/hub-logout.js';
import type { Logger } from '../logger.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /sso/logout — the single-logout server leg (SL-2, cloud edition
 * ONLY; api/index.ts registers this module iff the instance boots
 * EDITION=cloud, so oss answers the JSON 404 terminator: zero hub surface).
 *
 * Reachability, fail-closed on every side:
 *  - MACHINES NEVER GET HERE: the path is deliberately UNLISTED in the
 *    fail-closed scope allowlist (middleware/scopes.ts), so authContext
 *    403s every API key and OAuth bearer before this handler runs. Never
 *    list it — a credential must not be able to end its user's sessions.
 *  - SESSIONS resolve ROUTE-LOCALLY via auth.api.getSession (the /me
 *    zero-state pattern): a live session whose user holds no active
 *    membership — the cloud operator pre-break-glass, a hub user whose
 *    last org was removed — resolves to a null principal upstream but must
 *    still be able to log out.
 *  - ANONYMOUS callers 401.
 *
 * Handler order (the plan's pinned sequence): resolve session → build the
 * hub end-session URL (ANY failure → null, never an error) → revoke the
 * local session server-side, forwarding better-auth's cookie-clearing
 * Set-Cookie → clear the shared hint cookie → respond {url}. The local
 * revoke + hint clear run even when url is null — a hub outage degrades the
 * logout to local-only, it never blocks it.
 */

export interface SsoLogoutRouteDeps {
  auth: Auth;
  logout: HubLogoutService;
  /** The shared hint cookie's clearing attributes (cross-repo contract). */
  hint: { name: string; domain: string; secure: boolean };
  logger: Logger;
}

export function registerSsoLogoutRoutes(api: OpenAPIHono, deps: SsoLogoutRouteDeps): void {
  const { auth, logout, hint, logger } = deps;

  api.openapi(ssoLogoutRoute, async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }

    // 1. Build the hub leg FIRST (it reads the account row the revoke does
    // not touch; null on any failure — the steps below never depend on it).
    const url = await logout.endSessionUrl(session.user.id);

    // 2. Revoke the local session server-side. better-auth's /sign-out
    // deletes the session row and emits the cookie-clearing Set-Cookie —
    // forward it so the browser drops the cookie in the same response.
    // Its handler already swallows a failed row delete (cookie still
    // cleared), so this throws only on wiring-level failures.
    const signedOut = await auth.api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true
    });
    for (const value of signedOut.headers.getSetCookie()) {
      c.header('set-cookie', value, { append: true });
    }

    // 3. Clear the shared hint cookie (Domain-scoped to the parent, exactly
    // as the hub set it) — logout anywhere must stop every tool's silent
    // auto-connect until the next hub login re-asserts it.
    c.header('set-cookie', hintCookieClearHeader(hint), { append: true });

    logger.info({ userId: session.user.id, hubLeg: url !== null }, 'sso logout: local session revoked');
    return c.json({ url }, 200);
  });
}
