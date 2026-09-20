import type { Context, MiddlewareHandler } from 'hono';
import { apiError } from '../api/errors.js';
import { isPublicOauthPath } from './oauth-public.js';

/**
 * Cross-site request forgery defence for the whole `/api/v1` surface.
 *
 * The session cookie authenticates every business route (`/orgs`, `/members`,
 * `/invitations`, `/me/*`, `/apikeys`, every product route a instantiation
 * adds), and a cookie is attached by the browser on a cross-site POST just as
 * happily as on a same-origin one. Better Auth's own origin check covers only
 * its `/sign-in` paths, so without this middleware a page on any origin could
 * drive a signed-in user's whole API.
 *
 * Two independent signals, both browser-set and unforgeable by page script
 * (both are Forbidden Header Names — `fetch` cannot override them):
 *
 *  1. `Sec-Fetch-Site: cross-site` — a request initiated by a document on a
 *     different site. Refused outright.
 *  2. `Origin` — present on every browser request with an unsafe method.
 *     Refused unless it is the origin we are being served on, the configured
 *     public origin, or an explicitly trusted extra.
 *
 * Deliberately NOT refused:
 *
 *  - Safe methods (GET/HEAD/OPTIONS). A cross-site read cannot be seen by the
 *    attacker — `/api/v1` sends no `Access-Control-Allow-Origin` except on the
 *    OAuth surfaces below — and refusing them would break legitimate
 *    cross-origin embeds of authenticated content.
 *  - Requests presenting an `Authorization` header. Those are API keys and
 *    OAuth bearers: not ambient credentials, so not forgeable cross-site (a
 *    page cannot attach the header without a preflight we never approve).
 *    Refusing them would break every scripted and browser-based MCP client.
 *  - The deliberate wildcard-CORS OAuth endpoints (oauth-public.ts): token,
 *    register, introspect, revoke, jwks and discovery are cookie-less by
 *    design and MUST answer any origin.
 *  - Requests with neither header. Non-browser clients (curl, the CLI, the
 *    SDK, server-to-server) send neither, and this middleware must not become
 *    a browser-only gate on a self-hosted API. The ambient-credential threat
 *    this closes is browser-only, and browsers always send at least one.
 */
export interface CrossSiteGuardOptions {
  /** The instance's configured public origin (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
  /**
   * Additional origins allowed to drive the API with cookies — a separately
   * hosted first-party dashboard, say. Empty on the template.
   */
  extraTrustedOrigins?: readonly string[];
  /**
   * Origins REFUSED even when they equal the origin this request was served
   * on: the viewer origin (VIEWER_BASE_URL, PRDCT-1352). The host gate keeps
   * `/api/v1` (minus the token-authed `/viewer/*` subset) off that hostname
   * altogether, so in the shipped assembly no request here carries it as the
   * serving origin — this is the second lock, so that a gate regression or a
   * proxy routing the viewer hostname at the app never turns "the origin we
   * are served on" into a trust grant for author-controlled script.
   */
  deniedOrigins?: readonly string[];
  /** Escape hatch for surfaces that must stay open (paths are `/api/v1/...`). */
  isExempt?: (path: string) => boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The origin this very request was addressed to (works on localhost, previews, any domain). */
function servingOrigin(c: Context): string | null {
  return originOf(c.req.url);
}

export function crossSiteGuard({
  publicBaseUrl,
  extraTrustedOrigins = [],
  deniedOrigins = [],
  isExempt
}: CrossSiteGuardOptions): MiddlewareHandler {
  const configured = new Set<string>();
  const publicOrigin = originOf(publicBaseUrl);
  if (publicOrigin) configured.add(publicOrigin);
  for (const extra of extraTrustedOrigins) {
    const origin = originOf(extra);
    if (origin) configured.add(origin);
  }
  const denied = new Set<string>();
  for (const value of deniedOrigins) {
    const origin = originOf(value);
    if (origin) denied.add(origin);
  }
  // A denied origin wins over every trust source, the serving origin included.
  for (const origin of denied) configured.delete(origin);

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header('authorization')) return next();
    if (isPublicOauthPath(c.req.path)) return next();
    if (isExempt?.(c.req.path)) return next();

    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite === 'cross-site') {
      return apiError(c, 403, 'cross_site_forbidden', 'Cross-site requests are not accepted on this API');
    }

    const origin = c.req.header('origin');
    if (origin) {
      const serving = servingOrigin(c);
      const trusted = !denied.has(origin) && (origin === serving || configured.has(origin));
      if (!trusted) {
        return apiError(c, 403, 'cross_site_forbidden', 'Cross-site requests are not accepted on this API');
      }
    }

    return next();
  };
}
