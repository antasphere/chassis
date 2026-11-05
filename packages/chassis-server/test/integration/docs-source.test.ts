import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { docsSourceManifestSchema } from '@antasphere/chassis-contract';
import { createDatabase, createTestApp, startPostgres, type TestApp, host } from './helpers.js';

/**
 * The docs source through the whole app (PRDCT-4098): the chassis mounts it
 * on every tool, before the tool's public routes and the dashboard fallback,
 * anonymous, with the instance's version and the identity's slug. Pinned
 * against a fixture folder named by DOCS_DIR (so the host's own docs, if it
 * has any, never decide the result), and against a DOCS_DIR that does not
 * exist: an instance without docs boots and answers 404, never the dashboard.
 */

let container: StartedPostgreSqlContainer;
let fixture = '';

beforeAll(async () => {
  container = await startPostgres();
  fixture = await mkdtemp(join(tmpdir(), 'docs-source-int-'));
  await mkdir(join(fixture, 'guides'), { recursive: true });
  await writeFile(
    join(fixture, 'nav.yml'),
    'product: Fixture\ndescription: The fixture docs.\ngroups:\n  - title: Start\n    pages: [index, guides/first]\n'
  );
  await writeFile(join(fixture, 'index.md'), '# Fixture\n\nThe fixture tool.\n');
  await writeFile(join(fixture, 'guides/first.md'), '# First guide\n\nRead me first.\n');
});

afterAll(async () => {
  await container?.stop();
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('with a docs folder', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'docs_source'), {
      DOCS_DIR: fixture,
      APP_VERSION: '7.7.7-docs'
    });
  }, 120_000);
  afterAll(async () => {
    await app?.stop();
  });

  it('answers the manifest anonymously, with the version and the slug', async () => {
    const res = await app.app.request('/docs-source');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = docsSourceManifestSchema.parse(await res.json());
    expect(body).toEqual({
      product: 'Fixture',
      description: 'The fixture docs.',
      version: '7.7.7-docs',
      slug: host.identity.slug,
      groups: [
        {
          title: 'Start',
          pages: [
            { path: 'index', title: 'Fixture', description: 'The fixture tool.' },
            { path: 'guides/first', title: 'First guide', description: 'Read me first.' }
          ]
        }
      ]
    });
  });

  it('answers a listed page as markdown', async () => {
    const res = await app.app.request('/docs-source/pages/guides/first');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('# First guide\n\nRead me first.\n');
  });

  it('answers 404 JSON, never the dashboard, for anything else under the path', async () => {
    for (const url of [
      '/docs-source/pages/nope',
      '/docs-source/pages/../package.json',
      '/docs-source/pages/nav.yml',
      '/docs-source/whatever',
      '/docs-source/'
    ]) {
      const res = await app.app.request(url);
      expect(res.status, url).toBe(404);
      expect(res.headers.get('content-type'), url).toContain('application/json');
    }
  });
});

describe('without a docs folder', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'docs_source_none'), {
      DOCS_DIR: join(fixture, 'not-there')
    });
  }, 120_000);
  afterAll(async () => {
    await app?.stop();
  });

  it('boots, and both paths answer 404 JSON', async () => {
    expect((await app.app.request('/healthz')).status).toBe(200);
    for (const url of ['/docs-source', '/docs-source/pages/index']) {
      const res = await app.app.request(url);
      expect(res.status, url).toBe(404);
      expect(res.headers.get('content-type'), url).toContain('application/json');
    }
  });
});
