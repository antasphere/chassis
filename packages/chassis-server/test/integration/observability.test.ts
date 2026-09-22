import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { UsageEvent } from '@antasphere/chassis-contract';
import { desc } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
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
 * tool's app keeps it, `apps/server/test/integration/observability-viewer.test.ts`.)
 */

const OWNER = { email: 'owner@obs.test', name: 'Obs Owner', password: 'obs-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
const receivedUsage: UsageEvent[] = [];
/** What the worker handed the downstream: whole batches, and how many single emits (expected none). */
const batches: UsageEvent[][] = [];
let singles = 0;

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
          singles += 1;
          receivedUsage.push(event);
        },
        async emitBatch(events) {
          batches.push([...events]);
          receivedUsage.push(...events);
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
  it('an event handed to the sink reaches the downstream via pg-boss; an oss upload hands it nothing', async () => {
    // The self-hosted edition is unmetered by construction (the billing rail,
    // PRDCT-2626): the entitlement gate emits no event on oss, so an upload
    // leaves the queue untouched...
    const res = await app.app.request('/api/v1/files?name=usage.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'metered bytes'
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 2_500)); // longer than the worker's poll
    expect(receivedUsage).toEqual([]);

    // ...while the durable pipeline itself (the sink → pg-boss → the
    // downstream, what the cloud poster rides) stays proven from the seam:
    // the worker hands the drained batch WHOLE to a downstream that takes
    // batches (one hub post per batch, never one per event).
    const event: UsageEvent = {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZ0',
      meter: 'files.upload',
      actionKey: 'files.upload',
      quantity: 13,
      unit: 'bytes',
      occurredAt: new Date().toISOString(),
      workspaceId: '00000000-0000-0000-0000-000000000000',
      accountRef: '77777777-aaaa-4bbb-8ccc-000000000obs',
      userId: null,
      via: 'session',
      source: { instanceId: '01JZZZZZZZZZZZZZZZZZZZZZZ1', edition: 'oss', version: 'test' }
    };
    await app.registry.usage.emit(event);
    const deadline = Date.now() + 15_000;
    while (receivedUsage.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(receivedUsage).toEqual([event]);
    expect(batches).toEqual([[event]]);
    expect(singles).toBe(0);
  }, 30_000);
});
