import net from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, isNull } from 'drizzle-orm';
import { apiKeys, auditLog, connections } from '@antasphere/chassis-db';
import { FakeHub, LEGACY_GRANT_SCOPE, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { createDatabase, createTestApp, host, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The sibling connect end to end (PRDCT-3774), on the cloud edition against
 * the fake hub: TWO instances of the host boot on real ports as two tools of
 * one hub (`things`, this one, and `twin`, the sibling the host's `twin`
 * source declares), and an admin of the same organization on both connects
 * the twin from here in one call. The hub turns the person's grant into a
 * two-minute token for the twin, the twin mints the person a key, the
 * receiving URL is registered there with the declared events, the secret
 * comes back sealed into the row, the key is revoked, and nothing of it is
 * ever answered. Then the twin's test ping and a real event land at the
 * door through the real transport; a re-run replaces the endpoint, the URL
 * and the secret and leaves ONE endpoint on the twin; the refusals each
 * say what the person does next (a grant without the scope, a person the
 * twin never saw, a local workspace, a member, a hub that does not answer),
 * and the disconnect deletes the endpoint on the twin before the row here.
 */

const ORG = '77777777-aaaa-4bbb-8ccc-00000000e001';
const HUB_SECRET = 'integration-test-hub-secret-sibling';
const ADMIN: HubUserFixture = {
  sub: 'hub-user-sibling-admin',
  email: 'sibling-admin@example.com',
  name: 'Sib Admin',
  workspaceId: ORG,
  role: 'admin',
  workspaceName: 'Sibling Org'
};
/** Signed in before this tool asked for `sso:connect`: the grant carries the legacy scopes. */
const LEGACY: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-sibling-legacy',
  email: 'sibling-legacy@example.com',
  name: 'Leg Acy',
  overrides: { scope: LEGACY_GRANT_SCOPE }
};
/** An admin here who never opened the twin. */
const STRANGER: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-sibling-stranger',
  email: 'sibling-stranger@example.com',
  name: 'Stran Ger'
};
const MEMBER: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-sibling-member',
  email: 'sibling-member@example.com',
  name: 'Mem Ber',
  role: 'member'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let here: TestApp;
let twin: TestApp;
let hereServer: ServerType;
let twinServer: ServerType;
let hereBase = '';
let twinBase = '';
let hereWorkspace = '';
let twinWorkspace = '';
const cookies: Record<string, string> = {};
const twinCookies: Record<string, string> = {};
const seen = host.connections?.seen ?? [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function cloudEnv(publicBaseUrl: string) {
  return {
    EDITION: 'cloud',
    PUBLIC_BASE_URL: publicBaseUrl,
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: HUB_SECRET
  };
}

const call = (
  app: TestApp,
  base: string,
  method: string,
  path: string,
  who: { cookie: string; workspace: string },
  body?: unknown
) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      origin: base,
      'x-workspace-id': who.workspace,
      'x-forwarded-for': sso.nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
const hereCall = (method: string, path: string, who = 'admin', body?: unknown) =>
  call(here, hereBase, method, path, { cookie: cookies[who]!, workspace: hereWorkspace }, body);
const twinCall = (method: string, path: string, body?: unknown) =>
  call(twin, twinBase, method, path, { cookie: twinCookies.admin!, workspace: twinWorkspace }, body);

async function expectError(res: Response, status: number, code: string): Promise<unknown> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
  return body;
}

