import net from 'node:net';
import pg from 'pg';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, isNull } from 'drizzle-orm';
import { apiKeys, auditLog, connections } from '@antasphere/chassis-db';
import { FakeHub, LEGACY_GRANT_SCOPE, type HubUserFixture } from '@antasphere/chassis-server/testing';
import {
  CONNECTION_SIBLING_LOCK_NAMESPACE,
  ConnectionService,
  DEFAULT_SIBLING_OVERALL_MS,
  SIBLING_LOCK_HEADROOM_MS,
  SiblingConnector
} from '@antasphere/chassis-server/connections';
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
/** An admin whose grant on this tool the hub tears down before the connect. */
const DEAD: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-sibling-dead',
  email: 'sibling-dead@example.com',
  name: 'Dee Ad'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let here: TestApp;
let twin: TestApp;
let hereServer: ServerType;
let twinServer: ServerType;
let hereBase = '';
let twinBase = '';
let hereDb = '';
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
  hereDb = await createDatabase(container, 'sibling_here');
  [here, twin] = await Promise.all([
    createTestApp(hereDb, cloudEnv(hereBase), {
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
    ['member', MEMBER],
    ['dead', DEAD]
  ] as const) {
    cookies[name] = await sso.ssoLogin(here, hub, fixture);
  }
  for (const [name, fixture] of [
    ['admin', ADMIN],
    ['legacy', LEGACY],
    ['member', MEMBER],
    ['dead', DEAD]
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
    // And nothing was written here: the hub had answered, the sibling had not accepted (round 5, F4).
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.sibling.endpointId).toBe(endpointId);
    expect(card.receiving.madeAt).toBe(madeAt);
  });

  it('9b. an admin whose grant the hub tore down is told to sign in again, 401; nothing changed', async () => {
    hub.revokeGrants(DEAD.sub);
    const body = (await expectError(
      await hereCall('POST', '/connections/twin/sibling', 'dead'),
      401,
      'hub_reauth_required'
    )) as { error: { message: string } };
    expect(body.error.message).toMatch(/sign in again/i);
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.sibling.endpointId).toBe(endpointId);
  });

  it('9d. an endpoint of ours left on the twin by hand (an old URL of this source) is removed by the next connect', async () => {
    const stale = await twinCall('POST', '/webhooks', {
      url: `${hereBase}/hooks/twin/stale-token-from-an-earlier-walk-0000000000`,
      events: ['thing.created'],
      description: 'made by hand'
    });
    expect(stale.status).toBe(201);
    const staleId = (await readJson(stale)).id;
    // Another tool's endpoint in the same workspace is not ours: it stays.
    const other = await twinCall('POST', '/webhooks', {
      url: `${hereBase}/hooks/partner/another-source-of-this-tool-00000000000`,
      events: ['thing.created'],
      description: 'another source'
    });
    expect(other.status).toBe(201);
    const otherId = (await readJson(other)).id;
    expect((await twinEndpoints()).map((e) => e.id).sort()).toEqual([endpointId, staleId, otherId].sort());
    const res = await hereCall('POST', '/connections/twin/sibling');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await readJson(res);
    const after = await twinEndpoints();
    expect(after.map((e) => e.id).sort()).toEqual([body.sibling.endpointId, otherId].sort());
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
    // Clean the other source's endpoint by hand, so the disconnect scenario reads an empty list.
    expect((await twinCall('DELETE', `/webhooks/${otherId}`)).status).toBe(200);
  });

  it('9c. while a connect of the source holds its lock, another is told the source is busy and changes nothing; the lock lives in its own session', async () => {
    // The lock the connect takes, held from a dedicated session the way the connect holds it.
    const holder = new pg.Client({ connectionString: hereDb });
    await holder.connect();
    try {
      const taken = await holder.query<{ taken: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS taken',
        [CONNECTION_SIBLING_LOCK_NAMESPACE, `${hereWorkspace}:twin`]
      );
      expect(taken.rows[0]!.taken).toBe(true);
      const body = (await expectError(
        await hereCall('POST', '/connections/twin/sibling'),
        409,
        'sibling_busy'
      )) as { error: { message: string } };
      expect(body.error.message).toMatch(/another connect/i);
      await expectError(await hereCall('DELETE', '/connections/twin/sibling'), 409, 'sibling_busy');
      expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
      const card = await readJson(await hereCall('GET', '/connections/twin'));
      expect(card.sibling.endpointId).toBe(endpointId);
      // The busy answer held no connection of the pool: the ordinary reads still answer.
      expect((await hereCall('GET', '/connections')).status).toBe(200);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        CONNECTION_SIBLING_LOCK_NAMESPACE,
        `${hereWorkspace}:twin`
      ]);
      await holder.end();
    }
    // Released: the connect goes through again.
    const res = await hereCall('POST', '/connections/twin/sibling');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await readJson(res);
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
  });

  it('9c2. two connects of the same source at once: one answers busy, or both run in turn; ONE endpoint on the twin, the row points at it', async () => {
    const [a, b] = await Promise.all([
      hereCall('POST', '/connections/twin/sibling'),
      hereCall('POST', '/connections/twin/sibling')
    ]);
    const statuses = [a.status, b.status].sort();
    expect([
      [200, 200],
      [200, 409]
    ]).toContainEqual(statuses);
    if (statuses[1] === 409) {
      const refused = a.status === 409 ? a : b;
      expect((await readJson(refused)).error.code).toBe('sibling_busy');
    }
    const endpoints = await twinEndpoints();
    expect(endpoints).toHaveLength(1);
    const card = await readJson(await hereCall('GET', '/connections/twin'));
    expect(card.sibling.endpointId).toBe(endpoints[0]!.id);
    expect((await twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt))).length).toBe(0);
    endpointId = card.sibling.endpointId;
    madeAt = card.receiving.madeAt;
  });

  it('9e. the endpoint the row tracks is removed by id even when it no longer sits under our door (the public base changed)', async () => {
    // An endpoint of ours registered under an earlier base: a URL on our origin, another path.
    const legacy = await twinCall('POST', '/webhooks', {
      url: `${hereBase}/legacy-base/hooks/twin/old-token-00000000000000000000`,
      events: ['thing.created'],
      description: 'from before the base changed'
    });
    expect(legacy.status).toBe(201);
    const legacyId = (await readJson(legacy)).id;
    // The row remembers it as the sibling's endpoint, as it would after a base change;
    // the current endpoint stays on the twin as a stale one under our door.
    await here.db.db
      .update(connections)
      .set({ siblingEndpointId: legacyId })
      .where(eq(connections.workspaceId, hereWorkspace));
    const res = await hereCall('POST', '/connections/twin/sibling');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await readJson(res);
    expect((await twinEndpoints()).map((e) => e.id)).toEqual([body.sibling.endpointId]);
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
  });

  it('9f. a sibling that refuses the new endpoint changes nothing: the previous one stays registered, the card untouched', async () => {
    // The twin stops seeing this tool as a fleet sibling: our http loopback URL is then refused at registration.
    hub.setTools([{ slug: 'twin', name: 'Twin', launchUrl: twinBase }]);
    await twin.fleetOrigins!.refresh();
    try {
      const body = (await expectError(
        await hereCall('POST', '/connections/twin/sibling'),
        400,
        'sibling_refused'
      )) as { error: { message: string } };
      expect(body.error.message).toContain('Twin would not register the endpoint');
      expect((await twinEndpoints()).map((e) => e.id)).toEqual([endpointId]);
      const card = await readJson(await hereCall('GET', '/connections/twin'));
      expect(card.sibling.endpointId).toBe(endpointId);
      expect(card.receiving.madeAt).toBe(madeAt);
    } finally {
      hub.setTools([
        { slug: 'things', name: 'Things', launchUrl: hereBase },
        { slug: 'twin', name: 'Twin', launchUrl: twinBase }
      ]);
      await twin.fleetOrigins!.refresh();
    }
    // Back in the fleet, the next ping on the kept endpoint still lands.
    const ping = await twinCall('POST', `/webhooks/${endpointId}/test`);
    expect((await readJson(ping)).delivery.status).toBe('delivered');
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

  it('11b. the disconnect removes the tracked endpoint by id even when it no longer sits under our door', async () => {
    const legacy = await twinCall('POST', '/webhooks', {
      url: `${hereBase}/legacy-base/hooks/twin/old-token-11111111111111111111`,
      events: ['thing.created'],
      description: 'from before the base changed'
    });
    expect(legacy.status).toBe(201);
    const legacyId = (await readJson(legacy)).id;
    await here.db.db
      .update(connections)
      .set({ siblingEndpointId: legacyId })
      .where(eq(connections.workspaceId, hereWorkspace));
    // The twin holds the current endpoint (under our door) and the legacy one (tracked by the row).
    expect((await twinEndpoints()).map((e) => e.id).sort()).toEqual([endpointId, legacyId].sort());
    const res = await hereCall('DELETE', '/connections/twin/sibling');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await twinEndpoints()).toEqual([]);
    // Connected again for the scenarios that follow.
    const again = await hereCall('POST', '/connections/twin/sibling');
    expect(again.status).toBe(200);
    const body = await readJson(again);
    endpointId = body.sibling.endpointId;
    madeAt = body.receiving.madeAt;
  });

  it('12. the disconnect deletes the endpoint on the twin first, then the row and the log here; a second one is a no-op', async () => {
    // A stale endpoint of ours left by hand goes with the disconnect too.
    const stale = await twinCall('POST', '/webhooks', {
      url: `${hereBase}/hooks/twin/stale-before-the-disconnect-000000000000`,
      events: ['thing.created'],
      description: 'made by hand'
    });
    expect(stale.status).toBe(201);
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
    // Three disconnects so far: 11b's, and the two of this scenario.
    const rows = await until(
      () => here.db.db.select().from(auditLog).where(eq(auditLog.action, 'connection.sibling_disconnect')),
      (v) => v.length >= 3
    );
    expect(rows.length).toBe(3);
    // Every key the twin ever minted for the connects is revoked.
    expect((await twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt))).length).toBe(0);
  });
});

