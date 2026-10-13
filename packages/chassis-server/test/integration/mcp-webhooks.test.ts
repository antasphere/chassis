import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  SETUP_TOKEN,
  host
} from './helpers.js';

/**
 * The eleven WEBHOOK tools the chassis registers after the team reads
 * (PRDCT-3482), driven as a real MCP client would: raw JSON-RPC POSTs against
 * the stateless /mcp, authenticated with the host's own API keys.
 *
 * An owner runs the whole life of an endpoint through the tools alone (the
 * catalog, create with its once-shown secret, list, read, change the events,
 * rotate the secret, a test ping, its delivery read back and redelivered,
 * delete), and the refusals read as words: a key without the webhooks scope
 * is told which scope is missing yet still reads the catalog, and a plain
 * member holding the scope is told only an owner or an admin manages
 * webhooks. Nothing is delivered for real: the test ping targets a name that
 * resolves to no address (the server-side suite covers delivery).
 *
 * Nothing here spells a tool's prefix, scope names or event types beyond the
 * family the host's catalog carries: they come from `host`. A host whose tool
 * declares no webhooks scope serves none of these tools, and the file skips.
 */
const PASSWORD = 'a-long-mcp-webhooks-password-1';
const OWNER = { email: 'owner@mcp-webhooks.test', name: 'Wanda Owner', password: PASSWORD };

const PREFIX = host.identity.mcp.toolPrefix;
const WEBHOOKS_SCOPE = host.identity.scopes.webhooks;

/** In `tools/list` order, the order the chassis registers them. */
const WEBHOOK_TOOLS = [
  'webhook_events',
  'list_webhooks',
  'create_webhook',
  'get_webhook',
  'update_webhook',
  'delete_webhook',
  'rotate_webhook_secret',
  'test_webhook',
  'list_webhook_deliveries',
  'get_webhook_delivery',
  'redeliver_webhook'
].map((name) => `${PREFIX}${name}`);

const TOOL = {
  events: `${PREFIX}webhook_events`,
  list: `${PREFIX}list_webhooks`,
  create: `${PREFIX}create_webhook`,
  get: `${PREFIX}get_webhook`,
  update: `${PREFIX}update_webhook`,
  remove: `${PREFIX}delete_webhook`,
  rotate: `${PREFIX}rotate_webhook_secret`,
  test: `${PREFIX}test_webhook`,
  deliveries: `${PREFIX}list_webhook_deliveries`,
  delivery: `${PREFIX}get_webhook_delivery`,
  redeliver: `${PREFIX}redeliver_webhook`
};

/** The address of the test ping: `.invalid` never resolves (RFC 2606), so nothing leaves the machine. */
const UNREACHABLE_URL = 'https://example.invalid/hooks';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
/** The owner's key holds read, write and webhooks; the other two prove the refusals. */
let ownerKey = '';
let noWebhooksKey = '';
let memberKey = '';

