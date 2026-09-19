import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerOpenApiDoc } from '@antasphere/chassis-server/api';

/**
 * PLT-3: `api.doc()` runs the whole synchronous OpenAPI generator inside the
 * request handler, on an endpoint that is unauthenticated by design and
 * therefore never reaches the per-principal quota — an anonymous event-loop
 * DoS that starves /healthz and trips the container healthcheck.
 */
function apiWithRoutes(): OpenAPIHono {
  const api = new OpenAPIHono();
  api.openapi(
    createRoute({
      method: 'get',
      path: '/things',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: z.object({ a: z.string() }) } } }
      }
    }),
    (c) => c.json({ a: 'b' }, 200)
  );
  return api;
}

const CONFIG = { openapi: '3.1.0', info: { title: 'Test API', version: '1' } };

describe('registerOpenApiDoc', () => {
  it('generates the document exactly ONCE, at registration', async () => {
    const api = apiWithRoutes();
    const spy = vi.spyOn(api, 'getOpenAPIDocument');
    registerOpenApiDoc(api, CONFIG);
    expect(spy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 25; i++) {
      const res = await api.request('/openapi.json');
      expect(res.status).toBe(200);
    }
    // Not once more, however hard it is hammered.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves a byte-identical, correctly typed, cacheable document', async () => {
    const api = apiWithRoutes();
    registerOpenApiDoc(api, CONFIG);
    const first = await api.request('/openapi.json');
    const second = await api.request('/openapi.json');
    expect(first.headers.get('content-type')).toContain('application/json');
    expect(first.headers.get('cache-control')).toBe('public, max-age=300');
    const a = await first.text();
    const b = await second.text();
    expect(a).toBe(b);
    expect(JSON.parse(a)).toMatchObject({ info: { title: 'Test API' }, paths: { '/things': {} } });
  });
});

/**
 * The other half of PLT-3, and the half `registerOpenApiDoc` alone cannot
 * prove: the API app has to actually USE it. Reverting `api/index.ts` to
 * `api.doc('/openapi.json', …)` restores the per-request generator while every
 * test above stays green, because none of them touch `api/index.ts`. Assert on
 * the source, the same way head-rewrite.test.ts guards the dead HEAD idiom.
 */
describe('the API app does not register a per-request document generator', () => {
  it('never calls api.doc() — registerOpenApiDoc is the only registration', () => {
    // The routers live in two places since the chassis extraction: the generic
    // ones here, the tool's in the app that composes it. Both are audited.
    const apiDirs = [
      join(import.meta.dirname, '../../../../apps/server/src/api'),
      join(import.meta.dirname, '../../src/api')
    ];
    const offenders: string[] = [];
    let registrations = 0;
    const files = apiDirs.flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)));
    for (const file of files) {
      // Skip the helper's own definition — we are auditing its CALLERS.
      if (!file.endsWith('.ts') || file.endsWith('/openapi-doc.ts')) continue;
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      if (/\bapi\.doc\d?\s*\(/.test(code)) offenders.push(file);
      registrations += (code.match(/registerOpenApiDoc\s*\(/g) ?? []).length;
    }
    expect(offenders).toEqual([]);
    // index.ts imports it and calls it exactly once.
    expect(registrations).toBe(1);
  });
});
