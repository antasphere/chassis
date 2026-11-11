import net from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { isNull } from 'drizzle-orm';
import { apiKeys } from '@antasphere/chassis-db';
import { createPlatform, type ToolDefinition } from '@antasphere/chassis-server';
import {
  FakeHub,
  LEGACY_GRANT_SCOPE,
  makeCreateTestApp,
  makeOauthBearer,
  type HubUserFixture,
  type TestApp as ChassisTestApp
} from '@antasphere/chassis-server/testing';
import { minimalTool, type MinimalBootResult, type ThingsDomain } from '../host/minimal-tool.js';
import { createDatabase, createTestApp, host, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The sibling call end to end (PRDCT-4393), on the cloud edition against the
 * fake hub: two tools of one hub on real ports, `things` (here) and `twin`.
 * Here is booted as a tool that DECLARES the twin in its `siblings` slot and
 * receives nothing from it (no sibling connection source: the shape of a
 * tool that creates a resource on another for the person), and
 * its route `POST /things/sibling` acts on the twin through `core.siblings`.
 * The twin answers `GET /things/whoami` with the principal it resolved, so
 * the suite sees WHO acted there: the person of the request here, from a
 * session, an API key and an OAuth bearer alike, in the twin workspace of the
 * same hub organization, with a key the twin minted for them and that is
 * revoked before the answer, whatever the work did. Every refusal is an
 * answer, an undeclared sibling is refused before the hub hears of it, a
 * call outside a request has nobody to act as, and a local instance answers
 * that it is not on a hub.
 */

const ORG = '77777777-aaaa-4bbb-8ccc-00000000f001';
const HUB_SECRET = 'integration-test-hub-secret-sibling-call';
const ADMIN: HubUserFixture = {
  sub: 'hub-user-call-admin',
  email: 'call-admin@example.com',
  name: 'Call Admin',
  workspaceId: ORG,
  role: 'admin',
  workspaceName: 'Call Org'
};
/** A plain member: the call needs no role here, the twin applies the person's own rights there. */
const MEMBER: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-call-member',
  email: 'call-member@example.com',
  name: 'Call Member',
  role: 'member'
};
const LEGACY: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-call-legacy',
  email: 'call-legacy@example.com',
  name: 'Call Legacy',
  overrides: { scope: LEGACY_GRANT_SCOPE }
};
/** Opened here, never the twin. */
const STRANGER: HubUserFixture = {
  ...ADMIN,
  sub: 'hub-user-call-stranger',
  email: 'call-stranger@example.com',
  name: 'Call Stranger'
};

/** The caller: the minimal tool with the twin declared as a sibling it calls, and no sibling source. */
const callerTool: ToolDefinition<Record<never, never>, ThingsDomain> = {
  ...minimalTool,
  connections: {
    sources: (minimalTool.connections?.sources ?? []).filter((source) => source.sibling === undefined)
  }
};
const createCaller = makeCreateTestApp(createPlatform(callerTool).boot);
type CallerApp = ChassisTestApp<MinimalBootResult>;

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let here: CallerApp;
let twin: TestApp;
let twinServer: ServerType;
let hereBase = '';
let twinBase = '';
let hereWorkspace = '';
let twinWorkspace = '';
const cookies: Record<string, string> = {};

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

const cloudEnv = (publicBaseUrl: string) => ({
  EDITION: 'cloud',
  PUBLIC_BASE_URL: publicBaseUrl,
  HUB_ISSUER_URL: hub.issuer,
  HUB_CLIENT_ID: host.hubClientId,
  HUB_CLIENT_SECRET: HUB_SECRET
});
const dials = {
  webhookDials: { listenerTtlMs: 0, timeoutMs: 2000 },
  fleetOriginsDials: { refreshMs: 60_000, retryMs: 60_000, timeoutMs: 2000 }
};

