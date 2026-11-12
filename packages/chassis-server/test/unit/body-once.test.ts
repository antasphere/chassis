import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { readRequestBodyOnce, readResponseBodyOnce } from '../../src/middleware/body-once.js';
import { authBodyGuard } from '../../src/middleware/auth-body.js';
import { jsonDepthLimit } from '../../src/middleware/json-depth.js';
import { emailKeyOf } from '../../src/middleware/rate-limit.js';

/**
 * A body read by a middleware must still be whole for the next reader after
 * a garbage collection (PRDCT-4441). Node's fetch cancels a request's or a
 * response's body once a CLONE of it is collected, if the original is not
 * read yet; under memory pressure that turned valid JSON into 400
 * `invalid_json` (the workspace-create burst's flake in a tool's forced
 * suite). Each test forces real collections between the middleware's read
 * and the next one, which makes the old `clone()` reads fail every time.
 */

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Several full collections, with turns of the event loop for the finalizers. */
async function collect(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const afterCollections: MiddlewareHandler = async (_c, next) => {
  await collect();
  await next();
};

const postJson = (body: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body
});

describe('the platform, under the collection the bug needs', () => {
  it('a clone() read then a collection loses the original body (the fault this file guards)', async () => {
    const raw = new Request('http://local/x', postJson('{"name":"a"}'));
    await raw.clone().text();
    await collect();
    await expect(raw.text()).rejects.toThrow(/unusable|already been read/i);
  });
});

describe('a body read once is still whole after a collection', () => {
  it('the JSON depth cap: the route still parses the body', async () => {
    const app = new Hono();
    app.use('*', jsonDepthLimit());
    app.use('*', afterCollections);
    app.post('/x', async (c) => c.json(await c.req.json()));
    const res = await app.request('/x', postJson('{"name":"Ada","deep":{"a":[1,2]}}'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Ada', deep: { a: [1, 2] } });
  });

  it('the auth body guard: the mount still reads the request it is handed', async () => {
    const app = new Hono();
    app.use('*', authBodyGuard());
    app.use('*', afterCollections);
    app.post('/x', async (c) => new Response(await c.req.raw.text()));
    const res = await app.request('/x', postJson('{"email":"ada@example.test"}'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"email":"ada@example.test"}');
  });

  it('the login email key: the request is still readable after it', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      expect(await emailKeyOf(c)).toEqual(['email:ada@example.test']);
      await next();
    });
    app.use('*', afterCollections);
    app.post('/x', async (c) => new Response(await c.req.raw.text()));
    const res = await app.request('/x', postJson('{"email":" Ada@Example.test "}'));
    expect(await res.text()).toBe('{"email":" Ada@Example.test "}');
  });

  it('keeps the bytes exact, including ones that are not valid UTF-8', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const app = new Hono();
    app.use('*', async (c, next) => {
      await readRequestBodyOnce(c);
      await next();
    });
    app.use('*', afterCollections);
    app.post('/x', async (c) => new Response(await c.req.raw.arrayBuffer()));
    const res = await app.request('/x', { method: 'POST', body: bytes });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('a bodyless request reads as null and stays bodyless', async () => {
    const app = new Hono();
    app.get('/x', async (c) =>
      c.json({ body: await readRequestBodyOnce(c), still: c.req.raw.body === null })
    );
    expect(await (await app.request('/x')).json()).toEqual({ body: null, still: true });
  });
});

describe('a response read once', () => {
  it('hands on a response with the same bytes, status and headers, whole after a collection', async () => {
    const original = new Response('{"id":"w1"}', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'x-request-id': 'r1' }
    });
    const { text, response } = await readResponseBodyOnce(original);
    await collect();
    expect(text).toBe('{"id":"w1"}');
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('x-request-id')).toBe('r1');
    expect(await response.text()).toBe('{"id":"w1"}');
  });

  it('a null-body status stays bodyless', async () => {
    const { text, response } = await readResponseBodyOnce(new Response(null, { status: 204 }));
    expect(text).toBe('');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe('no body is cloned anywhere in the server', () => {
  it('src holds no clone() of a request or a response', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          // Code only: the comments that explain the rule may name it.
          const code = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          if (/\.clone\(\)/.test(code)) offenders.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
