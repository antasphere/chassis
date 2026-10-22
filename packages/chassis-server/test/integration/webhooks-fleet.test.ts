import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { createDatabase, createTestApp, host, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The fleet (PRDCT-3772) end to end on the cloud edition: the hub's
 * `GET /tool-origins` read at boot and on refresh, a webhook on a sibling's
 * origin accepted at registration and delivered to a PRIVATE address (the
 * loopback receiver, through the real node transport, the lookup seam
 * standing in for a stack's DNS), the same address on a stranger refused, an
 * origin the hub adds passing after a refresh, a hub that stops answering
 * keeping the last list, and a boot with the hub down opening nothing until
 * the hub answers again.
 */

const ORG = '77777777-aaaa-4bbb-8ccc-00000000f001';
const HUB_SECRET = 'integration-test-hub-secret-fleet';
const ADMIN: HubUserFixture = {
  sub: 'hub-user-fleet',
  email: 'fleet-admin@example.com',
  name: 'Fleet Admin',
  workspaceId: ORG,
  role: 'admin',
  workspaceName: 'Fleet Org'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let cookie = '';
let workspaceId = '';

// ── The receiver: a loopback server the fleet names as a sibling ─────────────
let server: http.Server;
let siblingOrigin = '';
let siblingPort = 0;
const received: Array<{ url: string; body: string; headers: http.IncomingHttpHeaders }> = [];

const headers = () => ({ cookie, 'x-workspace-id': workspaceId, 'x-forwarded-for': sso.nextIp() });
const send = (method: string, path: string, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: { ...headers(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function cloudEnv() {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: HUB_SECRET
  };
}

/** Every host name resolves to the loopback: what a stack's DNS does with a sibling's public name. */
const stackDns = { lookup: async () => [{ address: '127.0.0.1', family: 4 }] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers
      });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  siblingPort = (server.address() as AddressInfo).port;
  // The sibling's public name: a host name on http and a port, as a laptop stack names it.
  siblingOrigin = `http://crm.stack.localhost:${siblingPort}`;

  [container, hub] = await Promise.all([
    startPostgres(),
    FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET })
  ]);
  hub.setTools([
    { slug: 'crm', name: 'CRM', launchUrl: `${siblingOrigin}/welcome` },
    { slug: 'meet', name: 'Meet', launchUrl: 'https://meet.example.com' }
  ]);
  app = await createTestApp(await createDatabase(container, 'webhooks_fleet'), cloudEnv(), {
    webhookDials: { listenerTtlMs: 0, timeoutMs: 2000 },
    webhookFetch: stackDns,
    fleetOriginsDials: { refreshMs: 60_000, retryMs: 60_000, timeoutMs: 2000 }
  });
  cookie = await sso.ssoLogin(app, hub, ADMIN);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  workspaceId = me.activeWorkspaceId;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe.skipIf(!host.webhooks)('the fleet is read at boot', () => {
  it('the boot read the hub once, with no credential, and holds the registry origins', () => {
    expect(hub.toolOriginsRequests).toHaveLength(1);
    expect(hub.toolOriginsRequests[0]!.auth).toBeNull();
    expect(app.fleetOrigins).not.toBeNull();
    expect([...app.fleetOrigins!.get()].sort()).toEqual([siblingOrigin, 'https://meet.example.com'].sort());
    expect(app.fleetOrigins!.fetchedAt).not.toBeNull();
    expect(app.fleetOrigins!.lastError).toBeNull();
  });
});

describe.skipIf(!host.webhooks)('a webhook on a sibling of the same hub', () => {
  let endpointId = '';

  it('is accepted at registration on the cloud edition although it is http on a port', async () => {
    const res = await send('POST', '/webhooks', {
      url: `${siblingOrigin}/hooks/meet/token-1`,
      events: ['thing.*']
    });
    expect(res.status).toBe(201);
    endpointId = (await readJson(res)).id;
  });

  it('is delivered to the private address the sibling resolves to, through the real transport', async () => {
    const before = received.length;
    const ok = await send('POST', `/webhooks/${endpointId}/test`);
    expect(ok.status).toBe(200);
    const { delivery } = await readJson(ok);
    expect(delivery).toMatchObject({ status: 'delivered', eventType: 'webhook.ping', lastStatusCode: 200 });
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.url).toBe('/hooks/meet/token-1');
    expect(received.at(-1)!.headers.host).toBe(`crm.stack.localhost:${siblingPort}`);
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({ type: 'webhook.ping' });
  });

  it('the same private address on a stranger is still refused at registration, and the receiver never sees it', async () => {
    const before = received.length;
    // https (the cloud rule) on a host that is not a fleet origin, resolving to the same loopback.
    const res = await send('POST', '/webhooks', {
      url: 'https://stranger.example.com/hook',
      events: ['thing.*']
    });
    // Accepted at registration (a public-looking https URL): the address is judged at delivery.
    expect(res.status).toBe(201);
    const stranger = (await readJson(res)).id;
    const ping = await send('POST', `/webhooks/${stranger}/test`);
    expect(ping.status).toBe(200);
    const { delivery } = await readJson(ping);
    expect(delivery).toMatchObject({ status: 'failed', lastError: 'url_refused:private_address' });
    expect(received.length).toBe(before);
    // And a stranger on http with a port never gets past registration.
    const http = await send('POST', '/webhooks', {
      url: `http://stranger.stack.localhost:${siblingPort}/hook`,
      events: ['thing.*']
    });
    expect(http.status).toBe(400);
    expect((await readJson(http)).error.code).toBe('url_refused');
  });
});

describe.skipIf(!host.webhooks)('the list follows the hub', () => {
  it('an origin the hub adds passes after a refresh, and not before', async () => {
    const late = `http://late.stack.localhost:${siblingPort}`;
    const refused = await send('POST', '/webhooks', { url: `${late}/hook`, events: ['thing.*'] });
    expect(refused.status).toBe(400);

    hub.setTools([
      { slug: 'crm', name: 'CRM', launchUrl: `${siblingOrigin}/welcome` },
      { slug: 'late', name: 'Late Tool', launchUrl: late }
    ]);
    const read = await app.fleetOrigins!.refresh();
    expect(read).toEqual({ ok: true, count: 2 });
    expect(app.fleetOrigins!.get().has(late)).toBe(true);
    expect(app.fleetOrigins!.get().has('https://meet.example.com')).toBe(false);

    const accepted = await send('POST', '/webhooks', { url: `${late}/hook`, events: ['thing.*'] });
    expect(accepted.status).toBe(201);
  });

  it('a hub that stops answering keeps the last list: the sibling still delivers, nothing new opens', async () => {
    hub.toolOriginsMode = 'network';
    const down = await app.fleetOrigins!.refresh();
    expect(down.ok).toBe(false);
    expect(down.count).toBe(2);
    expect(app.fleetOrigins!.lastError).toMatch(/TypeError|fetch failed|socket/i);
    expect(app.fleetOrigins!.get().has(siblingOrigin)).toBe(true);

    hub.toolOriginsMode = 'http500';
    const broken = await app.fleetOrigins!.refresh();
    expect(broken).toMatchObject({ ok: false, count: 2, error: 'Error: HTTP 500' });

    const before = received.length;
    const res = await send('POST', '/webhooks', {
      url: `${siblingOrigin}/hooks/meet/token-2`,
      events: ['thing.*']
    });
    expect(res.status).toBe(201);
    const ping = await send('POST', `/webhooks/${(await readJson(res)).id}/test`);
    expect((await readJson(ping)).delivery.status).toBe('delivered');
    expect(received.length).toBe(before + 1);

    hub.toolOriginsMode = 'ok';
    const back = await app.fleetOrigins!.refresh();
    expect(back.ok).toBe(true);
    expect(app.fleetOrigins!.lastError).toBeNull();
  });
});

describe.skipIf(!host.webhooks)('a boot with the hub down', () => {
  it('opens nothing, then takes the list at the first refresh that answers', async () => {
    hub.toolOriginsMode = 'network';
    const cold = await createTestApp(await createDatabase(container, 'webhooks_fleet_cold'), cloudEnv(), {
      webhookFetch: stackDns,
      fleetOriginsDials: { refreshMs: 200, retryMs: 200, timeoutMs: 1000 }
    });
    try {
      expect(cold.fleetOrigins!.get().size).toBe(0);
      expect(cold.fleetOrigins!.fetchedAt).toBeNull();
      expect(cold.fleetOrigins!.lastError).not.toBeNull();
      hub.toolOriginsMode = 'ok';
      // The retry timer (200 ms) reads the hub on its own: no call from here.
      const size = await until(
        () => cold.fleetOrigins!.get().size,
        (n) => n > 0,
        10_000
      );
      expect(size).toBe(2);
      expect(cold.fleetOrigins!.fetchedAt).not.toBeNull();
    } finally {
      await cold.stop();
    }
  });
});

describe.skipIf(!host.webhooks)('an oss boot', () => {
  it('has no fleet', async () => {
    const oss = await createTestApp(await createDatabase(container, 'webhooks_fleet_oss'));
    try {
      expect(oss.fleetOrigins).toBeNull();
    } finally {
      await oss.stop();
    }
  });
});
