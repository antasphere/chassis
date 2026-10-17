import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    // The application's HTML itself (`/`, `/index.html`) is the SPA
    // fallback's to answer, with its validator and its sibling; the static
    // server would hand it out with neither (verifier round 2).
    if (c.req.path === '/' || c.req.path === '/index.html') return next();
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

// ── The SPA fallback ────────────────────────────────────────────────────────

/** The encodings a precompressed sibling may carry, in the order they are preferred. */
const FALLBACK_ENCODINGS = [
  { name: 'br', ext: '.br' },
  { name: 'gzip', ext: '.gz' }
] as const;
type FallbackEncoding = (typeof FALLBACK_ENCODINGS)[number]['name'];

/** The encodings a request accepts, read from `Accept-Encoding` with any `;q=` weight ignored. */
export function acceptedEncodings(header: string | undefined): Set<string> {
  return new Set(
    (header ?? '')
      .split(',')
      .map((part) => part.split(';')[0]!.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface SpaFallback {
  /** The strong ETag of the plain HTML (the variants derive theirs from it). */
  readonly etag: string;
  /** Answer the application's HTML for a route the build has no file for. */
  respond(c: Context): Response;
}

/**
 * The application's HTML under any route the build has no file for, served
 * with the two things the bare `c.html()` lacked (the tier 1 verifier's two
 * caveats, PRDCT-3584): a strong `ETag` so `no-cache` means "revalidate"
 * (a `304` costs no bytes), and the `.br` / `.gz` sibling of `index.html`
 * when the build wrote one and the request accepts it, so a deep link costs
 * the same as the root on a front that compresses nothing (Cloud Run, a
 * self-hosted instance with no proxy). The HTML is read once at boot, like
 * `indexHtml` itself.
 */
export async function loadSpaFallback(publicDir: string, html: string): Promise<SpaFallback> {
  const plain = Buffer.from(html, 'utf8');
  const etag = `"${createHash('sha256').update(plain).digest('base64url').slice(0, 27)}"`;
  const variants = new Map<FallbackEncoding, Buffer>();
  for (const { name, ext } of FALLBACK_ENCODINGS) {
    try {
      variants.set(name, await readFile(join(publicDir, `index.html${ext}`)));
    } catch {
      // no sibling of that encoding: the plain HTML answers those requests
    }
  }
  return {
    etag,
    respond(c) {
      const accepted = acceptedEncodings(c.req.header('accept-encoding'));
      const encoding = FALLBACK_ENCODINGS.find((e) => accepted.has(e.name) && variants.has(e.name))?.name;
      // One validator per representation: a cached brotli body is never
      // confirmed against a plain one.
      const variantEtag = encoding ? etag.replace(/"$/, `-${encoding}"`) : etag;
      // The type rides the 304 too: the node server would otherwise stamp a
      // text/plain default on it (verifier round 2), and RFC 9110 allows the
      // 304 to repeat what the 200 carries.
      const headers: Record<string, string> = {
        'Cache-Control': REVALIDATE_CACHE_CONTROL,
        'Content-Type': 'text/html; charset=utf-8',
        ETag: variantEtag,
        Vary: 'Accept-Encoding'
      };
      if (c.req.header('if-none-match') === variantEtag) {
        return c.body(null, 304, headers);
      }
      if (encoding) headers['Content-Encoding'] = encoding;
      const body = encoding ? variants.get(encoding)! : plain;
      return c.body(new Uint8Array(body), 200, headers);
    }
  };
}