let ipCounter = 0;
const nextIp = () => `10.89.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let rpcId = 0;

/** JSON-RPC result over the stateless /mcp (throws on protocol-level errors). */
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

/** Parse a tool's JSON text block; an error text is not JSON → null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMaybe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(key, 'tools/call', { name, arguments: args });
  const text: string = result.content?.[0]?.text ?? '';
  return { isError: result.isError === true, text, data: parseMaybe(text) };
}

/** The tool call must have succeeded — the text is shown when it did not. */
async function ok(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await callTool(key, name, args);
  expect(res.isError, `${name}: ${res.text}`).toBe(false);
  return res.data;
}

async function mintKey(cookie: string, name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie }));
  expect(res.status, `minting ${name}`).toBe(201);
  return (await readJson(res)).key as string;
}

async function signIn(email: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password: PASSWORD }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

describe.skipIf(!WEBHOOKS_SCOPE)('the webhook tools', () => {
  const scope = WEBHOOKS_SCOPE!;

  beforeAll(async () => {
    container = await startPostgres();
    app = await createTestApp(await createDatabase(container, 'mcp_webhooks'));

    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'MCP Webhooks', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const ownerCookie = await signIn(OWNER.email);
    ownerKey = await mintKey(ownerCookie, 'owner-webhooks', [host.scopes.read, host.scopes.write, scope]);
    noWebhooksKey = await mintKey(ownerCookie, 'owner-rw', [host.scopes.read, host.scopes.write]);
    workspaceId = (await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } })))
      .workspace.id;

    const email = 'member@mcp-webhooks.test';
    const created = await app.auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Milo Member' }
    });
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId, userId: created.user.id, role: 'member', origin: 'local' });
    memberKey = await mintKey(await signIn(email), 'member-webhooks', [host.scopes.read, scope]);
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    await container?.stop();
  });

  describe('they are served under the host prefix', () => {
    it('tools/list carries the eleven right after the team reads, reads flagged read-only', async () => {
      interface ToolInfo {
        name: string;
        description: string;
        inputSchema?: { properties?: Record<string, unknown> };
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
      }
      const tools = (await rpc(ownerKey, 'tools/list')).tools as ToolInfo[];
      const names = tools.map((t) => t.name);
      const after = names.indexOf(`${PREFIX}list_team_members`);
      expect(after, 'the team reads are listed').toBeGreaterThan(-1);
      expect(names.slice(after + 1, after + 1 + WEBHOOK_TOOLS.length)).toEqual(WEBHOOK_TOOLS);

      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const name of WEBHOOK_TOOLS) {
        expect(byName.get(name)!.inputSchema?.properties?.workspace, `${name} lacks workspace`).toBeDefined();
      }
      for (const name of [TOOL.events, TOOL.list, TOOL.get, TOOL.deliveries, TOOL.delivery]) {
        expect(byName.get(name)!.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      }
      expect(byName.get(TOOL.remove)!.annotations?.destructiveHint).toBe(true);
      expect(byName.get(TOOL.create)!.description).toContain('whsec_');
      expect(byName.get(TOOL.create)!.description).toContain('Standard Webhooks');
      expect(byName.get(TOOL.rotate)!.description).toContain('previousSecretExpiresAt');
      expect(byName.get(TOOL.events)!.description).toContain('thing.*');
    });
  });

  describe('an owner runs the life of an endpoint through the tools', () => {
    let webhookId = '';
    let firstSecret = '';
    let deliveryId = '';
    let eventId = '';

    it('reads the catalog', async () => {
      const catalog = await ok(ownerKey, TOOL.events);
      const types = catalog.events.map((e: { type: string }) => e.type);
      expect(types).toContain('thing.created');
      const created = catalog.events.find((e: { type: string }) => e.type === 'thing.created');
      expect(created.schema).toBeTypeOf('object');
      expect(catalog.subjects.map((s: { key: string }) => s.key)).toContain('thing');
    });

    it('creates one, and the answer carries its secret once', async () => {
      const created = await ok(ownerKey, TOOL.create, {
        url: UNREACHABLE_URL,
        events: ['thing.created'],
        description: 'The MCP suite',
        filters: { thing: ['t-1'] }
      });
      expect(created.secret).toMatch(/^whsec_/);
      expect(created.url).toBe(UNREACHABLE_URL);
      expect(created.events).toEqual(['thing.created']);
      expect(created.filters).toEqual({ thing: ['t-1'] });
      expect(created.enabled).toBe(true);
      webhookId = created.id;
      firstSecret = created.secret;
    });

    it('lists it and reads it back, never with the secret', async () => {
      const list = await ok(ownerKey, TOOL.list);
      expect(list.webhooks.map((w: { id: string }) => w.id)).toContain(webhookId);
      expect(list).toHaveProperty('nextCursor');
      const one = await ok(ownerKey, TOOL.get, { webhookId });
      expect(one.id).toBe(webhookId);
      expect(one).not.toHaveProperty('secret');
    });

    it('changes the events, and refuses a call that changes nothing', async () => {
      const updated = await ok(ownerKey, TOOL.update, { webhookId, events: ['thing.*'] });
      expect(updated.events).toEqual(['thing.*']);
      expect(updated.filters).toEqual({ thing: ['t-1'] });

      const nothing = await callTool(ownerKey, TOOL.update, { webhookId });
      expect(nothing.isError).toBe(true);
      expect(nothing.text).toContain('Nothing to change');
    });

    it('refuses an address the instance does not deliver to, in words', async () => {
      const refused = await callTool(ownerKey, TOOL.update, {
        webhookId,
        url: 'https://example.com:8443/hooks'
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('url_refused');
      expect(refused.text).toContain(' — Next: ');
    });

    it('rotates the secret: a new one, the previous signing until a date', async () => {
      const rotated = await ok(ownerKey, TOOL.rotate, { webhookId });
      expect(rotated.secret).toMatch(/^whsec_/);
      expect(rotated.secret).not.toBe(firstSecret);
      expect(Date.parse(rotated.previousSecretExpiresAt)).toBeGreaterThan(Date.now());
    });

    it('sends a test ping, which fails on an address that resolves to nothing', async () => {
      const result = await ok(ownerKey, TOOL.test, { webhookId });
      expect(result.delivery.eventType).toBe('webhook.ping');
      expect(result.delivery.status).toBe('failed');
      expect(result.delivery.lastError).toBeTruthy();
      deliveryId = result.delivery.id;
      eventId = result.delivery.eventId;
    }, 30_000);

    it('lists the delivery, by status too, and reads it', async () => {
      const failed = await ok(ownerKey, TOOL.deliveries, { webhookId, status: 'failed' });
      expect(failed.deliveries.map((d: { id: string }) => d.id)).toContain(deliveryId);
      const delivered = await ok(ownerKey, TOOL.deliveries, { webhookId, status: 'delivered' });
      expect(delivered.deliveries).toEqual([]);
      const one = await ok(ownerKey, TOOL.delivery, { webhookId, deliveryId });
      expect(one.id).toBe(deliveryId);
      expect(one.payload).toBeTypeOf('object');
    });

    it('redelivers it as a new delivery of the same event', async () => {
      const again = await ok(ownerKey, TOOL.redeliver, { webhookId, deliveryId });
      expect(again.id).not.toBe(deliveryId);
      expect(again.eventId).toBe(eventId);
    });

    it('deletes it, and it is gone', async () => {
      const removed = await ok(ownerKey, TOOL.remove, { webhookId });
      expect(removed.id).toBe(webhookId);
      const list = await ok(ownerKey, TOOL.list);
      expect(list.webhooks.map((w: { id: string }) => w.id)).not.toContain(webhookId);
      const gone = await callTool(ownerKey, TOOL.get, { webhookId });
      expect(gone.isError).toBe(true);
      expect(gone.text).toContain('not_found');
    });
  });

  describe('the refusals read as words', () => {
    it('a key without the webhooks scope is told so, and still reads the catalog', async () => {
      const denied = await callTool(noWebhooksKey, TOOL.list);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain(`Missing scope "${scope}"`);

      const catalog = await ok(noWebhooksKey, TOOL.events);
      expect(catalog.events.map((e: { type: string }) => e.type)).toContain('thing.created');
    });

    it('a plain member holding the scope is told only an owner or an admin manages webhooks', async () => {
      const refused = await callTool(memberKey, TOOL.list);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('code: forbidden');
      const hint = refused.text.split(' — Next: ')[1];
      expect(hint, `no "Next:" sentence in: ${refused.text}`).toMatch(/owner or an admin/);

      const create = await callTool(memberKey, TOOL.create, { url: UNREACHABLE_URL, events: ['*'] });
      expect(create.isError).toBe(true);
      expect(create.text).toContain('code: forbidden');

      // The catalog stays every member's.
      await ok(memberKey, TOOL.events);
    });
  });
});
