import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ulid } from 'ulid';
import type { UsageEvent } from '@antasphere/chassis-contract';
import { FakeHub } from '@antasphere/chassis-server/testing';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp, host } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The hub's occurredAt window on the chassis (PRDCT-2644), end to end on
 * the minimal host against the fake hub, cloud edition: an event whose
 * `occurredAt` is eight days old is held by the poster BEFORE posting (the
 * hub never sees it), sent to the held queue, counted on /metrics as a
 * window hold (never as a retry-budget hold), and re-driven round after
 * round, held again each time, never posted; an ordinary upload beside it
 * lands as before.
 *
 * The stale event enters through the boot result's registry usage sink
 * (`app.registry.usage`, the PgBossUsageSink the gate itself emits
 * through), built from the upload's own event as the hub recorded it, so it
 * is a well-formed event in every field but its date.
 */

const HUB_SECRET = 'integration-test-hub-secret-window';
const METRICS_TOKEN = 'integration-metrics-token-window';
const ORG = '77777777-aaaa-4bbb-8ccc-00000000e0f1';
const OPERATOR = { email: 'operator@window.test', name: 'Operator', password: 'operator-window-pass-1' };
const DAY = 24 * 60 * 60 * 1000;

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let cookie: string;
let workspaceId: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp() },
  body: JSON.stringify(body)
});

/** The value of one exact series (`name{labels}`), 0 when absent. */
async function metric(series: string): Promise<number> {
  const res = await app.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  expect(res.status).toBe(200);
  const line = (await res.text()).split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  container = await startPostgres();
  hub = await FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET });
  app = await createTestApp(
    await createDatabase(container, 'usage_window'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: HUB_SECRET,
      METRICS_TOKEN
    },
    // A held event comes back a second after its hold (the PRDCT-2635 dials).
    { usageRetry: { limit: 1, delaySeconds: 1, heldDelaySeconds: 1 }, entitlementDials: { ttlMs: 60_000 } }
  );
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Window', owner: OPERATOR })
  );
  cookie = await sso.ssoLogin(app, hub, {
    sub: 'hub-user-window',
    email: 'window@window.test',
    name: 'Window User',
    workspaceId: ORG,
    role: 'owner',
    workspaceName: 'Org Window'
  });
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  workspaceId = me.activeWorkspaceId;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await hub?.stop();
  await container?.stop();
});

describe('cloud: an event outside the hub’s occurredAt window is held, never posted (PRDCT-2644)', () => {
  it('holds the stale event before the hub sees it, counts it as a window hold, and holds it again on every round', async () => {
    const text = 'The window fox';
    const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent('fox.txt')}`, {
      method: 'POST',
      headers: {
        cookie,
        'x-workspace-id': workspaceId,
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(text)),
        'x-forwarded-for': sso.nextIp()
      },
      body: text
    });
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    const recorded = await until(
      () => [...hub.usageEvents.values()].find((e) => e.resourceId === fileId),
      (e) => e !== undefined
    );
    expect(recorded).toBeDefined();

    // The same event, a new id, eight days old.
    const { toolSlug: _stamped, ...fields } = recorded as Record<string, unknown>;
    const staleId = ulid();
    const stale = {
      ...fields,
      id: staleId,
      occurredAt: new Date(Date.now() - 8 * DAY).toISOString()
    } as unknown as UsageEvent;
    await app.registry.usage.emit(stale);

    // First round: one window hold, on both counters (the poster counts
    // before the worker's send, the worker after it).
    const first = await until(
      () => metric('usage_events_held_total{reason="occurred_at_window"}'),
      (n) => n >= 1
    );
    expect(first).toBe(1);
    expect(await metric('usage_poster_events_total{outcome="held"}')).toBe(1);
    // Never counted as a retry-budget hold, never a rejection at the hub.
    expect(await metric('usage_events_held_total{reason="retry_budget"}')).toBe(0);
    expect(await metric('usage_poster_events_total{outcome="rejected"}')).toBe(0);

    // The held queue carries it, marked as a window hold.
    const rows = await app.db.pool.query<{ id: string; singleton_key: string | null }>(
      `SELECT data->>'id' AS id, singleton_key FROM pgboss.job WHERE name = 'usage-events-held' AND data->>'id' = $1`,
      [staleId]
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0]!.singleton_key).toBe(`occurred_at_window:${staleId}`);

    // The held queue re-drives it after a second; the poster holds it again.
    await until(
      () => metric('usage_events_held_total{reason="occurred_at_window"}'),
      (n) => n >= 2
    );
    expect(await metric('usage_events_held_total{reason="occurred_at_window"}')).toBeGreaterThanOrEqual(2);
    expect(await metric('usage_poster_events_total{outcome="held"}')).toBeGreaterThanOrEqual(2);
    expect(await metric('usage_events_held_total{reason="retry_budget"}')).toBe(0);

    // The hub never saw the stale event; the upload's landed exactly once.
    expect(hub.usageEvents.has(staleId)).toBe(false);
    expect([...hub.usageEvents.values()].filter((e) => e.resourceId === fileId)).toHaveLength(1);
  }, 120_000);
});
