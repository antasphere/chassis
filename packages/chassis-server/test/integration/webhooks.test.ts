import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints, workspaceMembers } from '@antasphere/chassis-db';
import { DEMO_SESSION_REFUSED_API_ROUTES } from '@antasphere/chassis-server/identity';
import { verifyWebhookSignature } from '@antasphere/chassis-server/webhooks';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  host,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Outbound webhooks end to end (PRDCT-3482): the catalog, the endpoint CRUD
 * and its admin rule, the emit inside the write's transaction (nothing for a
 * rolled-back write, nothing at all when nobody listens), the fan-out with
 * its filters, the signed delivery to a REAL receiver over the real node
 * transport (loopback, so the instance opens private networks), retry then
 * hold then re-drive, the auto-disable and its mail, the rotation overlap,
 * the test ping, the redelivery, the URL policy of a closed instance (the
 * address check inside the socket's own lookup), the scope rule for keys, the
 * demo-session refusal, the plan limit's count and the purge.
 *
 * Isolation without truncation: every endpoint but `hook-a` narrows itself
 * to a subject id no other test emits, and `hook-a` (`thing.*`, no filter,
 * always 200) is the WITNESS of a fan-out: the fan-out writes every matching
 * row in one transaction, so once hook-a's row for an event exists, the
 * absence of another endpoint's row for it is a proof, not a wait.
 */

const PASSWORD = 'a-long-webhooks-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };
const WEBHOOKS_SCOPE = host.identity.scopes.webhooks!;
const METRICS_TOKEN = 'webhooks-metrics-token';

/**
 * The dials, shrunk. `disableAfterFailures` is 5 rather than 3: the
 * retry-then-hold test makes three failed attempts on one endpoint before its
 * hold re-drives, and a streak of 3 with `disableAfterMs: 0` would switch that
 * endpoint off at its third attempt (the re-drive then reads
 * `endpoint_disabled`, never `delivered`). Five keeps both tests on one app.
 */
const DIALS = {
  retryLimit: 2,
  retryDelaySeconds: 1,
  heldDelaySeconds: 2,
  listenerTtlMs: 0,
  disableAfterFailures: 5,
  disableAfterMs: 0,
  previousSecretOverlapMs: 60_000,
  timeoutMs: 2000
};

type Actor = { email: string; cookie: string; userId: string };
type Who = { cookie?: string; key?: string };
type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Created = { id: string; secret: string; [k: string]: unknown };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let closed: TestApp | undefined;
let workspaceId = '';
let otherWorkspaceId = '';
const actors: Record<string, Actor> = {};
const mail = new RecordingEmailDriver();

// ── The receiver ─────────────────────────────────────────────────────────────

let server: http.Server;
let base = '';
const received: Received[] = [];
/** What the receiver answers per path; 200 for any path not listed. */
const statusFor = new Map<string, number>();

const requestsTo = (path: string) => received.filter((r) => r.url === path);
const requestsWithId = (id: string) => received.filter((r) => r.headers['webhook-id'] === id);
/** One event's requests at one endpoint's path (hook-a, the witness, takes every thing event too). */
const hitsAt = (path: string, id: string) => requestsWithId(id).filter((r) => r.url === path);

// ── Helpers ──────────────────────────────────────────────────────────────────

let ipCounter = 0;
const nextIp = () => `10.81.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const sendTo = (
  target: TestApp,
  method: string,
  path: string,
  who: Who,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  target.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      origin: ORIGIN,
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(who.key ? { authorization: `Bearer ${who.key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

const send = (method: string, path: string, who: Who, body?: unknown, headers: Record<string, string> = {}) =>
  sendTo(app, method, path, who, body, headers);

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(target: TestApp, email: string): Promise<string> {
  const res = await sendTo(target, 'POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addActor(
  name: string,
  email: string,
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest' } = {}
): Promise<Actor> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await app.db.db.insert(workspaceMembers).values({
    workspaceId,
    userId: created.user.id,
    role: opts.role ?? 'member',
    origin: opts.origin ?? 'local'
  });
  const actor = { email, cookie: await signIn(app, email), userId: created.user.id };
  actors[name] = actor;
  return actor;
}

async function mintKey(cookie: string, scopes: string[]): Promise<string> {
  const res = await send('POST', '/api-keys', { cookie }, { name: `key-${scopes.join('-')}`, scopes });
  expect(res.status).toBe(201);
  return (await readJson(res)).key;
}

async function createEndpoint(
  who: Who,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  target: TestApp = app
): Promise<Created> {
  const res = await sendTo(target, 'POST', '/webhooks', who, body, headers);
  const json = await readJson(res);
  expect({ status: res.status, body: json }).toMatchObject({ status: 201 });
  return json as Created;
}

const DEADLINE_MS = 15_000;

/** Poll until the probe answers something truthy; never a bare sleep. */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = DEADLINE_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The one deliberate negative wait: long enough for a fan-out and a delivery poll. */
const settle = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

const deliveriesOf = (endpointId: string, target: TestApp = app) =>
  target.db.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpointId));

