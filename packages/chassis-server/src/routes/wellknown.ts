import { Hono, type Context } from 'hono';
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata
} from '@better-auth/oauth-provider';
import { mcpResourceUrl, type Auth } from '../identity/better-auth.js';

/**
 * Root-level OAuth discovery surface.
 *
 * The oauthProvider plugin serves RFC 8414 / OIDC discovery under the
 * /api/v1/auth base path, but clients resolve discovery from the ISSUER (the
 * bare origin — jwt.issuer in identity/better-auth.ts), so the same documents
 * must exist at the origin root. RFC 9728 protected-resource metadata is ours:
 * it points the 401-challenged MCP client at this same origin as its
 * authorization server. All documents are public by design and fetched
 * cross-origin by browser-based MCP hosts — wide-open CORS is correct.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400'
} as const;

export interface WellKnownDeps {
  auth: Auth;
  publicBaseUrl: string;
  instanceName?: string;
  /** The tool's OAuth scope list, as registered with the provider: what `scopes_supported` advertises. */
  oauthScopes: readonly string[];
}

export function wellKnownRoutes({ auth, publicBaseUrl, oauthScopes }: WellKnownDeps): Hono {
  const app = new Hono();

  const asMetadata = oauthProviderAuthServerMetadata(auth, {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
  });
  const oidcMetadata = oauthProviderOpenIdConfigMetadata(auth, {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
  });

  app.get('/.well-known/oauth-authorization-server', (c) => asMetadata(c.req.raw));
  app.get('/.well-known/openid-configuration', (c) => oidcMetadata(c.req.raw));

  // RFC 9728: served at the origin level AND at the path-aware derivation
  // (clients insert /.well-known/oauth-protected-resource between origin and
  // the resource path /mcp) — both return the same document.
  const protectedResource = (c: Context) =>
    c.json(
      {
        resource: mcpResourceUrl(publicBaseUrl),
        authorization_servers: [publicBaseUrl],
        scopes_supported: [...oauthScopes],
        bearer_methods_supported: ['header']
      },
      200,
      { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
    );
  app.get('/.well-known/oauth-protected-resource', (c) => protectedResource(c));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => protectedResource(c));

  app.options('/.well-known/*', (c) => c.body(null, 204, { ...CORS_HEADERS }));

  return app;
}
