import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';

/**
 * Teams on the cloud edition (PRDCT-2813). In a HUB-ORIGIN workspace the
 * teams are the hub's projection: every write answers 403 `hub_managed` with
 * the pointer to the hub, and the reads serve the projected teams and seats.
 * In a cloud-LOCAL workspace (the operator's, signed in through the password door)
 * the teams are the tool's own and the writes work as on the self-hosted
 * edition.
 */
const ORG = '28280000-aaaa-4bbb-8ccc-000000000001';
const TEAM = '28280000-dddd-4eee-8fff-000000000001';
const OPERATOR = { email: 'operator@teams-cloud.test', name: 'Operator', password: 'operator-pass-teams-1' };
const HUB_TEAMS_MESSAGE =
  'Teams of this workspace are managed at the Antasphere hub — create, rename, and seat people there';

const DIALS = {
  reconcileTtlMs: 120,
  reconcileStaleMaxMs: 60_000,
  retryMs: 250,
  orgsTimeoutMs: 400,
  tokenTimeoutMs: 2_000
};

const hubOwner: HubUserFixture = {
  sub: 'hub-owner-teams',
  email: 'hub-owner@teams-cloud.test',
  name: 'Hub Owner',
  workspaceId: ORG,
  role: 'owner',
  workspaceName: 'Org Teams'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let ownerCookie = '';
let ownerUserId = '';
let workspaceId = '';

let ipCounter = 0;
const nextIp = () => `10.80.0.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, cookie: string, body?: unknown, ws?: string) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      cookie,
      ...(ws ? { 'x-workspace-id': ws } : {}),
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectHubManaged(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = await readJson(res);
  expect(body.error).toMatchObject({
    code: 'hub_managed',
    message: HUB_TEAMS_MESSAGE,
    details: { manageUrl: hub.issuer }
  });
}

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(
    await createDatabase(container, 'teams_cloud'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-teams-cloud'
    },
    { hubDials: DIALS }
  );
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Teams Cloud',
      owner: OPERATOR
    })
  });
  expect(setup.status).toBe(201);

  hub.setUserOrg(hubOwner.sub, ORG, {
    name: 'Org Teams',
    role: 'owner',
    teams: [{ id: TEAM, slug: 'design', name: 'Design' }]
  });
  ownerCookie = await sso.ssoLogin(app, hub, hubOwner);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  workspaceId = me.activeWorkspaceId;
  ownerUserId = me.user.id;
  expect(me.workspace.hubOrigin).toBe(true);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('cloud edition, hub-origin workspace: the hub’s teams, read here', () => {
  let teamId = '';

  it('GET /teams lists the projected team, with hubTeamId set and the caller seated', async () => {
    const res = await send('GET', '/teams', ownerCookie, undefined, workspaceId);
    expect(res.status).toBe(200);
    const { teams } = await readJson(res);
    expect(teams).toEqual([
      expect.objectContaining({
        slug: 'design',
        name: 'Design',
        hubTeamId: TEAM,
        isMember: true,
        membersCount: 1
      })
    ]);
    teamId = teams[0].id;
    const one = await send('GET', `/teams/${teamId}`, ownerCookie, undefined, workspaceId);
    expect(one.status).toBe(200);
    expect(await readJson(one)).toMatchObject({ id: teamId, hubTeamId: TEAM });
  });

  it('GET /teams/{id}/members lists the seated person', async () => {
    const res = await send('GET', `/teams/${teamId}/members`, ownerCookie, undefined, workspaceId);
    expect(res.status).toBe(200);
    expect((await readJson(res)).members).toEqual([
      expect.objectContaining({ userId: ownerUserId, email: hubOwner.email, role: 'owner', isActive: true })
    ]);
  });

  it('every write answers 403 hub_managed with the pointer to the hub', async () => {
    await expectHubManaged(await send('POST', '/teams', ownerCookie, { name: 'Local attempt' }, workspaceId));
    await expectHubManaged(
      await send('PATCH', `/teams/${teamId}`, ownerCookie, { name: 'Renamed' }, workspaceId)
    );
    await expectHubManaged(await send('DELETE', `/teams/${teamId}`, ownerCookie, undefined, workspaceId));
    await expectHubManaged(
      await send('POST', `/teams/${teamId}/members`, ownerCookie, { userId: ownerUserId }, workspaceId)
    );
    await expectHubManaged(
      await send('DELETE', `/teams/${teamId}/members/${ownerUserId}`, ownerCookie, undefined, workspaceId)
    );
    // Nothing moved: the projected team and its seat are as the hub left them.
    const after = await readJson(await send('GET', `/teams/${teamId}`, ownerCookie, undefined, workspaceId));
    expect(after).toMatchObject({ name: 'Design', slug: 'design', membersCount: 1 });
  });
});

describe('cloud edition, cloud-local workspace: the tool’s own teams', () => {
  it('the operator creates a team and seats themselves, as on the self-hosted edition', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      sso.json({ email: OPERATOR.email, password: OPERATOR.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    // A cloud setup mints no workspace of its own: the operator's local
    // workspace is seeded the way the other cloud suites seed it.
    const localId = await sso.seedLocalWorkspace(app, 'Operator Local', OPERATOR.email);
    const me = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie, 'x-workspace-id': localId } })
    );
    expect(me.workspace).toMatchObject({ id: localId, hubOrigin: false });

    const created = await send('POST', '/teams', cookie, { name: 'Operators' }, localId);
    expect(created.status).toBe(201);
    const team = await readJson(created);
    expect(team).toMatchObject({ slug: 'operators', hubTeamId: null, membersCount: 0 });

    const seated = await send('POST', `/teams/${team.id}/members`, cookie, { userId: me.user.id }, localId);
    expect(seated.status).toBe(201);
    expect(await readJson(seated)).toMatchObject({ userId: me.user.id, email: OPERATOR.email });
    expect(
      (await readJson(await send('GET', `/teams/${team.id}`, cookie, undefined, localId))).isMember
    ).toBe(true);
  });
});
