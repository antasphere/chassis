import type { OpenAPIHono } from '@hono/zod-openapi';

type OpenApiObjectConfig = Parameters<OpenAPIHono['getOpenAPIDocument']>[0];

/**
 * Serve the OpenAPI document from a buffer generated ONCE, at registration.
 *
 * `OpenAPIHono.doc()` runs the whole generator inside the request handler:
 * every route definition walked, every zod schema converted, the result
 * re-serialized — synchronously, on the event loop, for every caller. The
 * document is also unauthenticated by design (it is in `PUBLIC_API_PATHS`), so
 * it never reaches the per-principal quota either. That combination is a
 * one-line anonymous DoS: a few concurrent GETs stall the loop long enough to
 * starve `/healthz` and fail the container health check.
 *
 * The document is a pure function of the route table, which is frozen once the
 * app is built — so generating it at boot is not a cache with an invalidation
 * problem, it is simply the right time to do the work. Call this AFTER every
 * `api.openapi(...)` registration.
 */
export function registerOpenApiDoc(
  api: OpenAPIHono,
  config: OpenApiObjectConfig,
  path = '/openapi.json'
): void {
  const body = JSON.stringify(api.getOpenAPIDocument(config));
  api.get(path, (c) =>
    c.body(body, 200, {
      'content-type': 'application/json; charset=UTF-8',
      // Public, immutable for a given build — let proxies absorb the load too.
      'cache-control': 'public, max-age=300'
    })
  );
}
