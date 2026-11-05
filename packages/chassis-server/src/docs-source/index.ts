import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { parse as parseYaml } from 'yaml';
import type { DocsSourceGroup, DocsSourceManifest } from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';

/**
 * The docs source (PRDCT-4098): a tool's image carries its `docs/` folder
 * (the PUBLIC pages, by the template's own contract) and the chassis answers
 * it on two public, read-only routes, so a reader on the stack network (the
 * Handbook) reads every tool's docs live:
 *
 *   GET /docs-source               the manifest (`docsSourceManifestSchema`)
 *   GET /docs-source/pages/<path>  a page's raw markdown, for a path nav.yml lists
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

/** `Cache-Control` of an answer: public, five minutes. */
export const DOCS_SOURCE_CACHE_CONTROL = 'public, max-age=300';

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
      if (!inside(dir, file)) continue;
      let markdown: string;
      try {
        markdown = await readFile(file, 'utf8');
      } catch {
        logger.warn({ file }, 'docs source: a page nav.yml lists does not exist; left out of the manifest');
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

function notFound(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
  return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

/**
 * The routes. Every method and every path under `/docs-source` is answered
 * here (a 404 when it is not one of the two reads), so nothing under it falls
 * through to the dashboard's fallback. The wall is the chassis's own
 * per-address bucket. No cookie is read, no audit row is written.
 */
export function docsSourceRoutes(
  source: DocsSource | null,
  facts: { version: string; slug: string },
  wall: MiddlewareHandler
): Hono {
  const app = new Hono();
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

  // One wall for both: Hono's `/docs-source/*` matches `/docs-source` itself,
  // so a second `use` on the bare path would charge the manifest twice.
  app.use('/docs-source/*', wall);
  app.get('/docs-source', (c) => {
    if (!manifest) return notFound(c);
    c.header('Cache-Control', DOCS_SOURCE_CACHE_CONTROL);
    c.header('x-content-type-options', 'nosniff');
    return c.json(manifest);
  });
  app.get('/docs-source/pages/*', (c) => {
    // The exact path as requested, looked up in the set nav.yml listed: an
    // encoded slash, a dot segment or a `.md` suffix is simply not a key.
    const path = c.req.path.startsWith(PREFIX) ? c.req.path.slice(PREFIX.length) : '';
    const markdown = source?.pages.get(path);
    if (markdown === undefined) return notFound(c);
    c.header('Cache-Control', DOCS_SOURCE_CACHE_CONTROL);
    c.header('x-content-type-options', 'nosniff');
    c.header('content-security-policy', "default-src 'none'; sandbox");
    return c.body(markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });
  app.all('/docs-source', notFound);
  app.all('/docs-source/*', notFound);
  return app;
}
