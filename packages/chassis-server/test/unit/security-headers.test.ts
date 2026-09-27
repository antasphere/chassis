import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { buildCsp, hstsValue, securityHeaders } from '@antasphere/chassis-server/middleware';
import { createRuntimeState } from '@antasphere/chassis-server/util';

/**
 * Two properties, and on this repo the first one is the one with scar tissue.
 *
 * 1. The baseline header middleware is a DEFAULT, never an override. The
 *    viewer serves USER-AUTHORED HTML under its own `CSP: sandbox` +
 *    `Referrer-Policy: no-referrer`; an unconditional overwrite here silently
 *    replaces that sandbox with the dashboard CSP, which is the
 *    fail-dangerous class the viewer spike caught live. HSTS is added
 *    set-if-absent for the same reason.
 * 2. PLT-28: no HSTS was sent at all. It rides EVERY response, not just HTML —
 *    the session cookie goes out on XHR too, so an http downgrade on /api/v1
 *    is the same theft.
 */

const DASHBOARD_CSP = "default-src 'self'";

function appWith(hsts: string | null = null): Hono {
  const app = new Hono();
  app.use('*', securityHeaders({ csp: DASHBOARD_CSP, state: createRuntimeState(), hsts }));
  app.get('/dashboard', (c) => c.html('<h1>app</h1>'));
  app.get('/v/abc', (c) =>
    c.body('<h1>user content</h1>', 200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': 'sandbox allow-scripts',
      'referrer-policy': 'no-referrer'
    })
  );
  return app;
}

describe('securityHeaders set-if-absent guards', () => {
  it('applies the dashboard CSP to app HTML', async () => {
    const res = await appWith().request('/dashboard');
    expect(res.headers.get('content-security-policy')).toBe(DASHBOARD_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never clobbers the viewer sandbox CSP or its referrer policy', async () => {
    const res = await appWith().request('/v/abc');
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

/**
 * PLT-28. The tool issues a session cookie for the dashboard AND a scoped
 * viewer cookie on share links; one plain-http navigation is one stolen
 * session or one stolen share unlock.
 */
describe('HSTS', () => {
  it('is absent when the instance declares an http public origin', () => {
    expect(hstsValue({ PUBLIC_BASE_URL: 'http://localhost:3000', HSTS_MAX_AGE: 15552000 })).toBeNull();
  });

  it('is armed by an https public origin', () => {
    expect(hstsValue({ PUBLIC_BASE_URL: 'https://app.example.com', HSTS_MAX_AGE: 15552000 })).toBe(
      'max-age=15552000; includeSubDomains'
    );
  });

  it('honours HSTS_MAX_AGE=0 as the operator opt-out', () => {
    expect(hstsValue({ PUBLIC_BASE_URL: 'https://app.example.com', HSTS_MAX_AGE: 0 })).toBeNull();
  });

  it('rides EVERY response, not just HTML — the cookie goes out on XHR too', async () => {
    const app = appWith('max-age=15552000; includeSubDomains');
    app.get('/api/v1/me', (c) => c.json({ ok: true }));
    const html = await app.request('/dashboard');
    expect(html.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
    const json = await app.request('/api/v1/me');
    expect(json.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
  });

  it('rides the viewer too, without touching its sandbox CSP', async () => {
    const res = await appWith('max-age=15552000; includeSubDomains').request('/v/abc');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
  });

  it('sends none when the instance is not https', async () => {
    const res = await appWith(null).request('/dashboard');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  describe('buildCsp frame-src (PRDCT-1352, DASH-4)', () => {
    it("frames only 'self' by default — the single-origin preview", () => {
      expect(buildCsp([])).toContain("frame-src 'self';");
      expect(buildCsp([])).not.toContain('decks.example.net');
    });

    it('adds the viewer origin so the dashboard preview can frame decks from it', () => {
      const csp = buildCsp(["'sha256-abc'"], { frameSrc: ['https://decks.example.net'] });
      expect(csp).toContain("frame-src 'self' https://decks.example.net;");
      // Nothing else widens: the viewer origin gets frames, not scripts or connects.
      expect(csp).toContain("script-src 'self' 'sha256-abc';");
      expect(csp).toContain("connect-src 'self';");
      expect(csp).toContain("frame-ancestors 'none';");
    });
  });

  describe('buildCsp style-src and font-src (PRDCT-2308, the two font CDNs)', () => {
    it('allows exactly the two stylesheet API hosts and the two font file hosts, nothing wider', () => {
      const csp = buildCsp([]);
      expect(csp).toContain(
        "style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com;"
      );
      expect(csp).toContain("font-src 'self' https://cdn.fontshare.com https://fonts.gstatic.com;");
      // No scheme-wide source anywhere: `https:` or `data:` on styles or fonts
      // would let any host in (verifier round 1, M12/M13).
      for (const directive of csp.split('; ')) {
        if (directive.startsWith('style-src') || directive.startsWith('font-src')) {
          expect(directive).not.toMatch(/\bhttps:(\s|$)/);
          expect(directive).not.toContain('data:');
        }
      }
      expect(csp).toContain("img-src 'self' data:;");
      // A tool's declaration widens img-src by exactly what it names (PRDCT-2725: `blob:`
      // for an image fetched through the API and shown from an object URL); the chassis
      // default carries no scheme source but data:.
      expect(buildCsp([], { imgSrc: ['blob:'] })).toContain("img-src 'self' data: blob:;");
      expect(buildCsp([], { imgSrc: ['blob:'] })).not.toMatch(/img-src[^;]*https:/);
      expect(csp).toContain("connect-src 'self';");
      expect(csp).toContain("default-src 'self';");
    });
  });
});
