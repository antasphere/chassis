import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { crossSiteGuard } from '@antasphere/chassis-server/middleware';

/**
 * BROW-2: nothing under /api/v1 checked Origin or Sec-Fetch metadata, so every
 * session-authenticated business route was drivable from any page the victim
 * had open. Better Auth's own check covers only its `/sign-in` paths.
 */
function app(): Hono {
  const api = new Hono();
  api.use('*', crossSiteGuard({ publicBaseUrl: 'https://app.example.com' }));
  api.get('/orgs', (c) => c.json({ read: true }));
  api.post('/orgs', (c) => c.json({ created: true }, 201));
  api.delete('/orgs/:id', (c) => c.json({ deleted: true }));
  api.post('/auth/oauth2/token', (c) => c.json({ token: 'x' }));
  api.post('/auth/sign-in/email', (c) => c.json({ signed: true }));
  const root = new Hono();
  root.route('/api/v1', api);
  return root;
}

const post = (headers: Record<string, string>) => app().request('/api/v1/orgs', { method: 'POST', headers });

describe('crossSiteGuard', () => {
  it('rejects a cross-site credentialed POST before the handler', async () => {
    const res = await post({
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
      cookie: 'session=abc'
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'cross_site_forbidden' } });
  });

  it('rejects an untrusted Origin even when Sec-Fetch metadata is absent (older browsers)', async () => {
    const res = await post({ origin: 'https://evil.example', cookie: 'session=abc' });
    expect(res.status).toBe(403);
  });

  it('rejects an opaque `Origin: null` (sandboxed iframe / redirected form post)', async () => {
    const res = await post({ origin: 'null', cookie: 'session=abc' });
    expect(res.status).toBe(403);
  });

  it('rejects a same-site-but-different-origin POST from a sibling subdomain', async () => {
    // Sec-Fetch-Site says `same-site`, so the cross-site arm does not fire —
    // the Origin arm must. A host-only session cookie IS sent on these.
    const res = await post({
      'sec-fetch-site': 'same-site',
      origin: 'https://marketing.example.com',
      cookie: 'session=abc'
    });
    expect(res.status).toBe(403);
  });

  it('covers every unsafe method, not just POST', async () => {
    const res = await app().request('/api/v1/orgs/1', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' }
    });
    expect(res.status).toBe(403);
  });

  it('allows the dashboard: same-origin POST with the app Origin', async () => {
    const res = await app().request('https://app.example.com/api/v1/orgs', {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        origin: 'https://app.example.com',
        cookie: 'session=abc'
      }
    });
    expect(res.status).toBe(201);
  });

  it('allows the serving origin even when it is not PUBLIC_BASE_URL (dev proxy, previews)', async () => {
    const res = await app().request('http://localhost:5173/api/v1/orgs', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }
    });
    expect(res.status).toBe(201);
  });

  it('leaves non-browser clients alone (no Origin, no Sec-Fetch)', async () => {
    const res = await post({ 'content-type': 'application/json' });
    expect(res.status).toBe(201);
  });

  it('never blocks bearer-authenticated calls — those are not ambient credentials', async () => {
    const res = await post({
      authorization: 'Bearer pk_live_something',
      origin: 'https://some-mcp-client.example',
      'sec-fetch-site': 'cross-site'
    });
    expect(res.status).toBe(201);
  });

  it('exempts the deliberate wildcard-CORS OAuth endpoints', async () => {
    const res = await app().request('/api/v1/auth/oauth2/token', {
      method: 'POST',
      headers: { origin: 'https://claude.ai', 'sec-fetch-site': 'cross-site' }
    });
    expect(res.status).toBe(200);
  });

  it('does NOT exempt the cookie-bearing auth endpoints', async () => {
    const res = await app().request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
    });
    expect(res.status).toBe(403);
  });

  it('leaves safe methods readable — CORS already stops the attacker seeing them', async () => {
    const res = await app().request('/api/v1/orgs', {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
    });
    expect(res.status).toBe(200);
  });

  describe('deniedOrigins — the viewer origin (PRDCT-1352)', () => {
    const VIEWER = 'https://decks.example.net';
    function gated(): Hono {
      const api = new Hono();
      api.use(
        '*',
        crossSiteGuard({
          publicBaseUrl: 'https://app.example.com',
          // Even listed as trusted, denial wins: an operator cannot re-open it by accident.
          extraTrustedOrigins: [VIEWER],
          deniedOrigins: [VIEWER]
        })
      );
      api.post('/orgs', (c) => c.json({ created: true }, 201));
      const root = new Hono();
      root.route('/api/v1', api);
      return root;
    }

    it('refuses the viewer origin even when it IS the serving origin', async () => {
      const res = await gated().request(`${VIEWER}/api/v1/orgs`, {
        method: 'POST',
        headers: { origin: VIEWER, 'sec-fetch-site': 'same-origin', cookie: 'session=abc' }
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'cross_site_forbidden' } });
    });

    it('refuses the viewer origin arriving at the app origin', async () => {
      const res = await gated().request('https://app.example.com/api/v1/orgs', {
        method: 'POST',
        headers: { origin: VIEWER, 'sec-fetch-site': 'cross-site', cookie: 'session=abc' }
      });
      expect(res.status).toBe(403);
    });

    it('still lets the app origin through', async () => {
      const res = await gated().request('https://app.example.com/api/v1/orgs', {
        method: 'POST',
        headers: { origin: 'https://app.example.com', 'sec-fetch-site': 'same-origin' }
      });
      expect(res.status).toBe(201);
    });
  });
});
