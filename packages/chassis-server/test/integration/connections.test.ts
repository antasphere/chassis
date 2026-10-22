import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { connectionDeliveries, connections, workspaceMembers } from '@antasphere/chassis-db';
import { DEMO_SESSION_REFUSED_API_ROUTES } from '@antasphere/chassis-server/identity';
import { generateWebhookSecret, signWebhook } from '@antasphere/chassis-server/webhooks';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  host,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Connections end to end (PRDCT-3773): the list of the host's three sources
 * (an inbound one on the standard scheme, one on Stripe's, a key one with a
 * probe and fields), the receiving URL made once and rotated, the secret set
 * sealed and never answered, the key probed at set and at test, the fields,
 * the door (unknown source and token, the signature on the raw body, a
 * repeat, a handler that fails and the sender's retry, a ping, the body
 * cap), the delivery log, the disconnect, the roles, the demo-session
 * refusal, the machine scope rule, and the purge.
 */

const PASSWORD = 'a-long-connections-password-1';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };
const WEBHOOKS_SCOPE = host.identity.scopes.webhooks!;
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
/** What the host's handlers saw; the suite skips under a host that declares no sources. */
const connectionDeliveriesSeen = host.connections?.seen ?? [];

type Actor = { email: string; cookie: string; userId: string };
type Who = { cookie?: string; key?: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
const actors: Record<string, Actor> = {};

let ipCounter = 0;
const nextIp = () => `10.83.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, who: Who, body?: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      // a same-origin browser call: the demo redeem refuses a cross-site one
      origin: 'http://localhost:3000',
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(who.key ? { authorization: `Bearer ${who.key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

/** A delivery at the door, raw: the headers as given, the body as given. */
const knock = (path: string, headers: Record<string, string>, body: string) =>
  app.app.request(path, { method: 'POST', headers: { 'x-forwarded-for': nextIp(), ...headers }, body });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(email: string): Promise<string> {
  const res = await send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addActor(
  name: string,
  email: string,
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest' } = {}
) {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await app.db.db.insert(workspaceMembers).values({
    workspaceId,
    userId: created.user.id,
    role: opts.role ?? 'member',
    origin: opts.origin ?? 'local'
  });
  const actor = { email, cookie: await signIn(email), userId: created.user.id };
  actors[name] = actor;
  return actor;
}

async function mintKey(cookie: string, scopes: string[]): Promise<string> {
  const res = await send('POST', '/api-keys', { cookie }, { name: `key-${scopes.join('-')}`, scopes });
  expect(res.status).toBe(201);
  return (await readJson(res)).key;
}

const standardHeaders = (secret: string, id: string, body: string, at = NOW_SECONDS()) => ({
  'webhook-id': id,
  'webhook-timestamp': String(at),
  'webhook-signature': signWebhook([secret], id, at, body),
  'content-type': 'application/json'
});

const stripeHeaders = (secret: string, body: string, at = NOW_SECONDS()) => ({
  'stripe-signature': `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`,
  'content-type': 'application/json'
});

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'connections'), { DEMO_SIGN_IN: 'true' });
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Connections', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const ownerCookie = await signIn(OWNER.email);
  const me = await readJson(await send('GET', '/me', { cookie: ownerCookie }));
  actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id };
  await addActor('admin', 'admin@example.com', { role: 'admin' });
  await addActor('member', 'member@example.com');
  await addActor('guest', 'guest@example.org', { origin: 'guest' });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe.skipIf(!host.connections)('connections (PRDCT-3773)', () => {
  let partnerUrl = '';
  let partnerSecret = '';

  describe('the list', () => {
    it('1. every member reads the declared sources in order, disconnected, with the declaration; a guest is refused', async () => {
      const res = await send('GET', '/connections', actors.member!);
      expect(res.status).toBe(200);
      const { connections: list } = await readJson(res);
      expect(list.map((c: { source: string }) => c.source)).toEqual(['partner', 'ledger', 'vault']);
      expect(list[0]).toMatchObject({
        source: 'partner',
        name: 'Partner',
        kind: 'inbound',
        connected: false,
        url: null,
        secret: { set: false, readable: false, setAt: null, setBy: null },
        fields: {},
        lastDelivery: null,
        check: null,
        sibling: null,
        declared: {
          verifier: 'standard-webhooks',
          events: ['thing.created', 'thing.deleted'],
          secretHint: 'whsec_…'
        }
      });
      expect(list[1].declared.verifier).toBe('stripe');
      expect(list[2]).toMatchObject({
        kind: 'key',
        declared: {
          verifier: null,
          fields: [
            { key: 'folder', label: 'Folder', required: false, multiple: false },
            { key: 'labels', label: 'Labels', required: false, multiple: true }
          ]
        }
      });
      await expectError(await send('GET', '/connections', actors.guest!), 403, 'guest_forbidden');
      await expectError(await send('GET', '/connections/nowhere', actors.member!), 404, 'not_found');
    });
  });

  describe('an inbound source', () => {
    it('2. an admin makes the receiving URL, answered once; only its hash is kept; a member is refused', async () => {
      await expectError(await send('POST', '/connections/partner', actors.member!), 403, 'forbidden');
      const res = await send('POST', '/connections/partner', actors.admin!);
      expect(res.status).toBe(200);
      const made = await readJson(res);
      expect(made.receivingUrl).toMatch(/^http:\/\/localhost:3000\/hooks\/partner\/[A-Za-z0-9_-]{40,}$/);
      partnerUrl = made.receivingUrl;
      expect(made.connection).toMatchObject({
        connected: false,
        url: { madeBy: { email: 'admin@example.com' } }
      });
      const [row] = await app.db.db
        .select()
        .from(connections)
        .where(eq(connections.workspaceId, workspaceId));
      expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(tokenOf(partnerUrl));
      // the URL never comes back
      const again = await readJson(await send('GET', '/connections/partner', actors.admin!));
      expect(JSON.stringify(again)).not.toContain(tokenOf(partnerUrl));
    });

    it('3. the door before the secret is set: 401 secret_not_set; an unknown token or source: 404', async () => {
      const body = JSON.stringify({ id: 'evt-0', type: 'thing.created' });
      expect(
        (await knock(new URL(partnerUrl).pathname, { 'content-type': 'application/json' }, body)).status
      ).toBe(401);
      expect((await knock('/hooks/partner/not-a-token', {}, body)).status).toBe(404);
      expect((await knock('/hooks/nowhere/x', {}, body)).status).toBe(404);
      expect((await knock('/hooks/vault/x', {}, body)).status).toBe(404);
    });

    it('4. a secret off the declared shape is refused; a good one is stored sealed, never answered', async () => {
      await expectError(
        await send('PUT', '/connections/partner/secret', actors.admin!, { secret: 'nope' }),
        400,
        'secret_invalid'
      );
      partnerSecret = `whsec_${Buffer.from(randomUUID()).toString('base64')}`;
      const res = await send('PUT', '/connections/partner/secret', actors.owner!, { secret: partnerSecret });
      expect(res.status).toBe(200);
      const c = await readJson(res);
      expect(c).toMatchObject({
        connected: true,
        secret: { set: true, readable: true, setBy: { email: OWNER.email } }
      });
      expect(JSON.stringify(c)).not.toContain(partnerSecret);
      const [row] = await app.db.db
        .select()
        .from(connections)
        .where(eq(connections.workspaceId, workspaceId));
      expect(row!.secretSealed!.startsWith('v1.')).toBe(true);
      expect(row!.secretSealed).not.toContain(partnerSecret);
      const audit = await readJson(await send('GET', '/audit?limit=20', actors.owner!));
      expect(JSON.stringify(audit)).toContain('connection.secret');
      expect(JSON.stringify(audit)).not.toContain(partnerSecret);
      expect(JSON.stringify(audit)).not.toContain(tokenOf(partnerUrl));
    });

    it('5. the door: a bad signature writes nothing (401); a signed delivery runs the handler, is logged, stamps the card', async () => {
      const path = new URL(partnerUrl).pathname;
      const body = JSON.stringify({ id: 'evt-1', type: 'thing.created', data: { thingId: 't1' } });
      const bad = await knock(path, standardHeaders(generateWebhookSecret(), 'msg-1', body), body);
      expect(bad.status).toBe(401);
      expect((await readJson(bad)).code).toBe('invalid_signature');
      expect(await app.db.db.select().from(connectionDeliveries)).toHaveLength(0);

      const ok = await knock(path, standardHeaders(partnerSecret, 'msg-1', body), body);
      expect(ok.status).toBe(200);
      expect(await readJson(ok)).toEqual({ ok: true, outcome: 'processed', detail: 'took thing.created' });
      expect(connectionDeliveriesSeen.at(-1)).toMatchObject({
        workspaceId,
        source: 'partner',
        id: 'msg-1',
        type: 'thing.created'
      });
      const c = await readJson(await send('GET', '/connections/partner', actors.member!));
      expect(c.lastDelivery).toMatchObject({ type: 'thing.created', outcome: 'processed' });
      const log = await readJson(await send('GET', '/connections/partner/deliveries', actors.admin!));
      expect(log.deliveries).toHaveLength(1);
      expect(log.deliveries[0]).toMatchObject({
        source: 'partner',
        deliveryId: 'msg-1',
        type: 'thing.created',
        outcome: 'processed',
        detail: 'took thing.created',
        error: null
      });
    });

    it('6. a repeat answers 200 duplicate and runs nothing; a changed body under the same id is a repeat too', async () => {
      const path = new URL(partnerUrl).pathname;
      const seen = connectionDeliveriesSeen.length;
      const body = JSON.stringify({ id: 'evt-1', type: 'thing.created', data: { thingId: 't1' } });
      const res = await knock(path, standardHeaders(partnerSecret, 'msg-1', body), body);
      expect(await readJson(res)).toEqual({ ok: true, duplicate: true });
      const other = JSON.stringify({ id: 'evt-1', type: 'thing.deleted' });
      expect(
        await readJson(await knock(path, standardHeaders(partnerSecret, 'msg-1', other), other))
      ).toEqual({ ok: true, duplicate: true });
      expect(connectionDeliveriesSeen.length).toBe(seen);
      expect(await app.db.db.select().from(connectionDeliveries)).toHaveLength(1);
    });

    it('7. a handler that fails: the writes roll back, the delivery is logged failed, and the retry runs it again', async () => {
      const path = new URL(partnerUrl).pathname;
      const body = JSON.stringify({ type: 'thing.explode' });
      const res = await knock(path, standardHeaders(partnerSecret, 'msg-boom', body), body);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: false, code: 'handler_failed', outcome: 'failed' });
      const log = await readJson(await send('GET', '/connections/partner/deliveries', actors.admin!));
      expect(log.deliveries[0]).toMatchObject({
        deliveryId: 'msg-boom',
        outcome: 'failed',
        error: 'the handler exploded'
      });
      const c = await readJson(await send('GET', '/connections/partner', actors.member!));
      expect(c.lastDelivery).toMatchObject({ type: 'thing.explode', outcome: 'failed' });
      // the sender retries the same id: not a duplicate, the handler runs again
      const seen = connectionDeliveriesSeen.length;
      const again = await knock(path, standardHeaders(partnerSecret, 'msg-boom', body), body);
      expect(await readJson(again)).toEqual({ ok: false, code: 'handler_failed', outcome: 'failed' });
      expect(connectionDeliveriesSeen.length).toBe(seen + 1);
      expect(await app.db.db.select().from(connectionDeliveries)).toHaveLength(2);
    });

    it('8. a ping is taken, logged ignored and stamps the card without reaching the handler; a stale timestamp is refused', async () => {
      const path = new URL(partnerUrl).pathname;
      const seen = connectionDeliveriesSeen.length;
      const ping = JSON.stringify({ id: 'evt-ping', type: 'webhook.ping', data: { endpointId: 'x' } });
      const res = await knock(path, standardHeaders(partnerSecret, 'msg-ping', ping), ping);
      expect(await readJson(res)).toEqual({ ok: true, outcome: 'ignored' });
      expect(connectionDeliveriesSeen.length).toBe(seen);
      const c = await readJson(await send('GET', '/connections/partner', actors.member!));
      expect(c.lastDelivery).toMatchObject({ type: 'webhook.ping', outcome: 'ignored' });
      const stale = await knock(
        path,
        standardHeaders(partnerSecret, 'msg-old', ping, NOW_SECONDS() - 600),
        ping
      );
      expect(stale.status).toBe(401);
    });

    it('9. a body that is not JSON is 400 and writes nothing; a body over the cap is 413 before it is read', async () => {
      const path = new URL(partnerUrl).pathname;
      const raw = 'not json';
      const res = await knock(path, standardHeaders(partnerSecret, 'msg-raw', raw), raw);
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_json');
      const big = JSON.stringify({ id: 'evt-big', type: 'thing.created', pad: 'x'.repeat(300 * 1024) });
      const huge = await knock(path, standardHeaders(partnerSecret, 'msg-big', big), big);
      expect(huge.status).toBe(413);
      const rows = await app.db.db.select().from(connectionDeliveries);
      expect(rows.map((r) => r.deliveryId)).not.toContain('msg-raw');
      expect(rows.map((r) => r.deliveryId)).not.toContain('msg-big');
    });

    it('10. the test of an inbound source says it is ready and names the last delivery; the check is kept', async () => {
      const res = await send('POST', '/connections/partner/test', actors.admin!);
      expect(res.status).toBe(200);
      const t = await readJson(res);
      expect(t.ok).toBe(true);
      expect(t.detail).toMatch(/^Ready: the last delivery was webhook.ping/);
      expect(t.connection.check).toMatchObject({ ok: true });
    });

    it('11. a rotation makes the old URL answer 404 and the new one deliver; the secret stays', async () => {
      const oldPath = new URL(partnerUrl).pathname;
      const res = await send('POST', '/connections/partner', actors.owner!);
      const made = await readJson(res);
      expect(made.receivingUrl).not.toBe(partnerUrl);
      partnerUrl = made.receivingUrl;
      const body = JSON.stringify({ id: 'evt-2', type: 'thing.created' });
      expect((await knock(oldPath, standardHeaders(partnerSecret, 'msg-2', body), body)).status).toBe(404);
      const ok = await knock(
        new URL(partnerUrl).pathname,
        standardHeaders(partnerSecret, 'msg-2', body),
        body
      );
      expect(ok.status).toBe(200);
      expect(made.connection.secret.set).toBe(true);
    });
  });

  describe("a source on Stripe's scheme", () => {
    it('12. the delivery id is the body id, the signature header is stripe-signature', async () => {
      const made = await readJson(await send('POST', '/connections/ledger', actors.admin!));
      const secret = 'whsec_ledger_test_secret_0123456789';
      expect((await send('PUT', '/connections/ledger/secret', actors.admin!, { secret })).status).toBe(200);
      const path = new URL(made.receivingUrl).pathname;
      const body = JSON.stringify({ id: 'evt_s1', type: 'payment.succeeded', data: { amount: 5 } });
      expect(await readJson(await knock(path, stripeHeaders(secret, body), body))).toEqual({
        ok: true,
        outcome: 'processed'
      });
      expect(connectionDeliveriesSeen.at(-1)).toMatchObject({
        source: 'ledger',
        id: 'evt_s1',
        type: 'payment.succeeded'
      });
      expect(await readJson(await knock(path, stripeHeaders(secret, body), body))).toEqual({
        ok: true,
        duplicate: true
      });
      const noId = JSON.stringify({ type: 'payment.succeeded' });
      const res = await knock(path, stripeHeaders(secret, noId), noId);
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_event');
    });
  });

  describe('a key source', () => {
    it('13. it has no receiving URL; a refused key is not stored; an unanswering source is 502; a good key is probed and its fields learned', async () => {
      await expectError(await send('POST', '/connections/vault', actors.admin!), 409, 'not_inbound');
      await expectError(
        await send('PUT', '/connections/vault/secret', actors.admin!, { secret: 'nope' }),
        400,
        'secret_invalid'
      );
      await expectError(
        await send('PUT', '/connections/vault/secret', actors.admin!, { secret: 'vk_bad' }),
        400,
        'secret_refused'
      );
      await expectError(
        await send('PUT', '/connections/vault/secret', actors.admin!, { secret: 'vk_down' }),
        502,
        'source_unavailable'
      );
      expect((await readJson(await send('GET', '/connections/vault', actors.admin!))).secret.set).toBe(false);
      const res = await send('PUT', '/connections/vault/secret', actors.admin!, { secret: 'vk_good' });
      expect(res.status).toBe(200);
      const c = await readJson(res);
      expect(c).toMatchObject({
        connected: true,
        url: null,
        secret: { set: true, readable: true },
        fields: { folder: 'root' },
        check: { ok: true, detail: 'Vault answered' }
      });
      expect(JSON.stringify(c)).not.toContain('vk_good');
    });

    it('14. the fields: a declared one is stored, a list field takes a list, null clears, an undeclared key is refused', async () => {
      const res = await send('PATCH', '/connections/vault', actors.owner!, {
        fields: { folder: 'invoices', labels: ['a', 'b'] }
      });
      expect(res.status).toBe(200);
      expect((await readJson(res)).fields).toEqual({ folder: 'invoices', labels: ['a', 'b'] });
      await expectError(
        await send('PATCH', '/connections/vault', actors.owner!, { fields: { colour: 'red' } }),
        400,
        'unknown_field'
      );
      const cleared = await readJson(
        await send('PATCH', '/connections/vault', actors.owner!, { fields: { labels: null } })
      );
      expect(cleared.fields).toEqual({ folder: 'invoices' });
      await expectError(
        await send('PATCH', '/connections/partner', actors.owner!, { fields: { folder: 'x' } }),
        400,
        'unknown_field'
      );
    });

    it('15. the test probes with the stored key and keeps the result', async () => {
      const t = await readJson(await send('POST', '/connections/vault/test', actors.admin!));
      expect(t).toMatchObject({ ok: true, detail: 'Vault answered' });
      expect(t.connection.check).toMatchObject({ ok: true, detail: 'Vault answered' });
      expect(t.connection.fields.folder).toBe('invoices');
    });

    it('15b. a value carried by a migration reads as readable, opens through the hook, and is re-sealed on first use; the tool reads its key and records a check', async () => {
      const legacy = `legacy:${Buffer.from('vk_good').toString('base64')}`;
      await app.db.db.execute(
        sql`UPDATE connections SET secret_sealed = ${legacy} WHERE workspace_id = ${workspaceId} AND source = 'vault'`
      );
      const before = await readJson(await send('GET', '/connections/vault', actors.member!));
      expect(before.secret).toMatchObject({ set: true, readable: true });
      // the tool's own read: opens through the hook and heals the row
      expect(await app.connections.secretOf(workspaceId, 'vault')).toBe('vk_good');
      const [row] = await app.db.db.select().from(connections).where(eq(connections.source, 'vault'));
      expect(row!.secretSealed!.startsWith('v1.')).toBe(true);
      expect(await app.connections.secretOf(workspaceId, 'vault')).toBe('vk_good');
      // a value the hook does not open stays unreadable
      await app.db.db.execute(sql`UPDATE connections SET secret_sealed = 'garbage' WHERE source = 'vault'`);
      expect((await readJson(await send('GET', '/connections/vault', actors.member!))).secret.readable).toBe(
        false
      );
      expect(await app.connections.secretOf(workspaceId, 'vault')).toBeNull();
      expect(
        (await send('PUT', '/connections/vault/secret', actors.admin!, { secret: 'vk_good' })).status
      ).toBe(200);
      // the tool records a check of its own and learns a field
      await app.connections.recordCheck(workspaceId, 'vault', false, 'the sync met a 503');
      expect(await app.connections.setFieldsOf(workspaceId, 'vault', { labels: ['x'] })).toMatchObject({
        labels: ['x']
      });
      const after = await readJson(await send('GET', '/connections/vault', actors.member!));
      expect(after.check).toMatchObject({ ok: false, detail: 'the sync met a 503' });
      expect(await app.connections.fieldsOf(workspaceId, 'vault')).toMatchObject({
        folder: 'invoices',
        labels: ['x']
      });
      expect(await app.connections.secretOf(workspaceId, 'nowhere').catch((e: Error) => e.message)).toBe(
        'No such connection source'
      );
    });

    it('16. a test before anything is connected is 409', async () => {
      const fresh = await createTestApp(await createDatabase(container, 'connections_fresh'));
      try {
        const setup = await fresh.app.request('/api/v1/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            setupToken: 'integration-test-setup-token',
            instanceName: 'Fresh',
            owner: OWNER
          })
        });
        expect(setup.status).toBe(201);
        const signed = await fresh.app.request('/api/v1/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OWNER.email, password: PASSWORD })
        });
        const cookie = extractCookie(signed);
        const res = await fresh.app.request('/api/v1/connections/vault/test', {
          method: 'POST',
          headers: { cookie }
        });
        await expectError(res, 409, 'not_connected');
        const secretFirst = await fresh.app.request('/api/v1/connections/partner/secret', {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ secret: partnerSecret })
        });
        await expectError(secretFirst, 409, 'not_connected');
      } finally {
        await fresh.stop();
      }
    });
  });

  describe('the rules', () => {
    it('17. a key reads with the read scope and writes with the webhooks scope only; a write key without it is refused', async () => {
      const readKey = await mintKey(actors.admin!.cookie, [host.scopes.read]);
      const writeKey = await mintKey(actors.admin!.cookie, [host.scopes.read, host.scopes.write]);
      const manageKey = await mintKey(actors.admin!.cookie, [host.scopes.read, WEBHOOKS_SCOPE]);
      expect((await send('GET', '/connections', { key: readKey })).status).toBe(200);
      // the log is a read: the read scope opens it, the handler's role rule still applies (an admin's key here)
      expect((await send('GET', '/connections/partner/deliveries', { key: readKey })).status).toBe(200);
      expect((await send('POST', '/connections/partner/test', { key: readKey })).status).toBe(403);
      expect((await send('POST', '/connections/partner/test', { key: writeKey })).status).toBe(403);
      expect((await send('POST', '/connections/partner/test', { key: manageKey })).status).toBe(200);
      // a member's key with the scope is still refused by the handler's role rule
      const memberKey = await mintKey(actors.member!.cookie, [host.scopes.read, WEBHOOKS_SCOPE]);
      await expectError(
        await send('POST', '/connections/partner/test', { key: memberKey }),
        403,
        'forbidden'
      );
    });

    it('18. a session a demo link opened reads the list and is refused every write', async () => {
      const refused = DEMO_SESSION_REFUSED_API_ROUTES.filter((r) => r.path.startsWith('/connections'));
      expect(refused.map((r) => r.method).sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
      const minted = await send('POST', '/demo/passes', actors.owner!, { email: actors.admin!.email });
      expect(minted.status).toBe(201);
      const { secret } = await readJson(minted);
      const redeemed = await send('POST', '/auth/demo/redeem', {}, { pass: secret });
      expect(redeemed.status).toBe(200);
      const demo = { cookie: extractCookie(redeemed) };
      expect((await send('GET', '/connections', demo)).status).toBe(200);
      await expectError(await send('POST', '/connections/partner/test', demo), 403, 'demo_session');
      await expectError(
        await send('PUT', '/connections/partner/secret', demo, { secret: partnerSecret }),
        403,
        'demo_session'
      );
      await expectError(await send('PATCH', '/connections/vault', demo, { fields: {} }), 403, 'demo_session');
      await expectError(await send('DELETE', '/connections/vault', demo), 403, 'demo_session');
    });

    it('19. the deliveries page by cursor, newest first', async () => {
      const first = await readJson(
        await send('GET', '/connections/partner/deliveries?limit=2', actors.admin!)
      );
      expect(first.deliveries).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await readJson(
        await send(
          'GET',
          `/connections/partner/deliveries?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
          actors.admin!
        )
      );
      expect(second.deliveries.length).toBeGreaterThan(0);
      const ids = [...first.deliveries, ...second.deliveries].map((d: { id: string }) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
      const times = [...first.deliveries, ...second.deliveries].map(
        (d: { receivedAt: string }) => d.receivedAt
      );
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('20. the purge deletes the old rows and keeps the fresh ones', async () => {
      await app.db.db.execute(
        sql`UPDATE connection_deliveries SET received_at = now() - interval '40 days' WHERE delivery_id = 'msg-1'`
      );
      expect(await app.connections.purge(30)).toBe(1);
      expect(await app.connections.purge(0)).toBe(0);
      const rows = await app.db.db.select().from(connectionDeliveries);
      expect(rows.map((r) => r.deliveryId)).not.toContain('msg-1');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('21. a disconnect takes the row and its log; the source stays on the page, disconnected; the old URL is 404', async () => {
      const path = new URL(partnerUrl).pathname;
      const res = await send('DELETE', '/connections/partner', actors.owner!);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toMatchObject({
        source: 'partner',
        connected: false,
        url: null,
        secret: { set: false },
        lastDelivery: null
      });
      const log = await readJson(await send('GET', '/connections/partner/deliveries', actors.admin!));
      expect(log.deliveries).toHaveLength(0);
      const body = JSON.stringify({ id: 'evt-3', type: 'thing.created' });
      expect((await knock(path, standardHeaders(partnerSecret, 'msg-3', body), body)).status).toBe(404);
      const list = await readJson(await send('GET', '/connections', actors.member!));
      expect(list.connections.map((c: { source: string }) => c.source)).toEqual([
        'partner',
        'ledger',
        'vault'
      ]);
    });
  });
});
