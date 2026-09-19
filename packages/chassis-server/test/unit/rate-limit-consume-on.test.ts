import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { emailKeyOf, rateLimit } from '@antasphere/chassis-server/middleware';

/**
 * AF-4: the login wall consumed its buckets on ARRIVAL, before any credential
 * was verified — and one of its keys is `email:<addr>` read straight out of
 * the request body. Ten POSTs naming a victim therefore emptied that account's
 * bucket and locked the owner out for the window, and the owner's own correct
 * sign-ins spent the same budget.
 *
 * `consumeOn: 'failure'` keeps the brute-force wall exactly as tight (a wrong
 * password IS a failure and still costs a point, an exhausted bucket still
 * 429s before the handler runs) while a successful sign-in costs nothing.
 */
const ip = () => '203.0.113.9';

function loginApp(limiter: RateLimiterMemory, consumeOn: 'arrival' | 'failure') {
  const app = new Hono();
  app.use('/sign-in', rateLimit(limiter, ip, emailKeyOf, { consumeOn }));
  app.post('/sign-in', async (c) => {
    const body = (await c.req.json()) as { email: string; password: string };
    if (body.password !== 'correct-horse') return c.json({ error: 'bad credentials' }, 401);
    return c.json({ ok: true });
  });
  return app;
}

const attempt = (app: Hono, password: string) =>
  app.request('/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'victim@example.com', password })
  });

describe('rateLimit consumeOn', () => {
  it('a SUCCESSFUL sign-in costs the account nothing', async () => {
    const limiter = new RateLimiterMemory({ points: 3, duration: 900 });
    const app = loginApp(limiter, 'failure');
    for (let i = 0; i < 10; i++) {
      const res = await attempt(app, 'correct-horse');
      expect(res.status).toBe(200);
    }
    expect(await limiter.get('email:victim@example.com')).toBeNull();
  });

  it('a FAILED sign-in still costs a point — the brute-force wall is intact', async () => {
    const limiter = new RateLimiterMemory({ points: 3, duration: 900 });
    const app = loginApp(limiter, 'failure');
    expect((await attempt(app, 'wrong')).status).toBe(401);
    expect((await attempt(app, 'wrong')).status).toBe(401);
    expect((await attempt(app, 'wrong')).status).toBe(401);
    // Fourth arrival finds an empty bucket and is refused BEFORE the handler.
    const fourth = await attempt(app, 'wrong');
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('consumeOn arrival — the old behaviour — burns the victim budget on success', async () => {
    // Pinning the contrast, so a revert to the default is loud.
    const limiter = new RateLimiterMemory({ points: 3, duration: 900 });
    const app = loginApp(limiter, 'arrival');
    for (let i = 0; i < 3; i++) expect((await attempt(app, 'correct-horse')).status).toBe(200);
    expect((await attempt(app, 'correct-horse')).status).toBe(429);
  });

  it('defaults to arrival so every other surface is unchanged', async () => {
    const limiter = new RateLimiterMemory({ points: 1, duration: 900 });
    const app = new Hono();
    app.use('/send', rateLimit(limiter, ip));
    app.post('/send', (c) => c.json({ sent: true }));
    expect((await app.request('/send', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/send', { method: 'POST' })).status).toBe(429);
  });
});
