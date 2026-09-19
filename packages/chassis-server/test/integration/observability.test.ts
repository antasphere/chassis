import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { UsageEvent } from '@antasphere/chassis-contract';
import { desc } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
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
 * M5: metrics scrapeable + populated, security headers everywhere,
 * request-id correlation across log/audit, and the usage pipeline running
 * end-to-end through pg-boss into the downstream sink.
 *
 * (The PRIV-1 pin on the viewer's `/v/:secret` metrics label is the tool's: the
 * Slideless app keeps it, `apps/server/test/integration/observability-viewer.test.ts`.)
 */

const OWNER = { email: 'owner@obs.test', name: 'Obs Owner', password: 'obs-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
const receivedUsage: UsageEvent[] = [];

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(
    await createDatabase(container, 'obs'),
    { METRICS_TOKEN: 'obs-metrics-token' },
    {
      usageDownstream: {
        async emit(event) {
          receivedUsage.push(event);
        }
      }
    }
  );
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Obs', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('security headers', () => {
  it('sets nosniff + referrer policy on API responses', async () => {
    const res = await app.app.request('/api/v1/instance');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('locks HTML responses behind the CSP (frame-ancestors none)', async () => {
    const res = await app.app.request('/some-spa-route');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
  });
});

describe('metrics', () => {
  it('scrapes populated http metrics after traffic (with the token)', async () => {
    await app.app.request('/api/v1/instance');
    const res = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer obs-metrics-token' }
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toContain('/api/v1/instance');
    expect(body).toContain('job_queue_depth');
    expect(body).toContain('storage_bytes_total');
    expect(body).toContain('process_cpu_user_seconds_total');
  });

  it('enforces METRICS_TOKEN when configured', async () => {
    const denied = await app.app.request('/metrics');
    expect(denied.status).toBe(401);
    const wrong = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer not-the-token' }
    });
    expect(wrong.status).toBe(401);
  });

  it('is disabled (401) by default when no METRICS_TOKEN is set', async () => {
    const url = await createDatabase(container, 'obs_notoken');
    const openApp = await createTestApp(url);
    try {
      const res = await openApp.app.request('/metrics');
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('METRICS_TOKEN');
    } finally {
      await openApp.stop();
    }
  });
});

describe('request-id correlation (exit criterion 11)', () => {
  it('one request id flows response header → audit row', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'corr key', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', cookie, 'x-request-id': 'corr-test-0001' }
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('corr-test-0001');

    const [row] = await app.db.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    expect(row?.requestId).toBe('corr-test-0001');
    // The same id is stamped on the request's OTel span as `request.id`
    // (observability/otel.ts) and on the pino line as `requestId`.
  });
});

describe('usage pipeline end-to-end (seam proof)', () => {
  it('an upload emits a usage event that reaches the downstream sink via pg-boss', async () => {
    const res = await app.app.request('/api/v1/files?name=usage.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'metered bytes'
    });
    expect(res.status).toBe(201);
    const { file } = await readJson(res);

    // Worker polls the queue; give it a few seconds.
    const deadline = Date.now() + 15_000;
    while (receivedUsage.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(receivedUsage.length).toBeGreaterThan(0);
    const event = receivedUsage[0]!;
    expect(event.meter).toBe('files.upload');
    expect(event.quantity).toBe(file.sizeBytes);
    expect(event.unit).toBe('bytes');
    expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID idempotency key
    expect(event.source.instanceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.workspaceId).toBeTruthy();
  }, 30_000);
});