async function deliveryFor(endpointId: string, eventId: string, target: TestApp = app) {
  const [row] = await target.db.db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.eventId, eventId)));
  return row;
}

async function endpointRow(id: string) {
  const [row] = await app.db.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
  return row;
}

async function eventJobs(eventId?: string): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'webhook-events'${eventId ? ` AND data->>'id' = $1` : ''}`,
    eventId ? [eventId] : []
  );
  return rows[0]!.n;
}

async function auditRows(action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await app.db.pool.query(`SELECT * FROM audit_log WHERE action = $1 ORDER BY id DESC`, [
    action
  ]);
  return rows;
}

const emitCreated = (
  thing: string,
  project: string | string[] = 'p0',
  target: TestApp = app,
  ws = workspaceId
) =>
  target.webhooks.emit(target.db.db, {
    workspaceId: ws,
    type: 'thing.created',
    subjects: { thing, project },
    data: { thingId: thing, name: `Thing ${thing}` }
  });

const emitDeleted = (thing: string, ws = workspaceId) =>
  app.webhooks.emit(app.db.db, {
    workspaceId: ws,
    type: 'thing.deleted',
    subjects: { thing },
    data: { thingId: thing }
  });

/** Emit, then wait for hook-a (the witness) to hold its row for the event. */
async function witnessed(emitted: Promise<string | null>): Promise<string> {
  const eventId = await emitted;
  expect(eventId).toEqual(expect.any(String));
  await waitFor(`hook-a's row for ${eventId}`, () => deliveryFor(hookA.id, eventId!));
  return eventId!;
}

let hookA: Created;

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * The whole file runs under the chassis's own host only (`host.webhooks`): it
 * emits the minimal tool's `thing.*` events. A real tool's host skips it and
 * proves its own events in its own suite.
 */
