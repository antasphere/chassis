import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * I3 — general per-principal API quota. The security property under test:
 * every authenticated /api/v1 request consumes from a bucket keyed by the
 * AUTHENTICATED principal identity (API-key id / session user id), so one
 * principal exhausting its quota cannot touch another's, and no
 * client-supplied header can rotate or escape a bucket. Exempt surfaces
 * (public discovery, setup, the Better-Auth routes, /healthz) stay outside
 * the quota entirely.
 */

const OWNER = { email: 'owner@quota.test', name: 'Quota Owner', password: 'quota-owner-password-1' };

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('sustained quota: isolation, threshold, headers, exemptions', () => {
  let url: string;
  let app: TestApp;
  let replica: TestApp | undefined;
  let ownerCookie: string;
  let keyA: string;
  let keyB: string;

  const quotaEnv = { API_RATE_LIMIT_PER_MINUTE: '5', API_RATE_LIMIT_BURST: '1000' };

  beforeAll(async () => {
    url = await createDatabase(container, 'quota_sustained');
    app = await createTestApp(url, quotaEnv);
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Quota', owner: OWNER })
    );
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    ownerCookie = extractCookie(signIn);

    // Two keys for the SAME user — isolation must hold per key, not per user.
    // These two mints are the session bucket's only pre-test consumption (2/5).
    const mint = (name: string) =>
      app.app.request('/api/v1/api-keys', {
        ...json({ name, scopes: [host.scopes.read] }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie }
      });
    keyA = (await readJson(await mint('key-a'))).key;
    keyB = (await readJson(await mint('key-b'))).key;
  });

  afterAll(async () => {
    await replica?.stop();
    await app?.stop();
  });

  const me = (headers: Record<string, string>, target: TestApp = app) =>
    target.app.request('/api/v1/me', { headers });

  it('serves RateLimit headers on successful responses so agents can self-throttle', async () => {
    const res = await me({ authorization: `Bearer ${keyA}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-limit')).toBe('5');
    expect(res.headers.get('ratelimit-remaining')).toBe('4');
    expect(Number(res.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
  });

  it('trips at the configured threshold with Retry-After and the standard envelope', async () => {
    // 4 more requests exhaust key A's 5-point bucket.
    for (let i = 0; i < 4; i++) {
      expect((await me({ authorization: `Bearer ${keyA}` })).status).toBe(200);
    }
    const limited = await me({ authorization: `Bearer ${keyA}` });
    expect(limited.status).toBe(429);
    const body = await readJson(limited);
    expect(body.error.code).toBe('rate_limited');
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('cannot escape or rotate the bucket via client headers (the XFF trap)', async () => {
    // TRUST_PROXY=true in the harness, so XFF IS believed for the client IP —
    // and the quota must still hold, because its key is the principal.
    for (const spoof of ['198.51.100.7', '198.51.100.8']) {
      const res = await me({ authorization: `Bearer ${keyA}`, 'x-forwarded-for': spoof });
      expect(res.status).toBe(429);
    }
  });

  it("leaves principal B untouched while A is exhausted (same user's other key)", async () => {
    const res = await me({ authorization: `Bearer ${keyB}` });
    expect(res.status).toBe(200);
    // Fresh bucket: B consumed exactly one point.
    expect(res.headers.get('ratelimit-remaining')).toBe('4');
  });

  it("leaves the same user's SESSION untouched (third distinct bucket)", async () => {
    const res = await me({ cookie: ownerCookie });
    expect(res.status).toBe(200);
  });

  it('does not catch exempt surfaces: /healthz, discovery, setup, the auth routes', async () => {
    expect((await app.app.request('/healthz')).status).toBe(200);
    expect((await app.app.request('/api/v1/instance')).status).toBe(200);
    // Setup answers its own domain error (already set up), never the quota's 429.
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'X', owner: OWNER })
    );
    expect(setup.status).toBe(410);
    // The auth surfaces keep their own walls; the exhausted general quota
    // must not block a sign-in.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
  });

  it('memory backend is per-replica: a second instance has its own buckets (Redis path = scale drill)', async () => {
    replica = await createTestApp(url, quotaEnv);
    // Key A is exhausted on the first instance…
    expect((await me({ authorization: `Bearer ${keyA}` })).status).toBe(429);
    // …but the second replica (no REDIS_URL → RateLimiterMemory) starts fresh.
    // With REDIS_URL set the buckets are shared — proven by the I2 scale
    // drill, which this quota rides via the same limiter factory.
    expect((await me({ authorization: `Bearer ${keyA}` }, replica)).status).toBe(200);
  });
});

describe('burst cap: 1-second spikes 429 and a fresh window recovers', () => {
  let app: TestApp;
  let key: string;

  beforeAll(async () => {
    const url = await createDatabase(container, 'quota_burst');
    app = await createTestApp(url, { API_RATE_LIMIT_PER_MINUTE: '1000', API_RATE_LIMIT_BURST: '2' });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Burst', owner: OWNER })
    );
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    const cookie = extractCookie(signIn);
    const mint = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'burst', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', cookie }
    });
    key = (await readJson(mint)).key;
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('caps the spike, keeps the sustained budget intact, and recovers after the window', async () => {
    const statuses: number[] = [];
    let limited: Response | null = null;
    for (let i = 0; i < 3; i++) {
      const res = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }
    // In-process requests land within one second: 2 pass, the spike 429s.
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(limited).not.toBeNull();
    expect(limited!.headers.get('retry-after')).toBe('1');
    expect((await readJson(limited!)).error.code).toBe('rate_limited');

    // A fresh 1 s window recovers…
    await new Promise((r) => setTimeout(r, 1200));
    const recovered = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(recovered.status).toBe(200);
    // …and the rejected spike burned NO sustained points: 3 successes total.
    expect(recovered.headers.get('ratelimit-remaining')).toBe('997');
  });
});
