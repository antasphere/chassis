import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  staticAssets,
  staticCacheControl
} from '@antasphere/chassis-server/middleware';

/**
 * PRDCT-3584. The dashboard build went out with no cache policy and no
 * compression, so every visit re-downloaded it. Three properties:
 *
 * 1. a content-hashed asset (`/_app/immutable/*`) is cached for a year and
 *    marked immutable; nothing else ever is;
 * 2. a precompressed sibling is served when the request accepts its
 *    encoding, with `Content-Encoding` and `Vary`, and the plain file when
 *    it does not;
 * 3. a path that is not a file falls through to the SPA fallback, which is
 *    revalidated on every use.
 */

const CHUNK = 'export const answer = 42; '.repeat(40);
let publicDir: string;
let app: Hono;

beforeAll(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'chassis-static-'));
  mkdirSync(join(publicDir, '_app', 'immutable', 'chunks'), { recursive: true });
  const chunk = join(publicDir, '_app', 'immutable', 'chunks', 'abc123.js');
  writeFileSync(chunk, CHUNK);
  writeFileSync(`${chunk}.br`, brotliCompressSync(Buffer.from(CHUNK)));
  writeFileSync(`${chunk}.gz`, gzipSync(Buffer.from(CHUNK)));
  // a hashed asset with no compressed sibling
  writeFileSync(join(publicDir, '_app', 'immutable', 'chunks', 'plain.js'), CHUNK);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(publicDir, 'favicon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  app = new Hono();
  app.use('*', staticAssets({ publicDir }));
  app.get('*', (c) => {
    c.header('Cache-Control', REVALIDATE_CACHE_CONTROL);
    return c.html('<!doctype html><title>fallback</title>');
  });
});

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

describe('staticCacheControl', () => {
  it('marks only the content-hashed prefix immutable', () => {
    expect(staticCacheControl('/_app/immutable/chunks/abc123.js')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl('/_app/immutable/entry/start.js')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl('/_app/version.json')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(staticCacheControl('/index.html')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(staticCacheControl('/favicon.png')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(staticCacheControl('/')).toBe(REVALIDATE_CACHE_CONTROL);
  });
});

describe('staticAssets', () => {
  it('serves a hashed asset immutable for a year', async () => {
    const res = await app.request('/_app/immutable/chunks/plain.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(await res.text()).toBe(CHUNK);
  });

  it('serves the brotli sibling when the request accepts br', async () => {
    const res = await app.request('/_app/immutable/chunks/abc123.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers.get('content-type')).toContain('javascript');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(brotliCompressSync(Buffer.from(CHUNK)))).toBe(true);
  });

  it('serves the gzip sibling when only gzip is accepted', async () => {
    const res = await app.request('/_app/immutable/chunks/abc123.js', {
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(gzipSync(Buffer.from(CHUNK)))).toBe(true);
  });

  it('serves the plain file when no encoding is accepted', async () => {
    const res = await app.request('/_app/immutable/chunks/abc123.js');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(CHUNK);
  });

  it('revalidates every static file outside the hashed prefix', async () => {
    const icon = await app.request('/favicon.png');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(await root.text()).toContain('<title>t</title>');
  });

  it('falls through to the SPA fallback on an application route, revalidated', async () => {
    const res = await app.request('/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(await res.text()).toContain('fallback');
  });

  it('never marks a non-hashed response immutable', async () => {
    for (const path of ['/', '/index.html', '/favicon.png', '/login', '/_app/version.json']) {
      const res = await app.request(path);
      expect(res.headers.get('cache-control'), path).not.toContain('immutable');
    }
  });
});