/** One act on the twin from here, with a credential: a session cookie or a bearer. */
async function act(
  body: { act: string; sibling?: string },
  who: { cookie?: string; bearer?: string; workspace?: string } = { cookie: cookies.admin! }
): Promise<Response> {
  return here.app.request('/api/v1/things/sibling', {
    method: 'POST',
    headers: {
      ...(who.cookie ? { cookie: who.cookie, origin: hereBase } : {}),
      ...(who.bearer ? { authorization: `Bearer ${who.bearer}` } : {}),
      'x-workspace-id': who.workspace ?? hereWorkspace,
      'x-forwarded-for': sso.nextIp(),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}
async function answerOf(res: Response): Promise<{ outcome: unknown; via: string }> {
  expect(res.status).toBe(200);
  return readJson(res);
}
async function outcomeOf(res: Response): Promise<unknown> {
  return (await answerOf(res)).outcome;
}

const twinKeys = () => twin.db.db.select().from(apiKeys);
const liveTwinKeys = () => twin.db.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt));

/** A successful act: the thing made on the twin, by the person, in the twin workspace; no live key left; nothing of the key answered. */
async function expectMadeBy(res: Response, fixture: HubUserFixture, via: string): Promise<void> {
  const answer = await answerOf(res);
  // The credential the request came with here.
  expect(answer.via).toBe(via);
  const outcome = answer.outcome;
  expect(outcome).toMatchObject({
    kind: 'ok',
    value: {
      made: { status: 201, body: { thing: { id: 'thing' } } },
      who: { email: fixture.email, workspaceId: twinWorkspace, via: 'api_key' },
      workspaceId: twinWorkspace
    }
  });
  expect(hub.connectTokenRequests.at(-1)).toEqual({ sub: fixture.sub, resource: `${twinBase}/mcp` });
  expect(await liveTwinKeys()).toEqual([]);
  const text = JSON.stringify(outcome);
  for (const k of await twinKeys()) expect(text).not.toContain(k.keyId);
}

beforeAll(async () => {
  [container, hub] = await Promise.all([
    startPostgres(),
    FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET })
  ]);
  const [herePort, twinPort] = await Promise.all([freePort(), freePort()]);
  hereBase = `http://127.0.0.1:${herePort}`;
  twinBase = `http://127.0.0.1:${twinPort}`;
  hub.setTools([
    { slug: 'things', name: 'Things', launchUrl: hereBase },
    { slug: 'twin', name: 'Twin', launchUrl: twinBase }
  ]);
  [here, twin] = await Promise.all([
    createCaller(await createDatabase(container, 'call_here'), cloudEnv(hereBase), dials),
    createTestApp(await createDatabase(container, 'call_twin'), cloudEnv(twinBase), dials)
  ]);
  twinServer = serve({ fetch: twin.app.fetch, port: twinPort, hostname: '127.0.0.1' });

  for (const [name, fixture] of [
    ['admin', ADMIN],
    ['member', MEMBER],
    ['legacy', LEGACY],
    ['stranger', STRANGER]
  ] as const) {
    cookies[name] = await sso.ssoLogin(here, hub, fixture);
  }
  // The person opened the twin once: the twin holds their grant (the stranger never did).
  for (const fixture of [ADMIN, MEMBER, LEGACY]) await sso.ssoLogin(twin, hub, fixture);
  hereWorkspace = (
    await readJson(await here.app.request('/api/v1/me', { headers: { cookie: cookies.admin! } }))
  ).activeWorkspaceId;
  const twinAdmin = await sso.ssoLogin(twin, hub, ADMIN);
  twinWorkspace = (await readJson(await twin.app.request('/api/v1/me', { headers: { cookie: twinAdmin } })))
    .activeWorkspaceId;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((r) => (twinServer ? twinServer.close(() => r()) : r()));
  await Promise.all([here?.stop(), twin?.stop()]);
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe.skipIf(!host.siblings)('a tool that calls a sibling, as the person', () => {
  it('declares the twin and no sibling source, and its sign-in still asks the hub for sso:connect', async () => {
    expect(here.siblings.declared).toEqual(['twin']);
    expect([...(here.connections.catalog.sources.values() ?? [])].some((s) => s.sibling)).toBe(false);
    const { scope } = await sso.ssoInitiate(here);
    expect(scope?.split(' ')).toContain('sso:connect');
  });

  it('1. from a session: the thing is made on the twin by the person, in the twin workspace; the key is revoked', async () => {
    await expectMadeBy(await act({ act: 'make' }), ADMIN, 'session');
  });

  it('2. from an API key of the person here: the same, as the same person', async () => {
    const minted = await here.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: cookies.admin!, origin: hereBase, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sibling call', scopes: [host.scopes.read, host.scopes.write] })
    });
    expect(minted.status).toBe(201);
    const { key } = (await readJson(minted)) as { key: string };
    expect(key).toEqual(expect.any(String));
    await expectMadeBy(await act({ act: 'make' }, { bearer: key }), ADMIN, 'api_key');
  });

  it('3. from an OAuth bearer of the person here: the same, as the same person', async () => {
    const bearer = await makeOauthBearer(`openid ${host.scopes.write}`, `${hereBase}/mcp`)(
      here as never,
      cookies.admin!
    );
    await expectMadeBy(await act({ act: 'make' }, { bearer }), ADMIN, 'oauth');
  });

  it('4. a member acts as themself, with their own rights on the twin', async () => {
    await expectMadeBy(await act({ act: 'make' }, { cookie: cookies.member! }), MEMBER, 'session');
  });

  it('5. an undeclared sibling is refused before the hub hears of it; nothing is minted on the twin', async () => {
    const asked = hub.connectTokenRequests.length;
    const keys = (await twinKeys()).length;
    expect(await outcomeOf(await act({ act: 'make', sibling: 'other' }))).toEqual({
      kind: 'sibling_not_declared',
      message: 'This tool declares no sibling named "other"'
    });
    expect(hub.connectTokenRequests.length).toBe(asked);
    expect((await twinKeys()).length).toBe(keys);
  });

  it('6. a refusal of the twin is answered with its status and code; the key is revoked', async () => {
    const keys = (await twinKeys()).length;
    const outcome = await outcomeOf(await act({ act: 'refused' }));
    expect(outcome).toMatchObject({ kind: 'sibling_refused', status: 403, code: 'endpoint_not_allowed' });
    expect((await twinKeys()).length).toBe(keys + 1);
    expect(await liveTwinKeys()).toEqual([]);
  });

  it('7. a work that throws is the tool’s own error (500), and the key minted for it is revoked all the same', async () => {
    const keys = (await twinKeys()).length;
    const res = await act({ act: 'throw' });
    expect(res.status).toBe(500);
    expect((await twinKeys()).length).toBe(keys + 1);
    expect(await liveTwinKeys()).toEqual([]);
  });

  it('8. a person the twin never saw is told to open it once; no key was minted', async () => {
    const keys = (await twinKeys()).length;
    expect(await outcomeOf(await act({ act: 'make' }, { cookie: cookies.stranger! }))).toEqual({
      kind: 'sibling_grant_missing'
    });
    expect((await twinKeys()).length).toBe(keys);
  });

  it('9. a grant from before the tool asked for sso:connect is told to sign in again', async () => {
    expect(await outcomeOf(await act({ act: 'make' }, { cookie: cookies.legacy! }))).toEqual({
      kind: 'sibling_scope_missing'
    });
  });

  it('10. a hub that does not answer: unavailable, nothing minted', async () => {
    const keys = (await twinKeys()).length;
    hub.connectTokenMode = 'http500';
    try {
      expect(await outcomeOf(await act({ act: 'make' }))).toEqual({
        kind: 'unavailable',
        message: 'the hub answered 500'
      });
    } finally {
      hub.connectTokenMode = 'ok';
    }
    expect((await twinKeys()).length).toBe(keys);
  });

  it('11. a local workspace (no hub organization) has no twin, and the hub is not asked', async () => {
    const local = await sso.seedLocalWorkspace(here as never, 'Local Things', ADMIN.email);
    const asked = hub.connectTokenRequests.length;
    expect(await outcomeOf(await act({ act: 'make' }, { cookie: cookies.admin!, workspace: local }))).toEqual(
      {
        kind: 'sibling_workspace_missing'
      }
    );
    expect(hub.connectTokenRequests.length).toBe(asked);
  });

  it('12. outside a person’s request (a job, a timer) there is nobody to act as', async () => {
    const asked = hub.connectTokenRequests.length;
    expect(await here.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'no_person',
      message: 'A sibling is called as the person of a request, and this code runs outside one'
    });
    expect(hub.connectTokenRequests.length).toBe(asked);
  });
});

describe.skipIf(!host.siblings)('a local instance, with no hub', () => {
  it('answers not_on_hub, never throws', async () => {
    const local = await createCaller(await createDatabase(container, 'call_local'));
    try {
      expect(local.siblings.declared).toEqual(['twin']);
      expect(await local.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
        kind: 'not_on_hub',
        message: 'This instance is not on an Antasphere hub, so it has no sibling tool to act on'
      });
    } finally {
      await local.stop();
    }
  });
});