describe.skipIf(!host.connections)('a hub whose fleet list was never read', () => {
  let unread: TestApp;
  let cookie = '';
  let workspace = '';

  beforeAll(async () => {
    // The hub does not answer the fleet list while this instance boots: the list stays empty, never read.
    hub.toolOriginsMode = 'http500';
    try {
      unread = await createTestApp(
        await createDatabase(container, 'sibling_unread'),
        cloudEnv('http://localhost:3999'),
        { fleetOriginsDials: { refreshMs: 60_000, retryMs: 60_000, timeoutMs: 2000 } }
      );
    } finally {
      hub.toolOriginsMode = 'ok';
    }
    cookie = await sso.ssoLogin(unread, hub, ADMIN);
    workspace = (await readJson(await unread.app.request('/api/v1/me', { headers: { cookie } })))
      .activeWorkspaceId;
  }, 120_000);

  afterAll(async () => {
    await unread?.stop();
  });

  it('answers unavailable, not "no such tool", until the list is read; then the connect proceeds', async () => {
    expect(unread.fleetOrigins!.fetchedAt).toBeNull();
    const body = (await expectError(
      await call(unread, 'http://localhost:3999', 'POST', '/connections/twin/sibling', { cookie, workspace }),
      502,
      'source_unavailable'
    )) as { error: { message: string } };
    expect(body.error.message).toMatch(/fleet list/);
    // The hub answers again: the next read names the twin, and the connect goes past the fleet
    // (here the twin refuses our URL, which is not a fleet origin on its side: a refusal, no longer unavailable).
    const read = await unread.fleetOrigins!.refresh();
    expect(read.ok).toBe(true);
    await expectError(
      await call(unread, 'http://localhost:3999', 'POST', '/connections/twin/sibling', { cookie, workspace }),
      400,
      'sibling_refused'
    );
    expect(await twinEndpoints()).toEqual([]);
  });
});

