import type { MiddlewareHandler } from 'hono';

/**
 * Public (cookie-less) OAuth endpoints that MCP clients call cross-origin.
 * These authenticate via body credentials (code + PKCE, refresh token), never
 * cookies, so a wildcard CORS origin is safe — and required for browser-based
 * clients to read the responses. Cookie-bearing auth endpoints (sign-in,
 * consent, authorize) are deliberately NOT in this list. Ported from the Neon
 * template's hooks.server.ts PUBLIC_OAUTH_PATHS treatment, adapted to the
 * /api/v1/auth base path.
 */
const PUBLIC_OAUTH_PATHS = new Set([
  '/api/v1/auth/oauth2/token',
  '/api/v1/auth/oauth2/register',
  '/api/v1/auth/oauth2/introspect',
  '/api/v1/auth/oauth2/revoke',
  '/api/v1/auth/jwks'
]);

export const OAUTH_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400'
} as const;

export function isPublicOauthPath(path: string): boolean {
  return PUBLIC_OAUTH_PATHS.has(path) || path.startsWith('/api/v1/auth/.well-known/');
}

/**
 * Wide-open CORS + preflight handling for the public OAuth endpoints, and
 * RFC 6749 §5.1 cache suppression on the token endpoint (its responses carry
 * credentials). Registered before the auth-surface rate limits so OPTIONS
 * preflights never consume a bucket.
 */
export function oauthPublicEndpoints(): MiddlewareHandler {
  return async (c, next) => {
    if (!isPublicOauthPath(c.req.path)) {
      return next();
    }
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, { ...OAUTH_CORS_HEADERS });
    }
    await next();
    for (const [key, value] of Object.entries(OAUTH_CORS_HEADERS)) {
      c.res.headers.set(key, value);
    }
    if (c.req.path === '/api/v1/auth/oauth2/token') {
      c.res.headers.set('Cache-Control', 'no-store');
      c.res.headers.set('Pragma', 'no-cache');
    }
  };
}
