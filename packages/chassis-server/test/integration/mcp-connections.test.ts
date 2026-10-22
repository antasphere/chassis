import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { signWebhook } from '@antasphere/chassis-server/webhooks';
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
 * The nine CONNECTION tools the chassis registers after the webhook tools
 * (PRDCT-3773, PRDCT-3774), driven as a real MCP client would: raw JSON-RPC POSTs against
 * the stateless /mcp, authenticated with the host's own API keys.
 *
 * A read-only key lists the sources and reads a source's deliveries, and is
 * told in words that every write needs the webhooks scope. A key holding that
 * scope runs the life of the host's sources through the tools alone: the
 * receiving URL made once, the signing secret set (never answered back), a
 * signed delivery taken at the door and read back, a key source's refused and
 * accepted keys, its fields, the tests, the disconnect. An undeclared source
 * answers not_found and a key source has no receiving URL (not_inbound).
 * The sibling connect runs on the oss edition here, so it answers
 * sibling_unavailable for the sibling source and not_sibling for any other;
 * the cloud end-to-end is connections-sibling.test.ts.
 *
 * Nothing here spells a tool's prefix or scope names: they come from `host`.
 * The sources are the chassis's minimal test tool's (`partner`, `twin`,
 * `ledger`, `vault`); a host that declares none skips the file.
 */
const PASSWORD = 'a-long-mcp-connections-password-1';
const OWNER = { email: 'owner@mcp-connections.test', name: 'Cora Owner', password: PASSWORD };

const PREFIX = host.identity.mcp.toolPrefix;
const WEBHOOKS_SCOPE = host.identity.scopes.webhooks;

/** In `tools/list` order, the order the chassis registers them. */
const CONNECTION_TOOLS = [
  'list_connections',
  'connect_source',
  'set_connection_secret',
  'set_connection_fields',
  'test_connection',
  'disconnect_source',
  'connection_deliveries',
  'connect_sibling',
  'disconnect_sibling'
].map((name) => `${PREFIX}${name}`);

const TOOL = {
  list: `${PREFIX}list_connections`,
  connect: `${PREFIX}connect_source`,
  secret: `${PREFIX}set_connection_secret`,
  fields: `${PREFIX}set_connection_fields`,
  test: `${PREFIX}test_connection`,
  disconnect: `${PREFIX}disconnect_source`,
  deliveries: `${PREFIX}connection_deliveries`,
  connectSibling: `${PREFIX}connect_sibling`,
  disconnectSibling: `${PREFIX}disconnect_sibling`
};

let container: StartedPostgreSqlContainer;
let app: TestApp;
/** The read-only key reads; the managing key holds the read and the webhooks scopes. */
let readKey = '';
let manageKey = '';

