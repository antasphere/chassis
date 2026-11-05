import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { docsSourceManifestSchema } from '@antasphere/chassis-contract';
import {
  DOCS_SOURCE_CACHE_CONTROL,
  docsSourceAtBoot,
  docsSourceRoutes,
  findDocsDir,
  isDocsPagePath,
  loadDocsSource,
  pageMeta
} from '../../src/docs-source/index.js';
import { rateLimit } from '../../src/middleware/rate-limit.js';
import type { Logger } from '../../src/logger.js';

/**
 * The docs source (PRDCT-4098): the manifest read from nav.yml with each
 * page's H1 and intro, a listed page's raw markdown, a 404 for everything
 * else (unlisted, traversal, encoded, absent folder), the boot warnings that
 * name the file, and the route's own per-address wall.
 */

function logger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return log as unknown as Logger & typeof log;
}

const open: MiddlewareHandler = async (_c, next) => next();
const FACTS = { version: '9.8.7', slug: 'testtool' };

function docsFolder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-source-'));
  const dir = join(root, 'docs');
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  }
  mkdirSync(dir, { recursive: true });
  // A file beside the folder a traversal would aim at.
  writeFileSync(join(root, 'package.json'), '{"name":"secret"}');
  return dir;
}

const NAV = `product: Test Tool
description: A tool for tests.
groups:
  - title: Getting started
    pages:
      - index
      - getting-started/connect
  - title: Reference
    pages:
      - reference/env
`;

const PAGES = {
  'index.md':
    '# Test Tool\n\nTest Tool is a tool. It has [docs](concepts/x.md) and `code`.\n\n## More\n\nBody.\n',
  'getting-started/connect.md': '# Connect an agent\n\nOne **bold** sentence\nover two lines.\n\n- a list\n',
  'reference/env.md': '# Environment\n\n| Key | Value |\n|---|---|\n',
  // On disk but not in nav.yml: never served.
  'internal.md': '# Internal\n\nNot listed.\n'
};

const TOKEN = 'docs-source-test-token-0123456789abcdef';
const BEARER = { authorization: `Bearer ${TOKEN}` };

/** The routes with the token set, and a `request` that presents it (`raw` presents nothing). */
function withToken(hono: Hono) {
  return {
    raw: hono,
    request: (url: string, init: RequestInit = {}) =>
      hono.request(url, { ...init, headers: { ...BEARER, ...(init.headers as Record<string, string>) } })
  };
}

async function serve(files: Record<string, string>, wall: MiddlewareHandler = open) {
  const dir = docsFolder(files);
  const log = logger();
  const source = await loadDocsSource(dir, log);
  return { app: withToken(docsSourceRoutes(source, FACTS, { token: TOKEN, wall })), log, dir };
}

