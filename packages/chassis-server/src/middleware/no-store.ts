import type { MiddlewareHandler } from 'hono';

/**
 * `Cache-Control: no-store` on authenticated JSON.
 *
 * `/me`, the member roster, the audit page, every product resource — all of
 * them answer per-principal JSON with no cache directive at all, which leaves
 * the decision to heuristic caching in whatever sits in front of the app (a
 * shared corporate proxy, a CDN a self-hoster puts in the path, the browser's
 * own bfcache/back-button restore). One user's roster served to the next is
 * exactly the failure mode `no-store` exists to prevent.
 *
 * Scoped deliberately:
 *
 *  - only when a principal resolved — anonymous discovery (`/instance`) and
 *    the OpenAPI document stay cacheable;
 *  - only JSON — file downloads and exports are streamed, sometimes ranged,
 *    and set their own headers (api/export.ts already sends `no-store`);
 *  - never clobbering a Cache-Control a route set for itself.
 */
export function noStoreAuthenticated(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!c.get('principal')) return;
    if (c.res.headers.has('cache-control')) return;
    const contentType = c.res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) return;
    c.res.headers.set('Cache-Control', 'no-store');
  };
}