const twinEndpoints = async () =>
  (await readJson(await twinCall('GET', '/webhooks'))).webhooks as Array<{
    id: string;
    url: string;
    events: string[];
    description: string;
  }>;

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  [container, hub] = await Promise.all([
    startPostgres(),
    FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET })
  ]);
  const [herePort, twinPort] = await Promise.all([freePort(), freePort()]);
  hereBase = `http://127.0.0.1:${herePort}`;
  twinBase = `http://127.0.0.1:${twinPort}`;
  // The fleet, as the hub lists it: both instances are registry tools, so a
  // webhook from one may reach the other's loopback address (PRDCT-3772).
  hub.setTools([
    { slug: 'things', name: 'Things', launchUrl: hereBase },
    { slug: 'twin', name: 'Twin', launchUrl: twinBase }
  ]);
  [here, twin] = await Promise.all([
    createTestApp(await createDatabase(container, 'sibling_here'), cloudEnv(hereBase), {
      webhookDials: { listenerTtlMs: 0, timeoutMs: 2000 },
      fleetOriginsDials: { refreshMs: 60_000, retryMs: 60_000, timeoutMs: 2000 }
    }),
    createTestApp(await createDatabase(container, 'sibling_twin'), cloudEnv(twinBase), {
      webhookDials: { listenerTtlMs: 0, timeoutMs: 2000 },
      fleetOriginsDials: { refreshMs: 60_000, retryMs: 60_000, timeoutMs: 2000 }
    })
  ]);
  hereServer = serve({ fetch: here.app.fetch, port: herePort, hostname: '127.0.0.1' });
  twinServer = serve({ fetch: twin.app.fetch, port: twinPort, hostname: '127.0.0.1' });

  // The admin opened both tools; the legacy and the member opened both too;
  // the stranger opened this one alone.
  for (const [name, fixture] of [
    ['admin', ADMIN],
    ['legacy', LEGACY],
    ['stranger', STRANGER],
    ['member', MEMBER]
  ] as const) {
    cookies[name] = await sso.ssoLogin(here, hub, fixture);
  }
  for (const [name, fixture] of [
    ['admin', ADMIN],
    ['legacy', LEGACY],
    ['member', MEMBER]
  ] as const) {
    twinCookies[name] = await sso.ssoLogin(twin, hub, fixture);
  }
  hereWorkspace = (
    await readJson(await here.app.request('/api/v1/me', { headers: { cookie: cookies.admin! } }))
  ).activeWorkspaceId;
  twinWorkspace = (
    await readJson(await twin.app.request('/api/v1/me', { headers: { cookie: twinCookies.admin! } }))
  ).activeWorkspaceId;
}, 240_000);

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => (hereServer ? hereServer.close(() => r()) : r())),
    new Promise<void>((r) => (twinServer ? twinServer.close(() => r()) : r()))
  ]);
  await Promise.all([here?.stop(), twin?.stop()]);
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe.skipIf(!host.connections)('the sign-in asks the hub for the connect scope', () => {
  it('a tool that declares a sibling source requests sso:connect at sign-in, so the grant carries it', async () => {
    const { scope } = await sso.ssoInitiate(here);
    expect(scope?.split(' ')).toContain('sso:connect');
  });

  it('the fleet list read at boot names the twin by slug with its resource URL', () => {
    expect(here.fleetOrigins!.tool('twin')).toEqual({
      slug: 'twin',
      clientId: 'tool-twin',
      name: 'Twin',
      origin: twinBase,
      resourceUrl: `${twinBase}/mcp`
    });
    expect(here.fleetOrigins!.tool('nobody')).toBeNull();
  });
});

