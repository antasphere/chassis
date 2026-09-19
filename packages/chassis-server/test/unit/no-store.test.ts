import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '@antasphere/chassis-contract';
import { noStoreAuthenticated } from '@antasphere/chassis-server/middleware';

/**
 * DASH-5: authenticated JSON went out with no Cache-Control at all, leaving
 * the decision to heuristic caching in whatever proxy or bfcache sits in the
 * path — one member's roster served to the next.
 */
const principal = { userId: 'u1', via: 'session' } as unknown as Principal;

function app(withPrincipal: boolean) {
  const a = new Hono();
  a.use('*', noStoreAuthenticated());
  a.use('*', async (c, next) => {
    c.set('principal', withPrincipal ? principal : null);
    return next();
  });
  a.get('/me', (c) => c.json({ user: 'u1' }));
  a.get('/instance', (c) => {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ name: 'demo' });
  });
  a.get('/files/1/content', (c) => c.body('bytes', 200, { 'content-type': 'application/octet-stream' }));
  return a;
}

describe('noStoreAuthenticated', () => {
  it('marks authenticated JSON no-store', async () => {
    const res = await app(true).request('/me');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves anonymous responses cacheable', async () => {
    const res = await app(false).request('/me');
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('never clobbers a Cache-Control the route chose', async () => {
    const res = await app(true).request('/instance');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('leaves streamed byte responses alone (Range/ETag surfaces own their headers)', async () => {
    const res = await app(true).request('/files/1/content');
    expect(res.headers.get('cache-control')).toBeNull();
  });
});