describe('GET /docs-source: the manifest', () => {
  it('answers nav.yml with each page title and intro, the version and the slug, in the contract shape', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    const res = await app.request('/docs-source');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(DOCS_SOURCE_CACHE_CONTROL);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = docsSourceManifestSchema.parse(await res.json());
    expect(body).toEqual({
      product: 'Test Tool',
      description: 'A tool for tests.',
      version: '9.8.7',
      slug: 'testtool',
      groups: [
        {
          title: 'Getting started',
          pages: [
            { path: 'index', title: 'Test Tool', description: 'Test Tool is a tool. It has docs and code.' },
            {
              path: 'getting-started/connect',
              title: 'Connect an agent',
              description: 'One bold sentence over two lines.'
            }
          ]
        },
        { title: 'Reference', pages: [{ path: 'reference/env', title: 'Environment', description: '' }] }
      ]
    });
  });

  it('reads no cookie and sets none', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    const res = await app.request('/docs-source', { headers: { cookie: 'session=x' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /docs-source/pages/<path>', () => {
  it('answers a listed page as markdown, nested paths included', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    for (const [path, file] of [
      ['index', 'index.md'],
      ['getting-started/connect', 'getting-started/connect.md']
    ] as const) {
      const res = await app.request(`/docs-source/pages/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe(DOCS_SOURCE_CACHE_CONTROL);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // A browser that ever reaches a page runs nothing from it (round 1, F5).
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(await res.text()).toBe(PAGES[file]);
    }
  });

  it.each([
    ['an unlisted page on disk', '/docs-source/pages/internal'],
    ['a page that does not exist', '/docs-source/pages/nope'],
    ['the .md suffix', '/docs-source/pages/index.md'],
    ['nav.yml itself', '/docs-source/pages/nav.yml'],
    ['nav itself', '/docs-source/pages/nav'],
    ['a dot-dot segment', '/docs-source/pages/../package.json'],
    ['a dot-dot under a listed folder', '/docs-source/pages/getting-started/../../package'],
    ['an encoded dot-dot', '/docs-source/pages/%2e%2e/package'],
    ['an encoded slash', '/docs-source/pages/getting-started%2Fconnect'],
    ['a trailing slash', '/docs-source/pages/index/'],
    ['the pages root', '/docs-source/pages/'],
    ['the pages root without slash', '/docs-source/pages'],
    ['a backslash', '/docs-source/pages/..%5Cpackage'],
    ['an absolute path', '/docs-source/pages//etc/passwd'],
    ['an unknown sibling', '/docs-source/other'],
    ['a trailing slash on the manifest', '/docs-source/']
  ])('answers 404 for %s', async (_what, url) => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    const res = await app.request(url);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('answers 404 to every other method, on both paths', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await app.request('/docs-source', { method })).status).toBe(404);
      expect((await app.request('/docs-source/pages/index', { method })).status).toBe(404);
    }
  });
});

describe('the folder', () => {
  it('absent: both routes answer 404 and the boot logs one line', async () => {
    const log = logger();
    const source = await loadDocsSource(null, log);
    expect(source).toBeNull();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const app = withToken(docsSourceRoutes(source, FACTS, { token: TOKEN, wall: open }));
    expect((await app.request('/docs-source')).status).toBe(404);
    expect((await app.request('/docs-source/pages/index')).status).toBe(404);
  });

  it('a folder without nav.yml: 404 and a warning naming the file', async () => {
    const { app, log, dir } = await serve({ 'index.md': '# X\n' });
    expect((await app.request('/docs-source')).status).toBe(404);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml') }),
      expect.any(String)
    );
  });

  it('a nav.yml that does not parse: 404 and a warning naming the file', async () => {
    const { app, log, dir } = await serve({ 'nav.yml': 'product: [unclosed\n  - : :', ...PAGES });
    expect((await app.request('/docs-source')).status).toBe(404);
    expect((await app.request('/docs-source/pages/index')).status).toBe(404);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml') }),
      expect.any(String)
    );
  });

  it('a nav.yml that is a list: 404 and a warning naming the file', async () => {
    const { app, log, dir } = await serve({ 'nav.yml': '- index\n', ...PAGES });
    expect((await app.request('/docs-source')).status).toBe(404);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml') }),
      expect.any(String)
    );
  });

  it('partly malformed: serves what it could read, warns for each part it skipped', async () => {
    const nav = `product: Partial
groups:
  - title: Good
    pages:
      - index
      - missing-page
      - ../package
      - 42
      - index
  - pages: [index]
  - title: Also good
    pages:
      - getting-started/connect
`;
    const { app, log, dir } = await serve({ 'nav.yml': nav, ...PAGES });
    const res = await app.request('/docs-source');
    expect(res.status).toBe(200);
    const body = docsSourceManifestSchema.parse(await res.json());
    expect(body.description).toBe('');
    expect(body.groups.map((g) => [g.title, g.pages.map((p) => p.path)])).toEqual([
      ['Good', ['index']],
      ['Also good', ['getting-started/connect']]
    ]);
    // The missing page is named by its file; the description key by nav.yml.
    expect(log.warn).toHaveBeenCalledWith({ file: join(dir, 'missing-page.md') }, expect.any(String));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml'), key: 'description' }),
      expect.any(String)
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml'), entry: '../package' }),
      expect.any(String)
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml'), entry: 42 }),
      expect.any(String)
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml'), group: 1 }),
      expect.any(String)
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'nav.yml'), page: 'index' }),
      expect.any(String)
    );
    // The refused entry is never served, even though its file exists one level up.
    expect((await app.request('/docs-source/pages/../package')).status).toBe(404);
  });

  it('a group whose pages are all missing keeps its place, empty', async () => {
    const nav = 'product: P\ndescription: D\ngroups:\n  - title: Empty\n    pages: [gone]\n';
    const { app } = await serve({ 'nav.yml': nav });
    const body = docsSourceManifestSchema.parse(await (await app.request('/docs-source')).json());
    expect(body.groups).toEqual([{ title: 'Empty', pages: [] }]);
  });

  it('a page without a leading H1: its path is its title, with a warning naming the file', async () => {
    const nav = 'product: P\ndescription: D\ngroups:\n  - title: G\n    pages: [plain]\n';
    const { app, log, dir } = await serve({ 'nav.yml': nav, 'plain.md': 'No heading here.\n' });
    const body = docsSourceManifestSchema.parse(await (await app.request('/docs-source')).json());
    expect(body.groups[0]!.pages).toEqual([{ path: 'plain', title: 'plain', description: '' }]);
    expect(log.warn).toHaveBeenCalledWith({ file: join(dir, 'plain.md') }, expect.any(String));
    expect((await app.request('/docs-source/pages/plain')).status).toBe(200);
  });

  it('is read once: a page changed on disk after the boot is served as it was', async () => {
    const { app, dir } = await serve({ 'nav.yml': NAV, ...PAGES });
    writeFileSync(join(dir, 'index.md'), '# Changed\n');
    expect(await (await app.request('/docs-source/pages/index')).text()).toBe(PAGES['index.md']);
  });
});

describe('symlinks (round 1, F2)', () => {
  it('a listed page that is a link pointing outside the folder is left out, with a warning naming it, and never served', async () => {
    const nav = 'product: P\ndescription: D\ngroups:\n  - title: G\n    pages: [index, leak]\n';
    const dir = docsFolder({ 'nav.yml': nav, 'index.md': '# I\n' });
    writeFileSync(join(dir, '..', 'outside-secret.txt'), 'OUTSIDE-SECRET-CONTENT');
    symlinkSync(join('..', 'outside-secret.txt'), join(dir, 'leak.md'));
    const log = logger();
    const source = await loadDocsSource(dir, log);
    const app = withToken(docsSourceRoutes(source, FACTS, { token: TOKEN, wall: open }));
    const body = docsSourceManifestSchema.parse(await (await app.request('/docs-source')).json());
    expect(body.groups[0]!.pages.map((p) => p.path)).toEqual(['index']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dir, 'leak.md') }),
      expect.stringContaining('outside the docs folder')
    );
    const res = await app.request('/docs-source/pages/leak');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('OUTSIDE');
  });

  it('a link that stays inside the folder is a page like any other', async () => {
    const nav = 'product: P\ndescription: D\ngroups:\n  - title: G\n    pages: [index, alias]\n';
    const dir = docsFolder({ 'nav.yml': nav, 'index.md': '# I\n\nIntro.\n' });
    symlinkSync('index.md', join(dir, 'alias.md'));
    const log = logger();
    const source = await loadDocsSource(dir, log);
    const app = withToken(docsSourceRoutes(source, FACTS, { token: TOKEN, wall: open }));
    expect(await (await app.request('/docs-source/pages/alias')).text()).toBe('# I\n\nIntro.\n');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('docsSourceAtBoot (round 1, F3)', () => {
  it('token unset: the folder is not read at all, one info line, no warning even for a malformed nav', async () => {
    const dir = docsFolder({ 'nav.yml': 'product: [unclosed\n  - : :' });
    const log = logger();
    const source = await docsSourceAtBoot({
      token: undefined,
      publicDir: join(dir, '..', 'public'),
      override: dir,
      logger: log
    });
    expect(source).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('DOCS_SOURCE_TOKEN is unset'));
  });

  it('token set: the folder is found beside the dashboard build and read', async () => {
    const dir = docsFolder({ 'nav.yml': NAV, ...PAGES });
    const log = logger();
    const source = await docsSourceAtBoot({
      token: TOKEN,
      publicDir: join(dir, '..', 'public'),
      override: undefined,
      logger: log
    });
    expect(source?.pages.size).toBe(3);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ pages: 3 }), 'docs source read');
  });

  it('token set, no folder anywhere: null and one info line', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'docs-none-'));
    const log = logger();
    expect(
      await docsSourceAtBoot({
        token: TOKEN,
        publicDir: join(empty, 'public'),
        override: undefined,
        logger: log
      })
    ).toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no docs folder'));
  });
});

describe('findDocsDir', () => {
  it('finds the image layout beside the dashboard build, then the workspace root', () => {
    const image = mkdtempSync(join(tmpdir(), 'docs-image-'));
    mkdirSync(join(image, 'docs'));
    expect(findDocsDir(join(image, 'public'))).toBe(join(image, 'docs'));

    const repo = mkdtempSync(join(tmpdir(), 'docs-repo-'));
    mkdirSync(join(repo, 'docs'));
    mkdirSync(join(repo, 'apps/server/public'), { recursive: true });
    expect(findDocsDir(join(repo, 'apps/server/public'))).toBe(join(repo, 'docs'));
  });

  it('prefers the image layout when both exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'docs-both-'));
    mkdirSync(join(repo, 'docs'));
    mkdirSync(join(repo, 'apps/server/docs'), { recursive: true });
    expect(findDocsDir(join(repo, 'apps/server/public'))).toBe(join(repo, 'apps/server/docs'));
  });

  it('DOCS_DIR is the only candidate when set', () => {
    const repo = mkdtempSync(join(tmpdir(), 'docs-override-'));
    mkdirSync(join(repo, 'docs'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'docs-elsewhere-'));
    expect(findDocsDir(join(repo, 'public'), elsewhere)).toBe(elsewhere);
    expect(findDocsDir(join(repo, 'public'), join(elsewhere, 'missing'))).toBeNull();
  });

  it('a file is not a folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-file-'));
    writeFileSync(join(root, 'docs'), 'not a folder');
    expect(findDocsDir(join(root, 'public'))).toBeNull();
  });
});

describe('pageMeta and the page paths', () => {
  it('follows the public docs site: H1 first, the first prose paragraph, stopped at a block', () => {
    expect(pageMeta('\n# Title\n\nIntro *one*\nand two.\n\nSecond.\n')).toEqual({
      title: 'Title',
      description: 'Intro one and two.'
    });
    expect(pageMeta('# T\n\n> a quote\n')).toEqual({ title: 'T', description: '' });
    expect(pageMeta('# T\n\n```\ncode\n```\n')).toEqual({ title: 'T', description: '' });
    expect(pageMeta('# T\r\n\r\nWindows line.\r\n')).toEqual({ title: 'T', description: 'Windows line.' });
    expect(pageMeta('Text first\n# T\n')).toBeNull();
    expect(pageMeta('## Not an H1\n')).toBeNull();
  });

  it.each(['index', 'a/b', 'a-b_c.d/e', 'v1.2'])('accepts %s', (p) => expect(isDocsPagePath(p)).toBe(true));
  it.each(['', '..', '../x', 'a/../b', '/abs', 'a/', '.hidden', 'a/.b', 'a\\b', 'a//b', 'a b', 'a%2Fb'])(
    'refuses %s',
    (p) => expect(isDocsPagePath(p)).toBe(false)
  );
});

describe('the wall', () => {
  it('is per address and answers 429 once the bucket is spent, on both paths and on a 404', async () => {
    const limiter = new RateLimiterMemory({ keyPrefix: 'rl:docs-source-test', points: 3, duration: 60 });
    // A proxy header is refused before the wall, so the test keys the bucket on its own header.
    const byTestHeader = (c: Context) => c.req.header('x-test-peer') ?? 'unknown';
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES }, rateLimit(limiter, byTestHeader));
    const from = (peer: string) => ({ headers: { 'x-test-peer': peer } });
    expect((await app.request('/docs-source', from('peer-1'))).status).toBe(200);
    expect((await app.request('/docs-source/pages/index', from('peer-1'))).status).toBe(200);
    expect((await app.request('/docs-source/pages/nope', from('peer-1'))).status).toBe(404);
    const spent = await app.request('/docs-source', from('peer-1'));
    expect(spent.status).toBe(429);
    // The wall's 429 is never kept either (round 1, F1).
    expect(spent.headers.get('cache-control')).toBe('private, no-store');
    expect((await app.request('/docs-source/pages/index', from('peer-1'))).status).toBe(429);
    // A wrong token spends the bucket too: the wall stands before the token check.
    expect((await app.raw.request('/docs-source', from('peer-1'))).status).toBe(429);
    // Another peer has its own bucket.
    expect((await app.request('/docs-source', from('peer-2'))).status).toBe(200);
  });

  it('is not spent by a request a guard refused before it (a proxy header, the route off)', async () => {
    const limiter = new RateLimiterMemory({ keyPrefix: 'rl:docs-source-before', points: 1, duration: 60 });
    const { app } = await serve(
      { 'nav.yml': NAV, ...PAGES },
      rateLimit(limiter, () => 'one')
    );
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/docs-source', { headers: { via: '1.1 front' } })).status).toBe(404);
    }
    expect((await app.request('/docs-source')).status).toBe(200);
  });
});

describe('the guards', () => {
  async function notFoundBytes(res: Response) {
    return {
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort()
    };
  }

  it('token unset: every path answers the 404, with or without a bearer, and the folder is not needed', async () => {
    const app = docsSourceRoutes(null, FACTS, { token: undefined, wall: open });
    for (const url of ['/docs-source', '/docs-source/pages/index', '/docs-source/x']) {
      expect((await app.request(url)).status).toBe(404);
      expect((await app.request(url, { headers: BEARER })).status).toBe(404);
    }
  });

  it('token set: no header, a wrong scheme, one byte off, a longer or shorter token answer a bare 401', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    const offByOne = TOKEN.slice(0, -1) + (TOKEN.endsWith('f') ? 'e' : 'f');
    const tries: Array<Record<string, string>> = [
      {},
      { authorization: '' },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
      { authorization: `bearer ${TOKEN}` },
      { authorization: `Bearer ${offByOne}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer  ${TOKEN}` }
    ];
    for (const headers of tries) {
      for (const url of ['/docs-source', '/docs-source/pages/index', '/docs-source/pages/nope']) {
        const res = await app.raw.request(url, { headers });
        expect(res.status, `${url} ${JSON.stringify(headers)}`).toBe(401);
        expect(await res.text()).toBe('');
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      }
    }
  });

  it('token set: the right bearer reads', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    expect((await app.raw.request('/docs-source', { headers: BEARER })).status).toBe(200);
    expect((await app.raw.request('/docs-source/pages/index', { headers: BEARER })).status).toBe(200);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via'])(
    'the right bearer with %s answers the 404, whatever the value, before the token is read',
    async (header) => {
      const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
      for (const value of ['1.2.3.4', '', 'for=10.0.0.1']) {
        for (const url of ['/docs-source', '/docs-source/pages/index']) {
          const res = await app.request(url, { headers: { [header]: value } });
          expect(res.status, `${header}: ${value} ${url}`).toBe(404);
        }
        // Without the token too: a proxied probe never learns the route is on (no 401).
        expect((await app.raw.request('/docs-source', { headers: { [header]: value } })).status).toBe(404);
      }
    }
  );

  it('the 404 is byte-identical: proxy header, token unset, unlisted page, unknown path, no folder', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    const off = docsSourceRoutes(null, FACTS, { token: undefined, wall: open });
    const noFolder = withToken(docsSourceRoutes(null, FACTS, { token: TOKEN, wall: open }));
    const answers = await Promise.all(
      [
        app.request('/docs-source', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
        off.request('/docs-source'),
        off.request('/docs-source/pages/index', { headers: BEARER }),
        app.request('/docs-source/pages/internal'),
        app.request('/docs-source/elsewhere'),
        app.request('/docs-source', { method: 'POST' }),
        noFolder.request('/docs-source'),
        noFolder.request('/docs-source/pages/index')
      ].map(async (r) => notFoundBytes(await r))
    );
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]!.status).toBe(404);
    expect(answers[0]!.headers).toEqual([
      ['cache-control', 'private, no-store'],
      ['content-type', 'application/json'],
      ['x-content-type-options', 'nosniff']
    ]);
  });

  it('every answer is private, no-store', async () => {
    const { app } = await serve({ 'nav.yml': NAV, ...PAGES });
    for (const url of ['/docs-source', '/docs-source/pages/index', '/docs-source/pages/nope']) {
      expect((await app.request(url)).headers.get('cache-control')).toBe('private, no-store');
    }
  });
});
