import { existsSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { parse as parseYaml } from 'yaml';
import type { DocsSourceGroup, DocsSourceManifest } from '@antasphere/chassis-contract';
import { constantTimeEquals } from '../constant-time.js';
import type { Logger } from '../logger.js';

/**
 * The docs source (PRDCT-4098): a tool's image carries its `docs/` folder and
 * the chassis answers it on two read-only routes, so a reader on the stack
 * network (the Handbook) reads every tool's docs live:
 *
 *   GET /docs-source               the manifest (`docsSourceManifestSchema`)
 *   GET /docs-source/pages/<path>  a page's raw markdown, for a path nav.yml lists
 *
 * These are INTERNAL tools' docs (Romain, 5 November 2026), so the route is
 * unreachable from outside by three guards, each sufficient alone, in order:
 *  1. a request carrying a proxy header (`PROXY_HEADERS`) answers the 404,
 *     before anything else: only a direct network peer is ever served (the
 *     reader calls `http://<slug>:3000`, no front in the path; a front always
 *     sets one of them). Its presence counts, not its value, and `TRUST_PROXY`
 *     plays no part;
 *  2. `DOCS_SOURCE_TOKEN` unset: the route is off, every path under it
 *     answers the 404 and the folder is never read;
 *  3. set: `Authorization: Bearer <token>`, compared in constant time; any
 *     other answer is a bare 401, before the lookup.
 * The 404 is ONE answer (`notFound`), whichever guard or lookup gave it, so a
 * probe learns nothing. Every answer is `private, no-store`, no cookie is read,
 * no audit row written; the per-address wall sits after guard 2.
 *
 * The folder is read ONCE at boot and held in memory (it is immutable in an
 * image). A request never reaches the disk: a page is looked up by its exact
 * path in the set nav.yml listed, so no request can name a file outside it.
 * No folder = both routes answer 404 and the boot logs one line; a malformed
 * nav.yml or a listed page the folder lacks is a boot warning naming the file,
 * and the route serves what it could read.
 */

/** What the boot read: the manifest without the instance's facts, and the pages by path. */
export interface DocsSource {
  dir: string;
  product: string;
  description: string;
  groups: DocsSourceGroup[];
  pages: ReadonlyMap<string, string>;
}

/** `Cache-Control` of every answer: never kept by anyone. */
export const DOCS_SOURCE_CACHE_CONTROL = 'private, no-store';

/** The headers a front (a reverse proxy, a CDN) sets: any one of them present refuses the request (guard 1). */
export const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'via'
] as const;

/**
 * Where the docs folder is: `DOCS_DIR` when set, else beside the dashboard
 * build (`publicDir/../docs`: `/app/docs` next to `/app/public` in the image),
 * else the workspace's root `docs/` (three levels up from `apps/server/public`,
 * the same root `findMigrationsFolder` reaches from `apps/server/src`). Null
 * when none is a directory. An explicit `DOCS_DIR` is the only candidate.
 */
export function findDocsDir(publicDir: string, override?: string): string | null {
  const candidates = override ? [override] : [join(publicDir, '../docs'), join(publicDir, '../../../docs')];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return resolve(c);
    } catch {
      // unreadable: not a candidate
    }
  }
  return null;
}

/**
 * A nav.yml page entry the chassis accepts: slash-separated segments of
 * letters, digits, `.`, `_` and `-`, none starting with a dot (so no `..`, no
 * hidden file), no leading or trailing slash. nav.yml is the tool's own file,
 * but the boot reads only what this shape allows.
 */
const PAGE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export function isDocsPagePath(path: string): boolean {
  return PAGE_PATH.test(path) && path.length <= 200;
}