describe.skipIf(!host.connections)('connecting the twin as the person', () => {
  let endpointId = '';
  let madeAt = '';

  it('1. one call registers the endpoint on the twin and stores the secret here; nothing is answered', async () => {
    const before = hub.connectTokenRequests.length;
    const res = await hereCall('POST', '/connections/twin/sibling');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({
      source: 'twin',
      connected: true,
      secretState: { set: true, readable: true },
      sibling: { endpointId: expect.any(String) }
    });
    expect(body.receiving.madeAt).toEqual(expect.any(String));
    expect(body.receiving.madeBy.email).toBe(ADMIN.email);
    expect(body.secretState.setBy.email).toBe(ADMIN.email);
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
    // Nothing secret in the answer: no URL, no token, no secret value (the declared hint `whsec_…` is not one).
    const text = JSON.stringify(body);
    expect(text).not.toContain('/hooks/');
    expect(text).not.toMatch(/whsec_[A-Za-z0-9+/=_-]{8,}/);

    // The hub was asked once, for the twin's resource, as the admin.
    expect(hub.connectTokenRequests.slice(before)).toEqual([{ sub: ADMIN.sub, resource: `${twinBase}/mcp` }]);

    // The twin holds exactly one endpoint of ours: our receiving URL, the declared events, described as ours.
    const endpoints = await twinEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.id).toBe(endpointId);
    expect(endpoints[0]!.url.startsWith(`${hereBase}/hooks/twin/`)).toBe(true);
    expect(endpoints[0]!.events).toEqual(['thing.created']);
    expect(endpoints[0]!.description).toContain(host.identity.displayName);
  });

  it('2. the key the twin minted for the person is revoked before the call returned', async () => {
    const rows = await twin.db.db.select().from(apiKeys);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((k) => k.revokedAt !== null)).toBe(true);
    const live = await twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt));
    expect(live).toHaveLength(0);
  });

  it('3. the audit row names the act and the source, never the URL, the secret or the key', async () => {
    // The audit row is written by the queue, a moment after the answer.
    const rows = await until(
      () => here.db.db.select().from(auditLog).where(eq(auditLog.action, 'connection.sibling_connect')),
      (v) => v.length > 0
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceId).toBe('twin');
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain('/hooks/');
    expect(text).not.toContain('whsec_');
    expect(text).not.toMatch(/_[A-Za-z0-9]{20,}_/);
  });

  it("4. the twin's test ping lands at the door through the real transport and is the card's last delivery", async () => {
    const res = await twinCall('POST', `/webhooks/${endpointId}/test`);
    expect(res.status).toBe(200);
    const { delivery } = await readJson(res);
    expect(delivery).toMatchObject({ status: 'delivered', eventType: 'webhook.ping', lastStatusCode: 200 });
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.lastDelivery).toMatchObject({ type: 'webhook.ping', outcome: 'ignored' });
    const log = await readJson(await hereCall('GET', '/connections/twin/deliveries'));
    expect(log.deliveries).toHaveLength(1);
    expect(log.deliveries[0]).toMatchObject({ type: 'webhook.ping', outcome: 'ignored' });
  });

  it("5. a real event of the twin reaches this tool's handler, verified with the stored secret", async () => {
    const before = seen.filter((d) => d.source === 'twin').length;
    const eventId = await twin.webhooks.emit(twin.db.db, {
      workspaceId: twinWorkspace,
      type: 'thing.created',
      subjects: { thing: 'thing-1', project: ['project-1'] },
      data: { thingId: 'thing-1', name: 'A thing of the twin' }
    });
    expect(eventId).toEqual(expect.any(String));
    const mine = await until(
      async () => seen.filter((d) => d.source === 'twin'),
      (v) => v.length > before
    );
    expect(mine.length).toBe(before + 1);
    expect(mine.at(-1)).toMatchObject({ workspaceId: hereWorkspace, source: 'twin', type: 'thing.created' });
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.lastDelivery).toMatchObject({ type: 'thing.created', outcome: 'processed' });
  });

  it('6. a re-run replaces the endpoint, the URL and the secret, and leaves ONE endpoint on the twin', async () => {
    const [rowBefore] = await here.db.db
      .select()
      .from(connections)
      .where(eq(connections.workspaceId, hereWorkspace));
    const res = await hereCall('POST', '/connections/twin/sibling');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await readJson(res);
    expect(body.sibling.endpointId).not.toBe(endpointId);
    expect(body.receiving.madeAt).not.toBe(madeAt);
    const endpoints = await twinEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.id).toBe(body.sibling.endpointId);
    const [rowAfter] = await here.db.db
      .select()
      .from(connections)
      .where(eq(connections.workspaceId, hereWorkspace));
    expect(rowAfter!.tokenHash).not.toBe(rowBefore!.tokenHash);
    expect(rowAfter!.secretSealed).not.toBe(rowBefore!.secretSealed);
    // The new pair works: the ping on the new endpoint lands.
    const ping = await twinCall('POST', `/webhooks/${body.sibling.endpointId}/test`);
    expect((await readJson(ping)).delivery.status).toBe('delivered');
    const log = await readJson(await hereCall('GET', '/connections/twin/deliveries'));
    expect(log.deliveries[0]).toMatchObject({ type: 'webhook.ping' });
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
  });

  it('7. a hub that does not answer changes nothing: the row, the endpoint and the twin stay as they were', async () => {
    hub.connectTokenMode = 'http500';
    try {
      await expectError(await hereCall('POST', '/connections/twin/sibling'), 502, 'source_unavailable');
    } finally {
      hub.connectTokenMode = 'ok';
    }
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.sibling.endpointId).toBe(endpointId);
    expect(card.receiving.madeAt).toBe(madeAt);
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
  });

  it('8. a grant from before the tool asked for the scope is told to sign in again; nothing changed', async () => {
    const body = (await expectError(
      await hereCall('POST', '/connections/twin/sibling', 'legacy'),
      400,
      'sibling_scope_missing'
    )) as { error: { message: string } };
    expect(body.error.message).toMatch(/sign in again/i);
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
  });

  it('9. a person the twin never saw is told to open it once; the key minted meanwhile is revoked', async () => {
    const before = (await twin.db.db.select().from(apiKeys)).length;
    const body = (await expectError(
      await hereCall('POST', '/connections/twin/sibling', 'stranger'),
      400,
      'sibling_grant_missing'
    )) as { error: { message: string } };
    expect(body.error.message).toContain('Twin');
    // The twin refused the connect before minting: no key was made for the stranger.
    expect((await twin.db.db.select().from(apiKeys)).length).toBe(before);
    expect((await twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt))).length).toBe(0);
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
  });

  it('10. a member is refused flat, and a source that declares no sibling is 409', async () => {
    await expectError(await hereCall('POST', '/connections/twin/sibling', 'member'), 403, 'forbidden');
    await expectError(await hereCall('DELETE', '/connections/twin/sibling', 'member'), 403, 'forbidden');
    await expectError(await hereCall('POST', '/connections/partner/sibling'), 409, 'not_sibling');
    await expectError(await hereCall('POST', '/connections/nobody/sibling'), 404, 'not_found');
  });

  it('11. a local workspace (no hub organization) cannot have a twin', async () => {
    const local = await sso.seedLocalWorkspace(here, 'Local Things', ADMIN.email);
    const res = await call(here, hereBase, 'POST', '/connections/twin/sibling', {
      cookie: cookies.admin!,
      workspace: local
    });
    await expectError(res, 400, 'sibling_workspace_missing');
  });

  it('12. the disconnect deletes the endpoint on the twin first, then the row and the log here; a second one is a no-op', async () => {
    const res = await hereCall('DELETE', '/connections/twin/sibling');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({
      source: 'twin',
      connected: false,
      receiving: null,
      secretState: { set: false },
      sibling: { endpointId: null }
    });
    expect(await twinEndpoints()).toEqual([]);
    const log = await readJson(await hereCall('GET', '/connections/twin/deliveries'));
    expect(log.deliveries).toEqual([]);
    const again = await hereCall('DELETE', '/connections/twin/sibling');
    expect(again.status).toBe(200);
    const rows = await until(
      () => here.db.db.select().from(auditLog).where(eq(auditLog.action, 'connection.sibling_disconnect')),
      (v) => v.length >= 2
    );
    expect(rows.length).toBe(2);
    // Every key the twin ever minted for the connects is revoked.
    expect((await twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt))).length).toBe(0);
  });
});
