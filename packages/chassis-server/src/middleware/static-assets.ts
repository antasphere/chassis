import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

/**
 * The dashboard build, served so the browser keeps it (PRDCT-3584).
 *
 * Before this middleware the SPA's files went out with no `Cache-Control`,
 * no validator and no compression: every visit to a tool re-downloaded the
 * whole dashboard (about 1.2 MB of JavaScript in a hundred files on the
 * team stack, measured 2026-10-17), and the splash the person stared at
 * was that download. Two rules fix it, both on the build's own shape:
 *
 *  - `/_app/immutable/*` is CONTENT-HASHED by SvelteKit: a changed file has a
 *    new name, so the cached copy can never be stale. It is served with
 *    `public, max-age=31536000, immutable`: a second visit transfers none of
 *    it. Every other static path (the HTML, the icons, the manifest) is
 *    `no-cache`: kept, but revalidated on every use, so a release reaches
 *    the browser on its next load.
 *  - A `.br`, `.zst` or `.gz` sibling written at build time (the dashboard's
 *    adapter has `precompress: true`) is served in place of the file when
 *    the request accepts that encoding, with `Content-Encoding` and `Vary:
 *    Accept-Encoding`. The server compresses nothing at runtime, and the
 *    API is untouched: this middleware runs on the static files alone,
 *    after every credentialed route has answered.
 *
 * Nothing here is a security input. `immutable` never reaches a response
 * that is not a hashed asset, so no user-bearing answer can be cached; the
 * authenticated JSON keeps its `no-store` (middleware/no-store.ts).
 */

/** The content-hashed prefix of a SvelteKit build. */
export const IMMUTABLE_ASSET_PREFIX = '/_app/immutable/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/** The `Cache-Control` a static path of the build is served with. */
export function staticCacheControl(requestPath: string): string {
  return requestPath.startsWith(IMMUTABLE_ASSET_PREFIX) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

export interface StaticAssetsOptions {
  /** The directory holding the built dashboard (`index.html`, `_app/`). */
  publicDir: string;
}

/**
 * Serve `publicDir` with the cache policy above and the precompressed
 * siblings. Falls through (`next()`) on a path that is not a file there, so
 * the SPA fallback behind it answers the application routes.
 */
export function staticAssets(options: StaticAssetsOptions): MiddlewareHandler {
  const serve = serveStatic({ root: options.publicDir, precompressed: true });
  return async (c, next) => {
    const res = await serve(c, next);
    // serveStatic answers a Response for a file it found and the result of
    // `next()` otherwise; only the file gets the policy.
    if (res instanceof Response) {
      res.headers.set('Cache-Control', staticCacheControl(c.req.path));
      if (!res.headers.has('Vary')) res.headers.set('Vary', 'Accept-Encoding');
    }
    return res;
  };
}