describe.skipIf(!host.connections)('the service on its own: what the two-instance walk cannot reach', () => {
  // The service built by hand on this tool's database, its connector talking to a scripted hub and
  // sibling, so the suite reaches what the real twin never does: a clearing that fails after the
  // registration, the lock's watchdog floor, the holder's session cut mid-connect.
  const ORG_TWIN_WORKSPACE = 'twin-workspace-id';
  const warned: string[] = [];
  const logger = {
    info() {},
    warn(_o: unknown, msg: string) {
      warned.push(msg);
    },
    error() {},
    debug() {}
  } as never;
  const grant = {
    accessToken: async () => ({ kind: 'ok' as const, accessToken: 'hub-access-token' }),
    invalidateAccess() {},
    refresh: async () => ({ kind: 'ok' as const, accessToken: 'hub-access-token' })
  };
  let userId = '';
  let centralAccountId = '';

  type Reply = { status: number; body?: unknown; delayMs?: number };
  function scripted(answers: Record<string, Reply[]>, seen: string[]) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      seen.push(key);
      const reply = answers[key]?.shift();
      if (!reply) throw new Error(`unscripted ${key}`);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
  }
  const happy = (): Record<string, Reply[]> => ({
    'POST /api/v1/sso/connect-token': [{ status: 200, body: { token: 'connect-jwt', expiresAt: 'x' } }],
    'POST /api/v1/sso/cli-connect': [{ status: 201, body: { key: 'tk_person_key_000000000000' } }],
    'GET /api/v1/me': [{ status: 200, body: { workspaces: [{ id: ORG_TWIN_WORKSPACE, centralAccountId }] } }],
    'POST /api/v1/webhooks': [
      { status: 201, body: { id: 'ep-scripted-1', secret: 'whsec_c2NyaXB0ZWQtc2VjcmV0LW9mLXRoZS10d2lu' } }
    ],
    'GET /api/v1/webhooks': [{ status: 200, body: { webhooks: [], nextCursor: null } }],
    'DELETE /api/v1/cli/auth/key': [{ status: 200, body: { revoked: true, id: 'k' } }]
  });
  function service(answers: Record<string, Reply[]>, seen: string[], opts: { lockWatchdogMs?: number } = {}) {
    const connector = new SiblingConnector({
      grant,
      issuerUrl: hub.issuer,
      fleet: here.fleetOrigins!,
      logger,
      fetchImpl: scripted(answers, seen),
      timeoutMs: 2000
    });
    return new ConnectionService({
      db: here.db.db,
      logger,
      authSecret: here.authSecret,
      publicBaseUrl: hereBase,
      catalog: here.connections.catalog,
      getTool: () => null,
      instanceName: host.identity.displayName,
      sibling: connector,
      connectionString: hereDb,
      ...(opts.lockWatchdogMs !== undefined ? { lockWatchdogMs: opts.lockWatchdogMs } : {})
    });
  }
  const lockHolders = async () =>
    (
      await here.db.pool.query<{ pid: number }>(
        `SELECT l.pid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.granted`,
        [CONNECTION_SIBLING_LOCK_NAMESPACE]
      )
    ).rows.map((r) => r.pid);

  beforeAll(async () => {
    const me = await readJson(await here.app.request('/api/v1/me', { headers: { cookie: cookies.admin! } }));
    userId = me.user.id;
    centralAccountId = me.workspaces.find((w: { id: string }) => w.id === hereWorkspace).centralAccountId;
    await here.db.db.delete(connections).where(eq(connections.workspaceId, hereWorkspace));
  });

  afterAll(async () => {
    await here.db.db.delete(connections).where(eq(connections.workspaceId, hereWorkspace));
  });

  it('a clearing that fails after the registration is logged, not refused: the new endpoint is stored, the key revoked', async () => {
    const seen: string[] = [];
    const answers = happy();
    answers['GET /api/v1/webhooks'] = [{ status: 500, body: { error: { code: 'internal' } } }];
    warned.length = 0;
    const svc = service(answers, seen);
    const connection = await svc.connectSibling({ workspaceId: hereWorkspace, userId }, 'twin');
    expect(connection).toMatchObject({ connected: true, sibling: { endpointId: 'ep-scripted-1' } });
    expect(seen).toEqual([
      'POST /api/v1/sso/connect-token',
      'POST /api/v1/sso/cli-connect',
      'GET /api/v1/me',
      'POST /api/v1/webhooks',
      'GET /api/v1/webhooks',
      'DELETE /api/v1/cli/auth/key'
    ]);
    expect(warned.some((m) => m.includes('could not be removed on the sibling'))).toBe(true);
    const [row] = await here.db.db
      .select()
      .from(connections)
      .where(eq(connections.workspaceId, hereWorkspace));
    expect(row!.siblingEndpointId).toBe('ep-scripted-1');
    expect(row!.secretSealed).not.toBeNull();
    expect(await lockHolders()).toEqual([]);
  });

  it("the lock's watchdog is floored at the connect's budget plus one call plus headroom, whatever a smaller setting says", () => {
    // The service's connector has the default budget and a 2 s per-call limit (see `service()`).
    const svc = service(happy(), [], { lockWatchdogMs: 300 });
    expect(svc.lockWatchdogMs).toBe(DEFAULT_SIBLING_OVERALL_MS + 2000 + SIBLING_LOCK_HEADROOM_MS);
    expect(svc.lockWatchdogMs).toBeGreaterThan(60_000);
    const larger = service(happy(), [], { lockWatchdogMs: 120_000 });
    expect(larger.lockWatchdogMs).toBe(120_000);
  });

  it("the holder's session cut by the server mid-connect is logged, never an unhandled error, and the connect completes", async () => {
    const seen: string[] = [];
    const answers = happy();
    answers['GET /api/v1/me'] = [
      { status: 200, body: { workspaces: [{ id: ORG_TWIN_WORKSPACE, centralAccountId }] }, delayMs: 1500 }
    ];
    warned.length = 0;
    const svc = service(answers, seen);
    const connect = svc.connectSibling({ workspaceId: hereWorkspace, userId }, 'twin');
    // While the connect waits on the sibling, the lock's holder is found and its session cut.
    let holders: number[] = [];
    for (let i = 0; i < 50 && holders.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      holders = await lockHolders();
    }
    expect(holders).toHaveLength(1);
    await here.db.pool.query('SELECT pg_terminate_backend($1)', [holders[0]]);
    const connection = await connect;
    expect(connection).toMatchObject({ connected: true, sibling: { endpointId: 'ep-scripted-1' } });
    expect(warned.some((m) => m.includes('lock connection errored'))).toBe(true);
    expect(await lockHolders()).toEqual([]);
  });
});