describe.skipIf(!host.webhooks)('outbound webhooks (PRDCT-3482)', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.statusCode = statusFor.get(req.url ?? '') ?? 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    container = await startPostgres();
    app = await createTestApp(
      await createDatabase(container, 'webhooks'),
      { WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true', DEMO_SIGN_IN: 'true', METRICS_TOKEN },
      { webhookDials: DIALS, email: mail }
    );
    const setup = await send(
      'POST',
      '/setup',
      {},
      { setupToken: 'integration-test-setup-token', instanceName: 'Webhooks', owner: OWNER }
    );
    expect(setup.status).toBe(201);
    workspaceId = (await readJson(setup)).workspaceId;
    const ownerCookie = await signIn(app, OWNER.email);
    const me = await readJson(await send('GET', '/me', { cookie: ownerCookie }));
    actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id };
    otherWorkspaceId = (await app.registry.workspaces.create('Elsewhere', me.user.id)).workspaceId;

    await addActor('admin', 'admin@example.com', { role: 'admin' });
    await addActor('member', 'member@example.com');
    await addActor('guest', 'guest@example.org', { origin: 'guest' });
  }, 180_000);

  afterAll(async () => {
    await closed?.stop();
    await app?.stop();
    await container?.stop();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  // ── The catalog ──────────────────────────────────────────────────────────────

  describe('the catalog', () => {
    it('1. GET /webhooks/events answers the subjects and the events to any member; a guest 403, anonymous 401', async () => {
      const res = await send('GET', '/webhooks/events', actors.member!);
      expect(res.status).toBe(200);
      const catalog = await readJson(res);
      expect(catalog.subjects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'thing', field: 'thingId' }),
          expect.objectContaining({ key: 'project', field: 'projectId' })
        ])
      );
      const byType = new Map<
        string,
        { subjects: string[]; schema: { properties?: Record<string, unknown> } }
      >(catalog.events.map((e: { type: string }) => [e.type, e]));
      const created = byType.get('thing.created');
      expect(created?.subjects).toEqual(['thing', 'project']);
      expect(created?.schema.properties?.thingId).toBeDefined();
      for (const type of ['thing.deleted', 'webhook.ping', 'project.created']) {
        expect(byType.has(type), type).toBe(true);
      }
      await expectError(await send('GET', '/webhooks/events', actors.guest!), 403, 'guest_forbidden');
      await expectError(await send('GET', '/webhooks/events', {}), 401, 'unauthenticated');
    });
  });

  // ── Endpoints ────────────────────────────────────────────────────────────────

  describe('creating an endpoint', () => {
    it('2. an admin creates one: the secret once, sealed at rest, absent from reads and from the audit row; members 403, another workspace 404', async () => {
      hookA = await createEndpoint(actors.admin!, {
        url: `${base}/hook-a`,
        events: ['thing.*'],
        description: 'A'
      });
      expect(hookA).toMatchObject({ enabled: true, filters: {}, events: ['thing.*'], description: 'A' });
      expect(hookA.secret).toMatch(/^whsec_/);

      const row = await endpointRow(hookA.id);
      expect(row!.secret.startsWith('v1.')).toBe(true);
      expect(row!.secret).not.toContain(hookA.secret);
      expect(row!.createdBy).toBe(actors.admin!.userId);

      const got = await send('GET', `/webhooks/${hookA.id}`, actors.admin!);
      expect(got.status).toBe(200);
      const gotBody = await readJson(got);
      expect(gotBody.id).toBe(hookA.id);
      expect('secret' in gotBody).toBe(false);

      const list = await readJson(await send('GET', '/webhooks', actors.owner!));
      expect(list.webhooks.map((w: { id: string }) => w.id)).toContain(hookA.id);
      expect(JSON.stringify(list)).not.toContain(hookA.secret);

      const [audit] = await waitFor('the webhook.create audit row', async () => {
        const rows = await auditRows('webhook.create');
        return rows.length > 0 ? rows : undefined;
      });
      expect(audit).toMatchObject({ resource_type: 'webhook', resource_id: hookA.id });
      expect(JSON.stringify(audit)).not.toContain(hookA.secret);
      expect(JSON.stringify(audit)).not.toContain(row!.secret);

      await expectError(
        await send('POST', '/webhooks', actors.member!, { url: `${base}/nope`, events: ['*'] }),
        403,
        'forbidden'
      );
      await expectError(await send('GET', '/webhooks', actors.member!), 403, 'forbidden');
      await expectError(
        await send('GET', `/webhooks/${hookA.id}`, actors.owner!, undefined, {
          'x-workspace-id': otherWorkspaceId
        }),
        404,
        'not_found'
      );
    });
  });

  // ── Emit and deliver ─────────────────────────────────────────────────────────

  let firstEventId = '';
  let firstDeliveryId = '';

  describe('emit, fan-out, delivery', () => {
    it('3. an emit is fanned out and delivered signed (Standard Webhooks), the row delivered, the API lists it', async () => {
      const eventId = await app.webhooks.emit(app.db.db, {
        workspaceId,
        type: 'thing.created',
        subjects: { thing: 't1', project: ['p1', 'p2'] },
        data: { thingId: 't1', name: 'One' }
      });
      expect(eventId).toEqual(expect.any(String));
      firstEventId = eventId!;

      const [req] = await waitFor('the receiver to see t1', () => {
        const hits = requestsWithId(firstEventId);
        return hits.length > 0 ? hits : undefined;
      });
      expect(req!.method).toBe('POST');
      expect(req!.url).toBe('/hook-a');
      expect(req!.headers['webhook-id']).toBe(firstEventId);
      expect(req!.headers['webhook-timestamp']).toMatch(/^\d+$/);
      expect(req!.headers['webhook-signature']).toMatch(/^v1,/);
      expect(req!.headers['content-type']).toBe('application/json');
      expect(req!.headers['user-agent']).toMatch(new RegExp(`^${host.identity.slug}-webhooks/`));

      const body = JSON.parse(req!.body);
      expect(body).toEqual({
        id: firstEventId,
        type: 'thing.created',
        occurredAt: expect.any(String),
        workspaceId,
        subjects: { thingId: 't1', projectId: ['p1', 'p2'] },
        data: { thingId: 't1', name: 'One' },
        attempt: 1
      });

      const headers = {
        id: req!.headers['webhook-id'] as string,
        timestamp: req!.headers['webhook-timestamp'] as string,
        signature: req!.headers['webhook-signature'] as string
      };
      expect(verifyWebhookSignature(hookA.secret, headers, req!.body)).toBe(true);
      expect(verifyWebhookSignature(hookA.secret, headers, req!.body.replace('One', 'Two'))).toBe(false);

      const row = await waitFor('the row delivered', async () => {
        const r = await deliveryFor(hookA.id, firstEventId);
        return r?.status === 'delivered' ? r : undefined;
      });
      expect(row).toMatchObject({ attempt: 1, lastStatusCode: 200, lastError: null });
      firstDeliveryId = row.id;

      const list = await readJson(await send('GET', `/webhooks/${hookA.id}/deliveries`, actors.admin!));
      const listed = list.deliveries.find((d: { id: string }) => d.id === firstDeliveryId);
      expect(listed).toMatchObject({
        eventId: firstEventId,
        eventType: 'thing.created',
        status: 'delivered',
        payload: { id: firstEventId, subjects: { thingId: 't1', projectId: ['p1', 'p2'] } }
      });
      const one = await send('GET', `/webhooks/${hookA.id}/deliveries/${firstDeliveryId}`, actors.admin!);
      expect(one.status).toBe(200);
      expect(await readJson(one)).toMatchObject({ id: firstDeliveryId, status: 'delivered', attempt: 1 });
    });

    it('4. nobody listening costs no job: emit answers null, no row, no fan-out job', async () => {
      // The other workspace holds ONE endpoint, on `thing.created` only.
      const there = { 'x-workspace-id': otherWorkspaceId };
      const only = await createEndpoint(
        actors.owner!,
        { url: `${base}/hook-other`, events: ['thing.created'] },
        there
      );
      expect(await app.webhooks.wants(otherWorkspaceId, 'thing.deleted')).toBe(false);
      expect(await app.webhooks.wants(otherWorkspaceId, 'thing.created')).toBe(true);
      const jobsBefore = await eventJobs();
      expect(await emitDeleted('t-nobody', otherWorkspaceId)).toBeNull();
      expect(await eventJobs()).toBe(jobsBefore);
      const rows = await app.db.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.workspaceId, otherWorkspaceId),
            eq(webhookDeliveries.eventType, 'thing.deleted')
          )
        );
      expect(rows).toEqual([]);
      expect(await deliveriesOf(only.id)).toEqual([]);
    });

    it('5. a rolled-back transaction emits nothing; the same emit committed is delivered', async () => {
      const rollBack = new Error('roll back');
      let rolledId: string | null = null;
      await expect(
        app.db.db.transaction(async (tx) => {
          rolledId = await app.webhooks.emit(tx, {
            workspaceId,
            type: 'thing.created',
            subjects: { thing: 't-rolled', project: 'p0' },
            data: { thingId: 't-rolled', name: 'Rolled' }
          });
          throw rollBack;
        })
      ).rejects.toBe(rollBack);
      expect(rolledId).toEqual(expect.any(String));
      expect(await eventJobs(rolledId!)).toBe(0);
      await settle();
      expect(requestsWithId(rolledId!)).toEqual([]);
      const rows = await app.db.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, rolledId!));
      expect(rows).toEqual([]);

      let committedId: string | null = null;
      await app.db.db.transaction(async (tx) => {
        committedId = await app.webhooks.emit(tx, {
          workspaceId,
          type: 'thing.created',
          subjects: { thing: 't-committed', project: 'p0' },
          data: { thingId: 't-committed', name: 'Committed' }
        });
      });
      expect(committedId).toEqual(expect.any(String));
      await waitFor('the committed emit delivered', () => requestsWithId(committedId!).length > 0);
    });

    it('6. filters: AND across keys, OR within one; an event without a filtered subject does not match', async () => {
      const hookB = await createEndpoint(actors.admin!, {
        url: `${base}/hook-b`,
        events: ['thing.created'],
        filters: { thing: ['t-yes'] }
      });
      const no = await witnessed(emitCreated('t-no'));
      expect(await deliveryFor(hookB.id, no)).toBeUndefined();
      const yes = await witnessed(emitCreated('t-yes'));
      await waitFor('hook-b to receive t-yes', () => hitsAt('/hook-b', yes).length > 0);

      const hookP = await createEndpoint(actors.admin!, {
        url: `${base}/hook-p`,
        events: ['thing.*'],
        filters: { project: ['p9'] }
      });
      const p1 = await witnessed(emitCreated('t-p1', ['p1']));
      expect(await deliveryFor(hookP.id, p1)).toBeUndefined();
      const p19 = await witnessed(emitCreated('t-p19', ['p1', 'p9']));
      await waitFor('hook-p to receive p1+p9', () => hitsAt('/hook-p', p19).length > 0);
      // `thing.deleted` carries no project: a filter on project excludes it.
      const deleted = await witnessed(emitDeleted('t-p19'));
      expect(await deliveryFor(hookP.id, deleted)).toBeUndefined();
      expect(requestsTo('/hook-p')).toHaveLength(1);
    });
  });

  // ── A closed instance ────────────────────────────────────────────────────────

  describe('the URL policy of an instance that keeps private networks closed', () => {
    it('7. private addresses, ports, userinfo and other schemes are refused at creation; a name resolving to loopback is refused in the socket', async () => {
      closed = await createTestApp(
        await createDatabase(container, 'webhooks_closed'),
        {},
        {
          webhookDials: DIALS,
          // Every name resolves to loopback: the check inside the socket's own lookup must refuse it.
          webhookFetch: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }
        }
      );
      const setup = await sendTo(
        closed,
        'POST',
        '/setup',
        {},
        { setupToken: 'integration-test-setup-token', instanceName: 'Closed', owner: OWNER }
      );
      expect(setup.status).toBe(201);
      const closedWs = (await readJson(setup)).workspaceId;
      const owner = { cookie: await signIn(closed, OWNER.email) };

      const post = (url: string) => sendTo(closed!, 'POST', '/webhooks', owner, { url, events: ['*'] });
      await expectError(await post(`${base}/x`), 400, 'url_refused');
      await expectError(await post('http://10.0.0.1/'), 400, 'url_refused');
      await expectError(await post('http://169.254.169.254/'), 400, 'url_refused');
      // The schema refuses these first (a validation error), the service would answer url_refused: 400 either way.
      expect((await post('http://user:pw@example.com/')).status).toBe(400);
      expect((await post('ftp://example.com/hook')).status).toBe(400);

      const endpoint = await createEndpoint(
        owner,
        { url: 'http://example.test/hook', events: ['thing.created'] },
        {},
        closed
      );
      const eventId = await emitCreated('t-closed', 'p0', closed, closedWs);
      expect(eventId).toEqual(expect.any(String));
      const row = await waitFor('the refused delivery', async () => {
        const r = await deliveryFor(endpoint.id, eventId!, closed);
        return r?.lastError ? r : undefined;
      });
      expect(row.lastError).toMatch(/^url_refused:private_address/);
      expect(row.lastStatusCode).toBeNull();
      expect(row.status).not.toBe('delivered');
      expect(requestsWithId(eventId!)).toEqual([]);
    });
  });

  // ── Failure paths ────────────────────────────────────────────────────────────

  describe('failures', () => {
    it(
      '8. a failing receiver is retried, then held, then re-driven once it answers',
      { timeout: 45_000 },
      async () => {
        statusFor.set('/hook-c', 500);
        const hookC = await createEndpoint(actors.admin!, {
          url: `${base}/hook-c`,
          events: ['thing.created'],
          filters: { thing: ['t-c'] }
        });
        const eventId = (await emitCreated('t-c'))!;
        expect(eventId).toEqual(expect.any(String));
        const held = await waitFor(
          'the delivery held',
          async () => {
            const r = await deliveryFor(hookC.id, eventId);
            return r?.status === 'held' ? r : undefined;
          },
          30_000
        );
        // retryLimit 2: three attempts, then the dead letter moved it to held.
        expect(held.attempt).toBe(3);
        expect(held.lastStatusCode).toBe(500);
        expect(held.lastError).toBe('HTTP 500');
        expect(held.nextAttemptAt).not.toBeNull();
        statusFor.set('/hook-c', 200);

        const scrape = await app.app.request('/metrics', {
          headers: { authorization: `Bearer ${METRICS_TOKEN}` }
        });
        expect(scrape.status).toBe(200);
        const metrics = await scrape.text();
        const heldTotal = /^webhook_deliveries_held_total (\d+)/m.exec(metrics);
        expect(Number(heldTotal?.[1] ?? 0)).toBeGreaterThanOrEqual(1);

        const delivered = await waitFor(
          'the held delivery re-driven',
          async () => {
            const r = await deliveryFor(hookC.id, eventId);
            return r?.status === 'delivered' ? r : undefined;
          },
          20_000
        );
        expect(delivered).toMatchObject({ attempt: 4, lastStatusCode: 200, lastError: null });
        expect(hitsAt('/hook-c', eventId)).toHaveLength(4);
        expect(JSON.parse(hitsAt('/hook-c', eventId).at(-1)!.body).attempt).toBe(4);
        const endpoint = await endpointRow(hookC.id);
        expect(endpoint).toMatchObject({
          enabled: true,
          consecutiveFailures: 0,
          lastDeliveryStatus: 'delivered'
        });
      }
    );

    it(
      '9. a failure streak switches the endpoint off, mails its creator once, and a re-enable clears it',
      { timeout: 60_000 },
      async () => {
        statusFor.set('/hook-d', 503);
        const url = `${base}/hook-d`;
        const hookD = await createEndpoint(actors.owner!, {
          url,
          events: ['thing.created'],
          filters: { thing: ['t-d'] },
          description: 'Dee'
        });
        // Two events, three attempts each: the fifth failed attempt disables.
        expect(await emitCreated('t-d')).toEqual(expect.any(String));
        expect(await emitCreated('t-d')).toEqual(expect.any(String));
        const off = await waitFor(
          'the endpoint switched off',
          async () => {
            const r = await endpointRow(hookD.id);
            return r && !r.enabled ? r : undefined;
          },
          40_000
        );
        expect(off).toMatchObject({ enabled: false, disabledReason: 'delivery_failures' });
        expect(off.disabledAt).not.toBeNull();
        expect(off.consecutiveFailures).toBeGreaterThanOrEqual(DIALS.disableAfterFailures);

        // No request after the switch: the fifth failure was the last one the receiver saw.
        expect(requestsTo('/hook-d')).toHaveLength(DIALS.disableAfterFailures);
        const mails = mail.sent.filter((m) => m.subject.includes('switched off'));
        expect(mails).toHaveLength(1);
        expect(mails[0]!.to).toBe(OWNER.email);
        expect(mails[0]!.text).toContain(url);

        // A switched-off endpoint takes no new event (hook-a, the witness, still does).
        const after = await witnessed(emitCreated('t-d'));
        expect(await deliveryFor(hookD.id, after)).toBeUndefined();

        // Every delivery left reads failed/endpoint_disabled once its next round (a retry, or the
        // hold's re-drive) finds the endpoint off.
        const rows = await waitFor(
          'the deliveries refused as endpoint_disabled',
          async () => {
            const all = await deliveriesOf(hookD.id);
            return all.length === 2 &&
              all.every((d) => d.status === 'failed' && d.lastError === 'endpoint_disabled')
              ? all
              : undefined;
          },
          20_000
        );
        expect(rows).toHaveLength(2);
        expect(requestsTo('/hook-d')).toHaveLength(DIALS.disableAfterFailures);

        statusFor.set('/hook-d', 200);
        const patched = await send('PATCH', `/webhooks/${hookD.id}`, actors.owner!, { enabled: true });
        expect(patched.status).toBe(200);
        expect(await readJson(patched)).toMatchObject({
          enabled: true,
          disabledAt: null,
          disabledReason: null,
          consecutiveFailures: 0
        });
        expect(await endpointRow(hookD.id)).toMatchObject({ firstFailureAt: null, consecutiveFailures: 0 });
      }
    );
  });

  // ── Secret, ping, redeliver, update, delete ──────────────────────────────────

  describe('the endpoint’s acts', () => {
    it('10. a rotation answers a new secret, and the next delivery verifies under the new AND the old one', async () => {
      const hookF = await createEndpoint(actors.admin!, {
        url: `${base}/hook-f`,
        events: ['thing.created'],
        filters: { thing: ['t-f'] }
      });
      const rotated = await send('POST', `/webhooks/${hookF.id}/rotate-secret`, actors.admin!);
      expect(rotated.status).toBe(200);
      const body = await readJson(rotated);
      expect(body.secret).toMatch(/^whsec_/);
      expect(body.secret).not.toBe(hookF.secret);
      expect(body.previousSecretExpiresAt).toEqual(expect.any(String));
      expect(Date.parse(body.previousSecretExpiresAt)).toBeGreaterThan(Date.now());

      const eventId = (await emitCreated('t-f'))!;
      const [req] = await waitFor('hook-f to receive', () => {
        const hits = hitsAt('/hook-f', eventId);
        return hits.length > 0 ? hits : undefined;
      });
      const signature = req!.headers['webhook-signature'] as string;
      expect(signature.split(' ')).toHaveLength(2);
      expect(signature.split(' ').every((s) => s.startsWith('v1,'))).toBe(true);
      const headers = {
        id: req!.headers['webhook-id'] as string,
        timestamp: req!.headers['webhook-timestamp'] as string,
        signature
      };
      expect(verifyWebhookSignature(body.secret, headers, req!.body)).toBe(true);
      expect(verifyWebhookSignature(hookF.secret, headers, req!.body)).toBe(true);

      const [audit] = await waitFor('the rotation audit row', async () => {
        const rows = (await auditRows('webhook.rotate_secret')).filter((r) => r.resource_id === hookF.id);
        return rows.length > 0 ? rows : undefined;
      });
      expect(JSON.stringify(audit)).not.toContain(body.secret);
      expect(JSON.stringify(audit)).not.toContain(hookF.secret);
    });

    it('11. the test ping is attempted inline, once: delivered, then failed with no retry', async () => {
      const hookE = await createEndpoint(actors.admin!, {
        url: `${base}/hook-e`,
        events: ['thing.deleted'],
        filters: { thing: ['t-e-never'] }
      });
      const ok = await send('POST', `/webhooks/${hookE.id}/test`, actors.admin!);
      expect(ok.status).toBe(200);
      const { delivery } = await readJson(ok);
      expect(delivery).toMatchObject({
        status: 'delivered',
        eventType: 'webhook.ping',
        attempt: 1,
        lastStatusCode: 200
      });
      const [ping] = requestsWithId(delivery.eventId);
      expect(ping).toBeDefined();
      const pingBody = JSON.parse(ping!.body);
      expect(pingBody).toMatchObject({
        type: 'webhook.ping',
        data: { endpointId: hookE.id, sentBy: actors.admin!.userId }
      });

      statusFor.set('/hook-e', 500);
      const bad = await send('POST', `/webhooks/${hookE.id}/test`, actors.admin!);
      expect(bad.status).toBe(200);
      const failed = (await readJson(bad)).delivery;
      expect(failed).toMatchObject({ status: 'failed', lastStatusCode: 500, eventType: 'webhook.ping' });
      await settle();
      expect(requestsWithId(failed.eventId)).toHaveLength(1);
      expect(await deliveryFor(hookE.id, failed.eventId)).toMatchObject({ status: 'failed', attempt: 1 });
      statusFor.delete('/hook-e');
    });

    it('12. a redelivery is a new row with the same event id and payload; the receiver sees the same webhook-id again', async () => {
      const res = await send(
        'POST',
        `/webhooks/${hookA.id}/deliveries/${firstDeliveryId}/redeliver`,
        actors.admin!
      );
      expect(res.status).toBe(201);
      const again = await readJson(res);
      expect(again.id).not.toBe(firstDeliveryId);
      expect(again.eventId).toBe(firstEventId);
      const [original] = await app.db.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, firstDeliveryId));
      expect(again.payload).toEqual(original!.payload);
      await waitFor(
        'the second request with the same webhook-id',
        () => requestsWithId(firstEventId).length === 2
      );
      const bodies = requestsWithId(firstEventId).map((r) => JSON.parse(r.body));
      expect(bodies[1]).toEqual(bodies[0]);
    });

    it('13. an update changes what the endpoint takes; an empty patch is 400; a delete cascades its deliveries', async () => {
      const hookG = await createEndpoint(actors.admin!, {
        url: `${base}/hook-g`,
        events: ['thing.created'],
        filters: { thing: ['t2'] }
      });
      const patched = await send('PATCH', `/webhooks/${hookG.id}`, actors.admin!, {
        events: ['thing.deleted'],
        filters: { thing: ['t2'] }
      });
      expect(patched.status).toBe(200);
      expect(await readJson(patched)).toMatchObject({
        events: ['thing.deleted'],
        filters: { thing: ['t2'] }
      });

      const created = await witnessed(emitCreated('t2'));
      expect(await deliveryFor(hookG.id, created)).toBeUndefined();
      const deleted = await witnessed(emitDeleted('t2'));
      await waitFor('hook-g to receive thing.deleted', () => hitsAt('/hook-g', deleted).length > 0);

      await expectError(
        await send('PATCH', `/webhooks/${hookG.id}`, actors.admin!, {}),
        400,
        'validation_error'
      );

      const gone = await send('DELETE', `/webhooks/${hookG.id}`, actors.admin!);
      expect(gone.status).toBe(200);
      expect(await readJson(gone)).toMatchObject({ id: hookG.id, url: `${base}/hook-g` });
      await expectError(await send('GET', `/webhooks/${hookG.id}`, actors.admin!), 404, 'not_found');
      expect(await deliveriesOf(hookG.id)).toEqual([]);
    });
  });

  // ── Who may ──────────────────────────────────────────────────────────────────

  describe('machine principals and demo sessions', () => {
    it('14. read and write keys reach the catalog only; the webhooks scope opens the family to an admin, not to a member', async () => {
      const both = await mintKey(actors.admin!.cookie, [host.scopes.read, host.scopes.write]);
      await expectError(await send('GET', '/webhooks', { key: both }), 403, 'insufficient_scope');
      await expectError(
        await send('POST', '/webhooks', { key: both }, { url: `${base}/hook-k`, events: ['*'] }),
        403,
        'insufficient_scope'
      );
      expect((await send('GET', '/webhooks/events', { key: both })).status).toBe(200);

      const adminKey = await mintKey(actors.admin!.cookie, [WEBHOOKS_SCOPE]);
      expect((await send('GET', '/webhooks', { key: adminKey })).status).toBe(200);
      const byKey = await createEndpoint(
        { key: adminKey },
        { url: `${base}/hook-k`, events: ['thing.deleted'], filters: { thing: ['t-k-never'] } }
      );
      expect(byKey.secret).toMatch(/^whsec_/);

      const memberKey = await mintKey(actors.member!.cookie, [WEBHOOKS_SCOPE]);
      await expectError(await send('GET', '/webhooks', { key: memberKey }), 403, 'forbidden');
      await expectError(
        await send('POST', '/webhooks', { key: memberKey }, { url: `${base}/hook-k2`, events: ['*'] }),
        403,
        'forbidden'
      );
    });

    it('15. a session a demo link opened reads but is refused every write (403 demo_session)', async () => {
      const victim = await createEndpoint(actors.admin!, {
        url: `${base}/hook-z`,
        events: ['thing.deleted'],
        filters: { thing: ['t-z-never'] }
      });
      const minted = await send('POST', '/demo/passes', actors.owner!, { email: actors.admin!.email });
      expect(minted.status).toBe(201);
      const { secret } = await readJson(minted);
      const redeemed = await send('POST', '/auth/demo/redeem', {}, { pass: secret });
      expect(redeemed.status).toBe(200);
      const demo = { cookie: extractCookie(redeemed) };

      expect((await send('GET', '/webhooks', demo)).status).toBe(200);
      expect((await send('GET', `/webhooks/${victim.id}`, demo)).status).toBe(200);
      const code = 'demo_session';
      await expectError(
        await send('POST', '/webhooks', demo, { url: `${base}/hook-demo`, events: ['*'] }),
        403,
        code
      );
      await expectError(await send('PATCH', `/webhooks/${victim.id}`, demo, { description: 'x' }), 403, code);
      await expectError(await send('DELETE', `/webhooks/${victim.id}`, demo), 403, code);
      await expectError(await send('POST', `/webhooks/${victim.id}/rotate-secret`, demo), 403, code);
      await expectError(await send('POST', `/webhooks/${victim.id}/test`, demo), 403, code);
      await expectError(
        await send('POST', `/webhooks/${hookA.id}/deliveries/${firstDeliveryId}/redeliver`, demo),
        403,
        code
      );
      expect(await endpointRow(victim.id)).toMatchObject({ description: '', enabled: true });
      expect(requestsTo('/hook-z')).toEqual([]);

      // The list the refusal is mounted from names the four webhook entries.
      const webhookEntries = DEMO_SESSION_REFUSED_API_ROUTES.filter((r) =>
        r.path.startsWith('/webhooks')
      ).map((r) => `${r.method} ${r.path}`);
      expect(webhookEntries.sort()).toEqual(
        ['DELETE /webhooks/*', 'PATCH /webhooks/*', 'POST /webhooks', 'POST /webhooks/*'].sort()
      );
    });
  });

  // ── Housekeeping ─────────────────────────────────────────────────────────────

  describe('housekeeping', () => {
    it('16. count answers the endpoints of one workspace, for the plan limit', async () => {
      const rows = await app.db.db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.workspaceId, workspaceId));
      expect(rows.length).toBeGreaterThan(5);
      expect(await app.webhooks.count(workspaceId)).toBe(rows.length);
      expect(await app.webhooks.count(otherWorkspaceId)).toBe(1);
      const empty = (await app.registry.workspaces.create('Empty', actors.owner!.userId)).workspaceId;
      expect(await app.webhooks.count(empty)).toBe(0);
    });

    it('17. the purge deletes the deliveries past the retention and keeps the fresh ones', async () => {
      const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      const [stale] = await app.db.db
        .insert(webhookDeliveries)
        .values({
          endpointId: hookA.id,
          workspaceId,
          eventId: '00000000-0000-4000-8000-000000000040',
          eventType: 'thing.created',
          payload: { stale: true },
          status: 'delivered',
          createdAt: old,
          updatedAt: old
        })
        .returning({ id: webhookDeliveries.id });
      const before = (await deliveriesOf(hookA.id)).length;
      expect(await app.webhooks.purge(30)).toBe(1);
      const after = await deliveriesOf(hookA.id);
      expect(after.map((d) => d.id)).not.toContain(stale!.id);
      expect(after).toHaveLength(before - 1);
      expect(after.map((d) => d.id)).toContain(firstDeliveryId);
    });
  });
});
