import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { projectMembers, workspaceMembers } from '@antasphere/chassis-db';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp, host } from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';

/**
 * Project membership is the tool's own ON BOTH EDITIONS: never behind the
 * hub-managed gate. On `EDITION=cloud`, in a HUB-ORIGIN (projected) workspace,
 * where every local membership mutation answers 403 `hub_managed`
 * (hub-managed-membership.test.ts), a project is created and its members are
 * added, changed and removed locally. Nothing here can diverge from the hub:
 * members are picked among the workspace's existing members, and no
 * invitation, claim or account is minted.
 *
 * The second half is the other side of the same coin: when the hub's
 * reconcile sweeps a membership, the grants that rode on it go with it.
 */
const ORG = '26260000-aaaa-4bbb-8ccc-000000000001';
/** A second org of the member's, so their session keeps resolving while ORG is swept. */
const ORG_OTHER = '26260000-aaaa-4bbb-8ccc-000000000002';

const DIALS = {
  reconcileTtlMs: 120,
  reconcileStaleMaxMs: 60_000,
  retryMs: 250,
  orgsTimeoutMs: 400,
  tokenTimeoutMs: 2_000
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the per-user reconcile cache expire so the next request runs a fresh pass. */
const expireTtl = () => sleep(DIALS.reconcileTtlMs + 40);

const hubOwner: HubUserFixture = {
  sub: 'hub-owner-projects',
  email: 'hub-owner@projects-cloud.test',
  name: 'Hub Owner',
  workspaceId: ORG,
  role: 'owner',
  workspaceName: 'Org Projects'
};
const hubMember: HubUserFixture = {
  sub: 'hub-member-projects',
  email: 'hub-member@projects-cloud.test',
  name: 'Hub Member',
  workspaceId: ORG,
  role: 'member',
  workspaceName: 'Org Projects'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let ownerCookie = '';
let memberCookie = '';
let workspaceId = '';
let memberUserId = '';

let ipCounter = 0;
const nextIp = () => `10.78.0.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      cookie,
      'x-workspace-id': workspaceId,
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(
    await createDatabase(container, 'projects_cloud'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-projects'
    },
    { hubDials: DIALS }
  );
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Projects Cloud',
      owner: { email: 'operator@projects-cloud.test', name: 'Operator', password: 'operator-pass-projects-1' }
    })
  });
  expect(setup.status).toBe(201);

  ownerCookie = await sso.ssoLogin(app, hub, hubOwner);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  workspaceId = me.activeWorkspaceId;
  expect(me.workspace.hubOrigin).toBe(true);
  memberCookie = await sso.ssoLogin(app, hub, hubMember);
  const memberMe = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } }));
  expect(memberMe.activeWorkspaceId).toBe(workspaceId);
  memberUserId = memberMe.user.id;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('cloud edition, hub-origin workspace', () => {
  let projectId = '';

  it('a project member is added locally (201) while POST /invitations answers 403 hub_managed', async () => {
    const created = await send('POST', '/projects', ownerCookie, { name: 'Cloud project' });
    expect(created.status).toBe(201);
    projectId = (await readJson(created)).id;

    const added = await send('POST', `/projects/${projectId}/members`, ownerCookie, {
      email: hubMember.email,
      role: 'editor'
    });
    expect(added.status).toBe(201);
    expect(await readJson(added)).toMatchObject({ userId: memberUserId, role: 'editor' });

    const invite = await send('POST', '/invitations', ownerCookie, {
      email: 'newcomer@projects-cloud.test',
      role: 'member'
    });
    expect(invite.status).toBe(403);
    expect((await readJson(invite)).error.code).toBe('hub_managed');
  });

  it('a plain hub member creates a project of their own, and every other project mutation stays local too', async () => {
    const own = await send('POST', '/projects', memberCookie, { name: 'A member’s own' });
    expect(own.status).toBe(201);

    const role = await send('PATCH', `/projects/${projectId}/members/${memberUserId}`, ownerCookie, {
      role: 'viewer'
    });
    expect(role.status).toBe(200);
    expect((await send('PATCH', `/projects/${projectId}`, ownerCookie, { name: 'Renamed' })).status).toBe(
      200
    );
    expect((await send('POST', `/projects/${projectId}/archive`, ownerCookie)).status).toBe(200);
    expect((await send('POST', `/projects/${projectId}/unarchive`, ownerCookie)).status).toBe(200);
    expect((await send('DELETE', `/projects/${projectId}/members/${memberUserId}`, ownerCookie)).status).toBe(
      200
    );
  });

  it('a membership the hub sweeps loses its project grants, and a re-add at the hub starts with none', async () => {
    const back = await send('POST', `/projects/${projectId}/members`, ownerCookie, {
      userId: memberUserId,
      role: 'editor'
    });
    expect(back.status).toBe(201);
    expect((await send('GET', `/projects/${projectId}`, memberCookie)).status).toBe(200);
    const membership = async () => {
      const [row] = await app.db.db
        .select({ id: workspaceMembers.id, isActive: workspaceMembers.isActive })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, memberUserId), eq(workspaceMembers.workspaceId, workspaceId)));
      return row!;
    };
    const before = await membership();

    // Removed from the org at the hub. The reconcile DEACTIVATES the local
    // row, it never deletes it, so the foreign key's cascade does not fire:
    // the sweep itself takes the grants.
    hub.setUserOrg(hubMember.sub, ORG_OTHER, { name: 'Another Org', role: 'member' });
    hub.removeUserOrg(hubMember.sub, ORG);
    await expireTtl();
    await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } });
    expect(await membership()).toEqual({ id: before.id, isActive: false });
    expect(
      await app.db.db.select().from(projectMembers).where(eq(projectMembers.memberId, before.id))
    ).toEqual([]);

    // Added back at the hub: the SAME row comes back to life, with no grant.
    hub.setUserOrg(hubMember.sub, ORG, { name: 'Org Projects', role: 'member' });
    await expireTtl();
    await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } });
    expect(await membership()).toEqual({ id: before.id, isActive: true });
    const gone = await send('GET', `/projects/${projectId}`, memberCookie);
    expect(gone.status).toBe(404);
    const listed = await readJson(await send('GET', '/projects?archived=all', memberCookie));
    expect(listed.projects.map((p: { id: string }) => p.id)).not.toContain(projectId);
  });
});