/** Inline markdown flattened to text: the public docs site's `stripInlineMd`. */
function stripInlineMd(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A page's title and description, by the public docs site's source page
 * contract (`sync.mjs`): the title is the leading H1 (nothing but blank lines
 * before it), the description is the first prose paragraph after it, stopped
 * at a heading, a fence, a table, a list, a quote or a tag. Null when the page
 * does not start with an H1.
 */
export function pageMeta(markdown: string): { title: string; description: string } | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 === -1 || lines.slice(0, h1).some((l) => l.trim() !== '')) return null;
  const title = lines[h1]!.replace(/^#\s+/, '').trim();
  const para: string[] = [];
  for (const line of lines.slice(h1 + 1)) {
    const t = line.trim();
    if (t === '') {
      if (para.length) break;
      continue;
    }
    if (/^(#|```|~~~|\||[-*+] |> |\d+\. |<)/.test(t)) break;
    para.push(t);
  }
  return { title, description: stripInlineMd(para.join(' ')) };
}

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * Read the docs folder once: nav.yml, then every page it lists. Null when the
 * folder is absent or nav.yml cannot be read or parsed at all (logged).
 */
export async function loadDocsSource(dir: string | null, logger: Logger): Promise<DocsSource | null> {
  if (!dir) {
    logger.info('no docs folder in this image: /docs-source answers 404');
    return null;
  }
  const navFile = join(dir, 'nav.yml');
  let nav: unknown;
  try {
    nav = parseYaml(await readFile(navFile, 'utf8'));
  } catch (err) {
    logger.warn(
      { err, file: navFile },
      'docs source: nav.yml cannot be read or parsed; /docs-source answers 404'
    );
    return null;
  }
  if (typeof nav !== 'object' || nav === null || Array.isArray(nav)) {
    logger.warn({ file: navFile }, 'docs source: nav.yml is not a mapping; /docs-source answers 404');
    return null;
  }
  const n = nav as Record<string, unknown>;
  const text = (key: string): string => {
    const v = n[key];
    if (typeof v === 'string') return v;
    logger.warn({ file: navFile, key }, `docs source: nav.yml has no string \`${key}\`; served as empty`);
    return '';
  };
  const product = text('product');
  const description = text('description');

  const rawGroups = Array.isArray(n.groups) ? n.groups : [];
  if (!Array.isArray(n.groups)) {
    logger.warn({ file: navFile }, 'docs source: nav.yml has no `groups` list; the manifest has no group');
  }
  const realDir = await realpath(dir);
  const pages = new Map<string, string>();
  const groups: DocsSourceGroup[] = [];
  for (const [i, raw] of rawGroups.entries()) {
    const g = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof g.title !== 'string' || !Array.isArray(g.pages)) {
      logger.warn(
        { file: navFile, group: i },
        'docs source: a nav.yml group without a string `title` and a `pages` list is skipped'
      );
      continue;
    }
    const group: DocsSourceGroup = { title: g.title, pages: [] };
    for (const entry of g.pages) {
      if (typeof entry !== 'string' || !isDocsPagePath(entry)) {
        logger.warn(
          { file: navFile, group: g.title, entry },
          'docs source: a nav.yml page entry that is not a plain page path is skipped'
        );
        continue;
      }
      if (pages.has(entry)) {
        logger.warn(
          { file: navFile, page: entry },
          'docs source: a page nav.yml lists twice is served once, at its first place'
        );
        continue;
      }
      const file = join(dir, `${entry}.md`);
      // Where the file really is: a link inside the folder is a page like any
      // other, a link pointing out of it is not served (round 1, F2).
      let real: string;
      try {
        real = await realpath(file);
      } catch {
        logger.warn({ file }, 'docs source: a page nav.yml lists does not exist; left out of the manifest');
        continue;
      }
      if (!inside(realDir, real)) {
        logger.warn(
          { file, real },
          'docs source: a page points outside the docs folder; left out of the manifest'
        );
        continue;
      }
      let markdown: string;
      try {
        markdown = await readFile(real, 'utf8');
      } catch {
        logger.warn({ file }, 'docs source: a page nav.yml lists cannot be read; left out of the manifest');
        continue;
      }
      const meta = pageMeta(markdown);
      if (!meta) {
        logger.warn({ file }, 'docs source: a page does not start with an H1; its title is its path');
      }
      pages.set(entry, markdown);
      group.pages.push({ path: entry, title: meta?.title ?? entry, description: meta?.description ?? '' });
    }
    groups.push(group);
  }
  logger.info({ dir, pages: pages.size }, 'docs source read');
  return { dir, product, description, groups, pages };
}

/**
 * What the boot does with the docs (PRDCT-4098, round 1 F3): with no token
 * the route is off and the folder is NOT read, not even looked for; with one,
 * the folder is found and read once.
 */
export async function docsSourceAtBoot(opts: {
  token: string | undefined;
  publicDir: string;
  override: string | undefined;
  logger: Logger;
}): Promise<DocsSource | null> {
  if (!opts.token) {
    opts.logger.info('docs source off: DOCS_SOURCE_TOKEN is unset, /docs-source answers 404');
    return null;
  }
  return loadDocsSource(findDocsDir(opts.publicDir, opts.override), opts.logger);
}

/** The one 404, byte for byte, whatever gave it (a guard, an unlisted path, no folder). */
function notFound(c: Context) {
  return c.body(NOT_FOUND_BODY, 404, NOT_FOUND_HEADERS);
}
const NOT_FOUND_BODY = JSON.stringify({ error: { code: 'not_found', message: 'Not found' } });
const NOT_FOUND_HEADERS = {
  'content-type': 'application/json',
  'cache-control': DOCS_SOURCE_CACHE_CONTROL,
  'x-content-type-options': 'nosniff'
};

function unauthorized(c: Context) {
  return c.body(null, 401, {
    'cache-control': DOCS_SOURCE_CACHE_CONTROL,
    'x-content-type-options': 'nosniff',
    'www-authenticate': 'Bearer'
  });
}

/**
 * The routes. Every method and every path under `/docs-source` is answered
 * here (the 404 when it is not one of the two reads), so nothing under it
 * falls through to the dashboard's fallback, whether the route is on or off.
 * `token` is `DOCS_SOURCE_TOKEN` (undefined = off); `wall` the chassis's own
 * per-address bucket.
 */
export function docsSourceRoutes(
  source: DocsSource | null,
  facts: { version: string; slug: string },
  guard: { token: string | undefined; wall: MiddlewareHandler }
): Hono {
  const app = new Hono();
  const { token, wall } = guard;
  // Hono's `/docs-source/*` matches `/docs-source` itself: one `use` covers both
  // paths (a second one on the bare path would run every guard twice).
  app.use('/docs-source/*', async (c, next) => {
    // Guard 1: a proxy header present, whatever its value.
    if (PROXY_HEADERS.some((h) => c.req.header(h) !== undefined)) return notFound(c);
    // Guard 2: off unless configured.
    if (!token) return notFound(c);
    return next();
  });
  // Off: the guard above answers every request under the path; nothing else to mount.
  if (!token) return app;
  const expected = `Bearer ${token}`;
  // The wall's own 429 is the shared one; it leaves here never kept either (round 1, F1).
  app.use('/docs-source/*', async (c, next) => {
    // Called directly, the wall hands back its own answer (the 429) or nothing
    // once the chain below has answered; the 429 is returned with the header.
    const answer = await wall(c, next);
    if (answer && answer.status === 429) answer.headers.set('cache-control', DOCS_SOURCE_CACHE_CONTROL);
    return answer;
  });
  // Guard 3: the bearer, in constant time, before any lookup.
  app.use('/docs-source/*', async (c, next) => {
    const presented = c.req.header('authorization');
    if (presented === undefined || !constantTimeEquals(presented, expected)) return unauthorized(c);
    return next();
  });

  const manifest: DocsSourceManifest | null = source
    ? {
        product: source.product,
        description: source.description,
        version: facts.version,
        slug: facts.slug,
        groups: source.groups
      }
    : null;
  const PREFIX = '/docs-source/pages/';
  app.get('/docs-source', (c) => {
    if (!manifest) return notFound(c);
    c.header('cache-control', DOCS_SOURCE_CACHE_CONTROL);
    c.header('x-content-type-options', 'nosniff');
    return c.json(manifest);
  });
  app.get('/docs-source/pages/*', (c) => {
    // The exact path as requested, looked up in the set nav.yml listed: an
    // encoded slash, a dot segment or a `.md` suffix is simply not a key.
    const path = c.req.path.startsWith(PREFIX) ? c.req.path.slice(PREFIX.length) : '';
    const markdown = source?.pages.get(path);
    if (markdown === undefined) return notFound(c);
    return c.body(markdown, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': DOCS_SOURCE_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox"
    });
  });
  app.all('/docs-source/*', notFound);
  return app;
}
