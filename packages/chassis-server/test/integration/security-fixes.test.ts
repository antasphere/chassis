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
 * The security-fix regression battery (audit merge, milestone A):
 *  - login rate limit holds per-account under a shared/rotating IP;
 *  - the /mcp endpoint has a rate-limit wall;
 *  - an audit-write failure never fails the audited mutation.
 * XFF is trusted in tests (helpers set TRUST_PROXY=true), so each request can
 * own its bucket by setting x-forwarded-for.
 */

const OWNER = { email: 'owner@sec.test', name: 'Sec Owner', password: 'sec-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
// Captured before any rate-limit spamming below exhausts the owner's login bucket.
let ownerCookie: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'sec'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Sec', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('login rate limit is keyed per-account, not only per-IP', () => {
  it('trips for one victim email even as the IP rotates every request', async () => {
    const badLogin = (email: string, xff: string) =>
      app.app.request('/api/v1/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
        body: JSON.stringify({ email, password: 'wrong-password-entirely' })
      });

    // Rotate the IP on every attempt so the per-IP key never accumulates; only
    // the per-email key can trip. The login bucket is 10 per window.
    let sawVictimRateLimit = false;
    for (let i = 0; i < 15 && !sawVictimRateLimit; i++) {
      const r = await badLogin(OWNER.email, `203.0.113.${i + 1}`);
      if (r.status === 429) sawVictimRateLimit = true;
      else expect(r.status).toBe(401);
    }
    expect(sawVictimRateLimit).toBe(true);

    // A DIFFERENT account from a fresh IP is unaffected (its own email bucket).
    const other = await badLogin('someone-else@sec.test', '198.51.100.42');
    expect(other.status).toBe(401);
  });
});

describe('/mcp rate-limit wall', () => {
  it('rejects an unauthenticated flood from one IP with 429 after the limit', async () => {
    const flood = () =>
      app.app.request('/mcp', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.200' } });

    // Before the wall trips, unauthenticated requests are 401 (RFC 9728).
    const first = await flood();
    expect(first.status).toBe(401);

    // The mcp bucket is 120/min; hammer past it and assert a 429 appears.
    let sawRateLimit = false;
    for (let i = 0; i < 200 && !sawRateLimit; i++) {
      const r = await flood();
      if (r.status === 429) sawRateLimit = true;
      else expect(r.status).toBe(401);
    }
    expect(sawRateLimit).toBe(true);

    // The wall is per-IP: a different address still gets the normal 401.
    const other = await app.app.request('/mcp', {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.201' }
    });
    expect(other.status).toBe(401);
  });
});

describe('request body size cap', () => {
  it('rejects an oversized JSON body with 413', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > the 1 MiB JSON cap
    const res = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ name: huge, scopes: [host.scopes.read] })
    });
    expect(res.status).toBe(413);
  });

  it('does NOT cap file uploads (they stream with their own limit)', async () => {
    // 1.5 MiB — above the JSON cap, well under MAX_FILE_SIZE_MB (100).
    const body = 'a'.repeat(Math.floor(1.5 * 1024 * 1024));
    const res = await app.app.request('/api/v1/files?name=big.bin', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: ownerCookie },
      body
    });
    expect(res.status).toBe(201);
  });
});

describe('audit retention purge', () => {
  it('deletes rows older than the retention window and keeps recent ones', async () => {
    const wsRes = await app.db.pool.query<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
    const workspaceId = wsRes.rows[0]?.id;
    expect(workspaceId).toBeTruthy();

    const countAncient = async () =>
      (
        await app.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ancient.event'`
        )
      ).rows[0]?.n ?? 0;

    await app.db.pool.query(
      `INSERT INTO audit_log (workspace_id, actor_via, action, resource_type, created_at)
       VALUES ($1, 'system', 'ancient.event', 'test', now() - interval '400 days')`,
      [workspaceId]
    );
    expect(await countAncient()).toBe(1);

    // Trigger the worker's purge handler out of band (the schedule is 03:00).
    await app.jobs.boss.send('audit-purge', {});

    const deadline = Date.now() + 15_000;
    let ancient = 1;
    while (ancient > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      ancient = await countAncient();
    }
    expect(ancient).toBe(0);

    // Recent rows (created by earlier tests in this file) are untouched.
    const recent = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE created_at > now() - interval '1 day'`
    );
    expect(recent.rows[0]?.n ?? 0).toBeGreaterThan(0);
  }, 30_000);
});

describe('audit writes are best-effort (a committed mutation must not 500)', () => {
  it('returns 201 and persists the mutation even when the audit insert fails', async () => {
    // Break the audit sink out from under the request lifecycle.
    await app.db.pool.query('ALTER TABLE audit_log RENAME TO audit_log_broken');
    try {
      const res = await app.app.request('/api/v1/api-keys', {
        ...json({ name: 'survives-audit-outage', scopes: [host.scopes.read] }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie }
      });
      // The mutation committed; the failed audit write is logged, not fatal.
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.apiKey.name).toBe('survives-audit-outage');

      // And it is really persisted (listable) despite the audit failure.
      const list = await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie } });
      const listBody = await readJson(list);
      expect(listBody.apiKeys.map((k: { name: string }) => k.name)).toContain('survives-audit-outage');
    } finally {
      await app.db.pool.query('ALTER TABLE audit_log_broken RENAME TO audit_log');
    }
  });
});