let ipCounter = 0;
const nextIp = () => `10.91.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

/** The tool call must have failed with this code, its `Next:` sentence returned (null when the code carries none). */
async function refused(key: string, name: string, args: Record<string, unknown>, code: string) {
  const res = await callTool(key, name, args);
  expect(res.isError, `${name} should have failed: ${res.text}`).toBe(true);
  expect(res.text).toContain(`code: ${code}`);
  return { text: res.text, hint: res.text.split(' — Next: ')[1] ?? null };
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

/** A delivery at the door, signed on the standard scheme. */
async function knock(receivingUrl: string, secret: string, id: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const at = Math.floor(Date.now() / 1000);
  return app.app.request(new URL(receivingUrl).pathname, {
    method: 'POST',
    headers: {
      'x-forwarded-for': nextIp(),
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(at),
      'webhook-signature': signWebhook([secret], id, at, body)
    },
    body
  });
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

describe.skipIf(!WEBHOOKS_SCOPE || !host.connections)('the connection tools', () => {
  const scope = WEBHOOKS_SCOPE!;

  beforeAll(async () => {
    container = await startPostgres();
    app = await createTestApp(await createDatabase(container, 'mcp_connections'));

    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'MCP Connections', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const ownerCookie = await signIn(OWNER.email);
    readKey = await mintKey(ownerCookie, 'owner-read', [host.scopes.read]);
    manageKey = await mintKey(ownerCookie, 'owner-connections', [host.scopes.read, scope]);
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    await container?.stop();
  });

  describe('they are served under the host prefix', () => {
    it('tools/list carries the nine right after the webhook tools, the reads flagged read-only', async () => {
      interface ToolInfo {
        name: string;
        description: string;
        inputSchema?: { properties?: Record<string, unknown> };
        annotations?: { readOnlyHint?: boolean };
      }
      const tools = (await rpc(readKey, 'tools/list')).tools as ToolInfo[];
      const names = tools.map((t) => t.name);
      const after = names.indexOf(`${PREFIX}redeliver_webhook`);
      expect(after, 'the webhook tools are listed').toBeGreaterThan(-1);
      expect(names.slice(after + 1, after + 1 + CONNECTION_TOOLS.length)).toEqual(CONNECTION_TOOLS);

      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const name of CONNECTION_TOOLS) {
        expect(byName.get(name)!.inputSchema?.properties?.workspace, `${name} lacks workspace`).toBeDefined();
      }
      for (const name of [TOOL.list, TOOL.deliveries]) {
        expect(byName.get(name)!.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      }
      for (const name of [
        TOOL.connect,
        TOOL.secret,
        TOOL.fields,
        TOOL.test,
        TOOL.disconnect,
        TOOL.connectSibling,
        TOOL.disconnectSibling
      ]) {
        expect(byName.get(name)!.annotations?.readOnlyHint, `${name} readOnlyHint`).not.toBe(true);
      }
      expect(byName.get(TOOL.connect)!.description).toContain('receivingUrl');
      expect(byName.get(TOOL.deliveries)!.description).toContain('read scope');
      expect(byName.get(TOOL.connectSibling)!.description).toContain('AS THE PERSON');
      expect(byName.get(TOOL.connectSibling)!.description).toContain('never a URL, never a secret');
      expect(byName.get(TOOL.disconnectSibling)!.description).toContain('deleted on the sibling first');
    });
  });

  describe('a read-only key', () => {
    it('lists the declared sources, every one disconnected', async () => {
      const { connections } = await ok(readKey, TOOL.list);
      expect(connections.map((c: { source: string }) => c.source)).toEqual([
        'partner',
        'twin',
        'ledger',
        'vault'
      ]);
      for (const c of connections) {
        expect(c).toMatchObject({ connected: false, receiving: null, secretState: { set: false } });
      }
      expect(connections[0].declared).toMatchObject({
        verifier: 'standard-webhooks',
        events: ['thing.created', 'thing.deleted'],
        secretHint: 'whsec_…'
      });
      expect(connections[3]).toMatchObject({ kind: 'key' });
    });

    it('is refused every write with the webhooks scope sentence, and nothing changes', async () => {
      const writes: Array<[string, Record<string, unknown>]> = [
        [TOOL.connect, { source: 'partner' }],
        [TOOL.secret, { source: 'vault', secret: 'vk_good' }],
        [TOOL.fields, { source: 'vault', fields: { folder: 'x' } }],
        [TOOL.test, { source: 'vault' }],
        [TOOL.disconnect, { source: 'partner' }],
        [TOOL.connectSibling, { source: 'twin' }],
        [TOOL.disconnectSibling, { source: 'twin' }]
      ];
      for (const [name, args] of writes) {
        const res = await callTool(readKey, name, args);
        expect(res.isError, `${name}: ${res.text}`).toBe(true);
        expect(res.text).toContain(`Missing scope "${scope}"`);
        expect(res.text).toContain('permission to manage webhooks');
        expect(res.text).not.toContain('vk_good');
      }
      const { connections } = await ok(readKey, TOOL.list);
      expect(connections.every((c: { connected: boolean }) => !c.connected)).toBe(true);
    });

    it('reads a source’s deliveries under the read scope alone', async () => {
      const log = await ok(readKey, TOOL.deliveries, { source: 'partner' });
      expect(log).toEqual({ deliveries: [], nextCursor: null });
    });
  });

  describe('a key with the webhooks scope runs the life of the sources through the tools', () => {
    let receivingUrl = '';
    const partnerSecret = `whsec_${Buffer.from(randomUUID()).toString('base64')}`;

    it('makes the receiving URL once: the answer carries it, the list never does', async () => {
      const made = await ok(manageKey, TOOL.connect, { source: 'partner' });
      expect(made.receivingUrl).toMatch(/\/hooks\/partner\/[A-Za-z0-9_-]{40,}$/);
      expect(made.connection).toMatchObject({
        source: 'partner',
        receiving: { madeBy: { email: OWNER.email } }
      });
      receivingUrl = made.receivingUrl;

      const list = await callTool(readKey, TOOL.list);
      expect(list.isError).toBe(false);
      expect(list.text).not.toContain(tokenOf(receivingUrl));
    });

    it('sets the signing secret, and the answer never carries the value', async () => {
      const res = await callTool(manageKey, TOOL.secret, { source: 'partner', secret: partnerSecret });
      expect(res.isError, res.isError ? 'set_connection_secret failed' : '').toBe(false);
      expect(res.text).not.toContain(partnerSecret);
      expect(res.data).toMatchObject({
        source: 'partner',
        connected: true,
        secretState: { set: true, setBy: { email: OWNER.email } }
      });
    });

    it('a signed delivery taken at the door reads back through the read-only key', async () => {
      const door = await knock(receivingUrl, partnerSecret, 'msg-mcp-1', {
        id: 'evt-mcp-1',
        type: 'thing.created',
        data: { thingId: 't1' }
      });
      expect(door.status).toBe(200);

      const log = await ok(readKey, TOOL.deliveries, { source: 'partner' });
      expect(log.deliveries).toHaveLength(1);
      expect(log.deliveries[0]).toMatchObject({
        source: 'partner',
        deliveryId: 'msg-mcp-1',
        type: 'thing.created',
        outcome: 'processed',
        error: null
      });
      expect(log).toHaveProperty('nextCursor', null);
    });

    it('tests the inbound source: ready, the check kept', async () => {
      const t = await ok(manageKey, TOOL.test, { source: 'partner' });
      expect(t.ok).toBe(true);
      expect(t.connection).toMatchObject({ source: 'partner', check: { ok: true } });
    });

    it('a key the source refuses surfaces secret_refused and is not stored', async () => {
      const { text, hint } = await refused(
        manageKey,
        TOOL.secret,
        { source: 'vault', secret: 'vk_bad' },
        'secret_refused'
      );
      expect(text).not.toContain('vk_bad');
      expect(hint, `no "Next:" sentence in: ${text}`).toContain('Nothing was stored');
      const { connections } = await ok(readKey, TOOL.list);
      const vault = connections.find((c: { source: string }) => c.source === 'vault');
      expect(vault.secretState.set).toBe(false);
    });

    it('a key the source accepts is stored, never answered back', async () => {
      const res = await callTool(manageKey, TOOL.secret, { source: 'vault', secret: 'vk_good' });
      expect(res.isError, res.isError ? 'set_connection_secret failed' : '').toBe(false);
      expect(res.text).not.toContain('vk_good');
      expect(res.data).toMatchObject({
        source: 'vault',
        connected: true,
        receiving: null,
        secretState: { set: true },
        check: { ok: true, detail: 'Vault answered' }
      });
    });

    it('sets the declared fields, a list field taking a list', async () => {
      const c = await ok(manageKey, TOOL.fields, {
        source: 'vault',
        fields: { folder: 'invoices', labels: ['a', 'b'] }
      });
      expect(c.fields).toEqual({ folder: 'invoices', labels: ['a', 'b'] });

      const { hint } = await refused(
        manageKey,
        TOOL.fields,
        { source: 'vault', fields: { colour: 'red' } },
        'unknown_field'
      );
      expect(hint).toContain('declared.fields');
    });

    it('tests the key source: probed with the stored key, the result kept', async () => {
      const t = await ok(manageKey, TOOL.test, { source: 'vault' });
      expect(t).toMatchObject({ ok: true, detail: 'Vault answered' });
      expect(t.connection).toMatchObject({ check: { ok: true }, fields: { folder: 'invoices' } });
    });

    it('disconnects the inbound source: its URL, secret and log are gone, the source stays listed', async () => {
      const c = await ok(manageKey, TOOL.disconnect, { source: 'partner' });
      expect(c).toMatchObject({
        source: 'partner',
        connected: false,
        receiving: null,
        secretState: { set: false },
        lastDelivery: null
      });
      const log = await ok(readKey, TOOL.deliveries, { source: 'partner' });
      expect(log.deliveries).toEqual([]);
      const { connections } = await ok(readKey, TOOL.list);
      expect(connections.map((x: { source: string }) => x.source)).toEqual([
        'partner',
        'twin',
        'ledger',
        'vault'
      ]);
    });
  });

  describe('the refusals read as words', () => {
    it('an undeclared source answers not_found, on a read and on a write', async () => {
      const read = await refused(readKey, TOOL.deliveries, { source: 'nowhere' }, 'not_found');
      expect(read.text).toContain('HTTP 404');
      const write = await refused(manageKey, TOOL.connect, { source: 'nowhere' }, 'not_found');
      expect(write.text).toContain('HTTP 404');
    });

    it('a key source is refused a receiving URL (not_inbound), told to set its key instead', async () => {
      const { text, hint } = await refused(manageKey, TOOL.connect, { source: 'vault' }, 'not_inbound');
      expect(hint, `no "Next:" sentence in: ${text}`).toContain('set its key instead');
    });

    it('the sibling connect on an instance off any hub answers sibling_unavailable, and nothing changes', async () => {
      const before = await ok(readKey, TOOL.list);
      for (const name of [TOOL.connectSibling, TOOL.disconnectSibling]) {
        const { text, hint } = await refused(manageKey, name, { source: 'twin' }, 'sibling_unavailable');
        expect(text).toContain('HTTP 409');
        expect(hint, `no "Next:" sentence in: ${text}`).toContain('not on a hub');
      }
      const after = await ok(readKey, TOOL.list);
      expect(after).toEqual(before);
      const twin = after.connections.find((c: { source: string }) => c.source === 'twin');
      expect(twin.declared.sibling).toEqual({ toolSlug: 'twin', events: ['thing.created'] });
      expect(twin).toMatchObject({ connected: false, receiving: null, secretState: { set: false } });
    });

    it('a source that is not a sibling answers not_sibling, told to connect it by hand', async () => {
      const { text, hint } = await refused(
        manageKey,
        TOOL.connectSibling,
        { source: 'partner' },
        'not_sibling'
      );
      expect(text).toContain('HTTP 409');
      expect(hint, `no "Next:" sentence in: ${text}`).toContain(`${PREFIX}connect_source`);
      expect(hint).toContain(`${PREFIX}set_connection_secret`);
    });
  });
});
