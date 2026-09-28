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
import { eq } from 'drizzle-orm';
import { projects, projectTeams, workspaceTeams } from '@antasphere/chassis-db';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { projectOrgTeams } from '../../src/identity/hub-projection.js';
import * as sso from './sso-helpers.js';

/**
 * The hub's teams and refusals, as the chassis reads them (the hub's
 * `GET /orgs` as the person): each org entry carries the caller's OWN teams,
 * which the reconcile projects into `workspace_teams` + the person's seats in
 * `workspace_team_members`; the body's top-level `denied` names the
 * organizations that do not open the tool to them, which `/me` hands the
 * refusal page as `hubDenied` beside the hub's `/no-access` URL.
 *
 * Pinned here: seats follow the hub on every pass (added, removed, a team
 * renamed in place); a swept org takes the person's seats with the
 * membership (and the project grants, as before); the denied hint follows
 * the last definitive pass and survives an inconclusive one; a person
 * whose only org was swept is re-admitted by a bare zero-state /me once the
 * hub lists it again (that read runs the cached pass itself); the
 * self-hosted edition carries none of it. And (PRDCT-2813) the reconcile
 * also reads the organization's WHOLE team list (`GET /teams`, as the person,
 * the org in `X-Workspace-Id`) at login and then at most once per
 * `orgTeamsTtlMs` per org: every team of the org lands, a team deleted at
 * the hub goes with its seats and its project entries, a local team is
 * never touched, and a failed read keeps the list and waits `retryMs`.
 */

const OWNER = { email: 'owner@hub-teams.test', name: 'Op Owner', password: 'op-owner-password-teams-1' };

const ORG_A = '27270000-aaaa-4bbb-8ccc-000000000001';
const ORG_B = '27270000-aaaa-4bbb-8ccc-000000000002';
const ORG_DENY = '27270000-aaaa-4bbb-8ccc-000000000003';
const ORG_C = '27270000-aaaa-4bbb-8ccc-000000000004';
const TEAM_1 = '27270000-dddd-4eee-8fff-000000000001';
const TEAM_2 = '27270000-dddd-4eee-8fff-000000000002';
const TEAM_3 = '27270000-dddd-4eee-8fff-000000000003';
const ORG_T = '27270000-aaaa-4bbb-8ccc-000000000005';
const TEAM_A = '27270000-dddd-4eee-8fff-00000000000a';
const TEAM_B = '27270000-dddd-4eee-8fff-00000000000b';
const TEAM_C = '27270000-dddd-4eee-8fff-00000000000c';
const ORG_P = '27270000-aaaa-4bbb-8ccc-000000000006';

const DIALS = {
  reconcileTtlMs: 120,
  reconcileStaleMaxMs: 60_000,
  retryMs: 250,
  orgsTimeoutMs: 400,
  tokenTimeoutMs: 2_000,
  orgTeamsTtlMs: 1_000
};
/**
 * The reconciler's clock (`hubNow`): its TTL, its retry throttle and the
 * team-list window read this, so the tests move it forward instead of
 * sleeping against 120 ms and 250 ms windows a loaded machine overshoots.
 * It only moves when a test says so: a pass right after another sits inside
 * every window whatever the machine's load.
 */
let clock = Date.now();
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};
/** Real time, for what the reconciler's clock does not govern (a request in flight, the database's own `now()`). */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the per-user reconcile cache (and the failure throttle) expire so the next request runs a fresh pass. */
const expireTtl = () => advance(Math.max(DIALS.reconcileTtlMs, DIALS.retryMs) + 40);
/** Let an org's team list go stale so the next pass reads it again. */
const expireOrgTeams = () => advance(DIALS.orgTeamsTtlMs + 60);

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(
    await createDatabase(container, 'hub_teams'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-teams',
      METRICS_TOKEN: 'hub-teams-metrics-token'
    },
    { hubDials: DIALS, hubNow: now }
  );
  const res = await app.app.request(
    '/api/v1/setup',
    sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'Teams', owner: OWNER })
  );
  expect(res.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

const me = (cookie: string) => app.app.request('/api/v1/me', { headers: { cookie } });

async function workspaceIdOf(centralAccountId: string): Promise<string> {
  const { rows } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
    centralAccountId
  ]);
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

async function teamsOf(centralAccountId: string) {
  const { rows } = await app.db.pool.query(
    `SELECT t.id, t.hub_team_id, t.slug, t.name FROM workspace_teams t
      JOIN workspaces w ON w.id = t.workspace_id
     WHERE w.central_account_id = $1
     ORDER BY t.hub_team_id`,
    [centralAccountId]
  );
  return rows as Array<{ id: string; hub_team_id: string; slug: string; name: string }>;
}

async function seatsOf(email: string, centralAccountId: string): Promise<string[]> {
  const { rows } = await app.db.pool.query(
    `SELECT t.hub_team_id FROM workspace_team_members s
      JOIN workspace_teams t ON t.id = s.team_id
      JOIN workspace_members m ON m.id = s.member_id
      JOIN workspaces w ON w.id = m.workspace_id
      JOIN "user" u ON u.id = m.user_id
     WHERE u.email = $1 AND w.central_account_id = $2
     ORDER BY t.hub_team_id`,
    [email, centralAccountId]
  );
  return rows.map((r) => r.hub_team_id as string);
}

describe('the teams projection', () => {
  const tess: HubUserFixture = {
    sub: 'hub-tess',
    email: 'tess@hub-teams.test',
    name: 'Tess Teams',
    workspaceId: ORG_A,
    role: 'member',
    workspaceName: 'Org A'
  };
  let cookie = '';

  it('a login projects the person’s two teams in an org and seats them in both', async () => {
    hub.setOrgTeams(ORG_A, [
      { id: TEAM_1, slug: 'design', name: 'Design' },
      { id: TEAM_2, slug: 'sales', name: 'Sales' }
    ]);
    hub.setUserOrg(tess.sub, ORG_A, {
      name: 'Org A',
      role: 'member',
      teams: [
        { id: TEAM_1, slug: 'design', name: 'Design' },
        { id: TEAM_2, slug: 'sales', name: 'Sales' }
      ]
    });
    // A second org of hers, so her session keeps resolving while ORG_A is swept below.
    hub.setUserOrg(tess.sub, ORG_B, { name: 'Org B', role: 'member' });
    cookie = await sso.ssoLogin(app, hub, tess);

    const teams = await teamsOf(ORG_A);
    expect(teams.map((t) => [t.hub_team_id, t.slug, t.name])).toEqual([
      [TEAM_1, 'design', 'Design'],
      [TEAM_2, 'sales', 'Sales']
    ]);
    expect(await seatsOf(tess.email, ORG_A)).toEqual([TEAM_1, TEAM_2]);
    // An org whose entry carries no teams projects none.
    expect(await teamsOf(ORG_B)).toEqual([]);
  });

  it('a later pass removes the seat the hub dropped, keeps the other, and renames a team in place', async () => {
    const before = await teamsOf(ORG_A);
    // The org still holds both teams; she left Sales, and Design was renamed.
    hub.setOrgTeams(ORG_A, [
      { id: TEAM_1, slug: 'design-studio', name: 'Design Studio' },
      { id: TEAM_2, slug: 'sales', name: 'Sales' }
    ]);
    hub.setUserOrg(tess.sub, ORG_A, {
      name: 'Org A',
      role: 'member',
      teams: [{ id: TEAM_1, slug: 'design-studio', name: 'Design Studio' }]
    });
    expireTtl();
    expect((await me(cookie)).status).toBe(200);

    expect(await seatsOf(tess.email, ORG_A)).toEqual([TEAM_1]);
    const after = await teamsOf(ORG_A);
    const renamed = after.find((t) => t.hub_team_id === TEAM_1)!;
    expect(renamed).toMatchObject({ slug: 'design-studio', name: 'Design Studio' });
    // Same row: the team is renamed where it stands, never re-created.
    expect(renamed.id).toBe(before.find((t) => t.hub_team_id === TEAM_1)!.id);
  });

  it('an org swept from the list deactivates the membership and deletes the person’s seats and project grants', async () => {
    const workspaceId = await workspaceIdOf(ORG_A);
    // A project grant in ORG_A, the way it is made locally (an owner of the org adds her).
    const owner: HubUserFixture = {
      sub: 'hub-teams-owner',
      email: 'owner-a@hub-teams.test',
      name: 'Owner A',
      workspaceId: ORG_A,
      role: 'owner',
      workspaceName: 'Org A'
    };
    const ownerCookie = await sso.ssoLogin(app, hub, owner);
    const headers = {
      cookie: ownerCookie,
      'x-workspace-id': workspaceId,
      'content-type': 'application/json',
      'x-forwarded-for': sso.nextIp()
    };
    const project = await app.app.request('/api/v1/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Teams project' })
    });
    expect(project.status).toBe(201);
    const projectId = (await readJson(project)).id as string;
    const grant = await app.app.request(`/api/v1/projects/${projectId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: tess.email, role: 'viewer' })
    });
    expect(grant.status).toBe(201);
    expect(await seatsOf(tess.email, ORG_A)).toEqual([TEAM_1]);

    const { rows: memberRows } = await app.db.pool.query(
      `SELECT m.id FROM workspace_members m JOIN "user" u ON u.id = m.user_id
        WHERE u.email = $1 AND m.workspace_id = $2`,
      [tess.email, workspaceId]
    );
    const memberId = memberRows[0].id as string;

    hub.removeUserOrg(tess.sub, ORG_A);
    expireTtl();
    await me(cookie);

    const { rows: after } = await app.db.pool.query(`SELECT is_active FROM workspace_members WHERE id = $1`, [
      memberId
    ]);
    expect(after).toEqual([{ is_active: false }]);
    const { rows: seats } = await app.db.pool.query(
      `SELECT id FROM workspace_team_members WHERE member_id = $1`,
      [memberId]
    );
    expect(seats).toEqual([]);
    const { rows: grants } = await app.db.pool.query(`SELECT id FROM project_members WHERE member_id = $1`, [
      memberId
    ]);
    expect(grants).toEqual([]);
    // The team itself stays: the projection is the hub's teams, the seat was hers.
    expect((await teamsOf(ORG_A)).map((t) => t.hub_team_id)).toEqual([TEAM_1, TEAM_2]);
  });
});

describe('the denied hint on /me', () => {
  const dora: HubUserFixture = {
    sub: 'hub-dora',
    email: 'dora@hub-teams.test',
    name: 'Dora Denied',
    workspaceId: ORG_B,
    role: 'member',
    workspaceName: 'Org B'
  };
  const noAccessUrl = () => `${hub.issuer.replace(/\/+$/, '')}/no-access?client_id=${host.hubClientId}`;
  let cookie = '';

  it('a denied org in the hub’s answer reaches /me as hubDenied, with the ready-made no-access URL', async () => {
    hub.setUserDenied(dora.sub, [{ id: ORG_DENY, name: 'Restricted Org' }]);
    cookie = await sso.ssoLogin(app, hub, dora);
    const body = await readJson(await me(cookie));
    expect(body.workspace).not.toBeNull();
    expect(body.hubDenied).toEqual([{ id: ORG_DENY, name: 'Restricted Org' }]);
    expect(body.hubNoAccessUrl).toBe(noAccessUrl());
  });

  it('an inconclusive pass keeps the last list', async () => {
    hub.orgsMode = 'http500';
    try {
      const passesBefore = hub.orgsRequests.length;
      expireTtl();
      const body = await readJson(await me(cookie));
      expect(hub.orgsRequests.length).toBeGreaterThan(passesBefore);
      expect(body.hubDenied).toEqual([{ id: ORG_DENY, name: 'Restricted Org' }]);
    } finally {
      hub.orgsMode = 'ok';
    }
  });

  it('a later definitive pass with denied: [] empties it', async () => {
    hub.setUserDenied(dora.sub, []);
    expireTtl();
    await me(cookie); // the pass runs in the gate, before the handler reads the hint
    const body = await readJson(await me(cookie));
    expect(body.hubDenied).toEqual([]);
  });

  it('the zero-membership state names the refusing org too', async () => {
    // Her only org now restricts the tool to teams she is not in: the hub
    // leaves it out of `orgs` and names it in `denied`.
    hub.removeUserOrg(dora.sub, ORG_B);
    hub.setUserDenied(dora.sub, [{ id: ORG_B, name: 'Org B' }]);
    expireTtl();
    const revoked = await me(cookie);
    expect(revoked.status).toBe(401);
    expect((await readJson(revoked)).error.code).toBe('membership_revoked');

    const zero = await me(cookie);
    expect(zero.status).toBe(200);
    const body = await readJson(zero);
    expect(body.workspace).toBeNull();
    expect(body.workspaces).toEqual([]);
    expect(body.hubDenied).toEqual([{ id: ORG_B, name: 'Org B' }]);
    expect(body.hubNoAccessUrl).toBe(noAccessUrl());
  });
});

describe('re-admission of a single-organization person', () => {
  // Her ONLY org: once it is swept, her session resolves to no workspace and
  // the live gate never runs for it — the zero-state /me runs the pass.
  const rita: HubUserFixture = {
    sub: 'hub-rita',
    email: 'rita@hub-teams.test',
    name: 'Rita Readmitted',
    workspaceId: ORG_C,
    role: 'member',
    workspaceName: 'Org C'
  };
  let cookie = '';

  it('a bare /me re-admits her once the hub lists her only organization again', async () => {
    hub.setUserOrg(rita.sub, ORG_C, {
      name: 'Org C',
      role: 'member',
      teams: [{ id: TEAM_3, slug: 'ops', name: 'Ops' }]
    });
    cookie = await sso.ssoLogin(app, hub, rita);
    const workspaceId = await workspaceIdOf(ORG_C);
    expect(await seatsOf(rita.email, ORG_C)).toEqual([TEAM_3]);

    // The owner takes her off the team the tool is open to: the hub leaves
    // the org out of her list and names it as denied.
    hub.removeUserOrg(rita.sub, ORG_C);
    hub.setUserDenied(rita.sub, [{ id: ORG_C, name: 'Org C' }]);
    expireTtl();
    const revoked = await me(cookie);
    expect(revoked.status).toBe(401);
    expect((await readJson(revoked)).error.code).toBe('membership_revoked');
    const zero = await readJson(await me(cookie));
    expect(zero.workspace).toBeNull();
    expect(zero.hubDenied).toEqual([{ id: ORG_C, name: 'Org C' }]);
    expect(await seatsOf(rita.email, ORG_C)).toEqual([]);

    // The polling page within the TTL: the zero-state read rides the cache,
    // never a hub call per request. One read first, so the window starts
    // here (the reads above and the seats query may have outlived the test
    // dial's 120 ms TTL), then two reads inside it.
    await me(cookie);
    const before = hub.orgsRequests.length;
    await me(cookie);
    await me(cookie);
    expect(hub.orgsRequests.length).toBe(before);

    // Re-seated at the hub: a BARE /me (no X-Workspace-Id) past the TTL
    // answers the normal shape with her workspace.
    hub.setUserOrg(rita.sub, ORG_C, {
      name: 'Org C',
      role: 'member',
      teams: [{ id: TEAM_3, slug: 'ops', name: 'Ops' }]
    });
    hub.setUserDenied(rita.sub, []);
    expireTtl();
    const back = await me(cookie);
    expect(back.status).toBe(200);
    const body = await readJson(back);
    expect(hub.orgsRequests.length).toBe(before + 1);
    expect(body.workspace).toMatchObject({ id: workspaceId, name: 'Org C', hubOrigin: true });
    expect(body.activeWorkspaceId).toBe(workspaceId);
    expect(body.role).toBe('member');
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId]);
    expect(body.hubDenied).toEqual([]);
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m JOIN "user" u ON u.id = m.user_id
        WHERE u.email = $1 AND m.workspace_id = $2`,
      [rita.email, workspaceId]
    );
    expect(rows).toEqual([{ is_active: true }]);
    expect(await seatsOf(rita.email, ORG_C)).toEqual([TEAM_3]);
  });
});

describe('self-hosted edition: no teams, no hint', () => {
  // One oss app for both cases: the first reads /me with the owner's
  // membership live, the second after it went inactive.
  let oss: TestApp;
  let cookie: string;

  beforeAll(async () => {
    oss = await createTestApp(await createDatabase(container, 'hub_teams_oss'));
    const setup = await oss.app.request(
      '/api/v1/setup',
      sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'TeamsOss', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const signIn = await oss.app.request(
      '/api/v1/auth/sign-in/email',
      sso.json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    cookie = extractCookie(signIn);
  }, 240_000);

  afterAll(async () => {
    await oss?.stop();
  });

  it('/me carries no hubDenied and the two tables stay empty across a login', async () => {
    const res = await oss.app.request('/api/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect('hubDenied' in body).toBe(false);
    expect('hubNoAccessUrl' in body).toBe(false);
    const { rows } = await oss.db.pool.query(
      `SELECT (SELECT count(*) FROM workspace_teams)::int AS teams,
              (SELECT count(*) FROM workspace_team_members)::int AS seats`
    );
    expect(rows).toEqual([{ teams: 0, seats: 0 }]);
  });

  it('the zero-membership /me runs no hub pass (no reconciler)', async () => {
    // A second owner keeps the workspace owned (the last-owner guard), so
    // the signed-in owner's own membership can go inactive.
    const { rows: ws } = await oss.db.pool.query(`SELECT id FROM workspaces LIMIT 1`);
    const siblingId = 'hub-teams-oss-sibling-owner';
    await oss.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Sibling Owner', 'sibling@teams-oss.test', true)`,
      [siblingId]
    );
    await oss.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'owner', true)`,
      [ws[0].id, siblingId]
    );
    await oss.db.pool.query(`UPDATE workspace_members SET is_active = false WHERE user_id <> $1`, [
      siblingId
    ]);
    const before = hub.orgsRequests.length;
    const res = await oss.app.request('/api/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspace).toBeNull();
    expect(body.workspaces).toEqual([]);
    expect('hubDenied' in body).toBe(false);
    expect(hub.orgsRequests.length).toBe(before);
  });
});

describe('the organization’s whole team list (PRDCT-2813)', () => {
  const tom: HubUserFixture = {
    sub: 'hub-tom',
    email: 'tom@hub-teams.test',
    name: 'Tom Teamlist',
    workspaceId: ORG_T,
    role: 'member',
    workspaceName: 'Org T'
  };
  const A = { id: TEAM_A, slug: 'alpha', name: 'Alpha' };
  const B = { id: TEAM_B, slug: 'beta', name: 'Beta' };
  const C = { id: TEAM_C, slug: 'gamma', name: 'Gamma' };
  let cookie = '';
  const hubIdsOf = async () => (await teamsOf(ORG_T)).map((t) => t.hub_team_id);

  it('at login every team of the org lands, while the person is seated only in her own', async () => {
    hub.setOrgTeams(ORG_T, [A, B, C]);
    hub.setUserOrg(tom.sub, ORG_T, { name: 'Org T', role: 'member', teams: [A] });
    const teamsBefore = hub.teamsRequests.length;
    cookie = await sso.ssoLogin(app, hub, tom);

    expect((await teamsOf(ORG_T)).map((t) => [t.hub_team_id, t.slug, t.name])).toEqual([
      [TEAM_A, 'alpha', 'Alpha'],
      [TEAM_B, 'beta', 'Beta'],
      [TEAM_C, 'gamma', 'Gamma']
    ]);
    expect(await seatsOf(tom.email, ORG_T)).toEqual([TEAM_A]);

    // Read as the person: her own grant token, the hub org in X-Workspace-Id.
    expect(hub.teamsRequests.length).toBe(teamsBefore + 1);
    const read = hub.teamsRequests.at(-1)!;
    expect(read.orgId).toBe(ORG_T);
    expect(read.auth).toMatch(/^Bearer .+/);
    expect(read.auth).toBe(hub.orgsRequests.at(-1)!.auth);
  });

  it('a pass inside orgTeamsTtlMs does not read the list again; one past it does', async () => {
    const orgsBefore = hub.orgsRequests.length;
    const teamsBefore = hub.teamsRequests.length;
    advance(DIALS.reconcileTtlMs + 40);
    expect((await me(cookie)).status).toBe(200);
    expect(hub.orgsRequests.length).toBeGreaterThan(orgsBefore);
    expect(hub.teamsRequests.length).toBe(teamsBefore);

    expireOrgTeams();
    expect((await me(cookie)).status).toBe(200);
    expect(hub.teamsRequests.length).toBe(teamsBefore + 1);
  });

  it('a login reads the list whatever the window says: a team made at the hub a moment ago lands at once', async () => {
    // The list was just read (the test above): inside orgTeamsTtlMs a pass
    // leaves it, a LOGIN does not (Romain's rule: at login, then every five
    // minutes). The team D made at the hub between the two is here right after.
    const D = { id: '26260000-dddd-4ddd-8ddd-00000000000d', slug: 'delta', name: 'Delta' };
    hub.setOrgTeams(ORG_T, [A, B, C, D]);
    const teamsBefore = hub.teamsRequests.length;
    cookie = await sso.ssoLogin(app, hub, tom);
    expect(hub.teamsRequests.length).toBe(teamsBefore + 1);
    expect(await hubIdsOf()).toContain(D.id);
    hub.setOrgTeams(ORG_T, [A, B, C]);
    expireOrgTeams();
    expect((await me(cookie)).status).toBe(200);
    expect(await hubIdsOf()).not.toContain(D.id);
  });

  it('a team deleted at the hub goes with its project entries; a local team stays', async () => {
    const workspaceId = await workspaceIdOf(ORG_T);
    const teamC = (await teamsOf(ORG_T)).find((t) => t.hub_team_id === TEAM_C)!;
    const [project] = await app.db.db
      .insert(projects)
      .values({ workspaceId, name: 'Team list project' })
      .returning({ id: projects.id });
    await app.db.db.insert(projectTeams).values({ projectId: project!.id, teamId: teamC.id, role: 'viewer' });
    const [local] = await app.db.db
      .insert(workspaceTeams)
      .values({ workspaceId, hubTeamId: null, slug: 'local-crew', name: 'Local crew' })
      .returning({ id: workspaceTeams.id });

    hub.setOrgTeams(ORG_T, [A, B]);
    expireOrgTeams();
    expect((await me(cookie)).status).toBe(200);

    expect(await hubIdsOf()).toEqual([TEAM_A, TEAM_B, null]);
    const { rows: grants } = await app.db.pool.query(`SELECT id FROM project_teams WHERE team_id = $1`, [
      teamC.id
    ]);
    expect(grants).toEqual([]);
    const { rows: localRows } = await app.db.pool.query(`SELECT slug FROM workspace_teams WHERE id = $1`, [
      local!.id
    ]);
    expect(localRows).toEqual([{ slug: 'local-crew' }]);
    expect(await seatsOf(tom.email, ORG_T)).toEqual([TEAM_A]);
  });

  it('a team renamed at the hub follows, on the same row', async () => {
    const before = (await teamsOf(ORG_T)).find((t) => t.hub_team_id === TEAM_B)!;
    hub.setOrgTeams(ORG_T, [A, { id: TEAM_B, slug: 'beta-squad', name: 'Beta Squad' }]);
    expireOrgTeams();
    expect((await me(cookie)).status).toBe(200);
    const after = (await teamsOf(ORG_T)).find((t) => t.hub_team_id === TEAM_B)!;
    expect(after).toMatchObject({ id: before.id, slug: 'beta-squad', name: 'Beta Squad' });
  });

  it('a failed read (500, then an older hub’s 404) keeps the list and waits retryMs before the next', async () => {
    // A list that WOULD delete B if it were read.
    hub.setOrgTeams(ORG_T, [A]);
    hub.teamsMode = 'http500';
    try {
      expireOrgTeams();
      const teamsBefore = hub.teamsRequests.length;
      expect((await me(cookie)).status).toBe(200);
      expect(hub.teamsRequests.length).toBe(teamsBefore + 1);
      expect(await hubIdsOf()).toEqual([TEAM_A, TEAM_B, null]);

      // Another pass inside retryMs: no read. A LOGIN inside retryMs: no
      // read either (a login skips the window, never the failure throttle,
      // verifier round 2).
      advance(DIALS.reconcileTtlMs + 40);
      expect((await me(cookie)).status).toBe(200);
      expect(hub.teamsRequests.length).toBe(teamsBefore + 1);
      cookie = await sso.ssoLogin(app, hub, tom);
      expect(hub.teamsRequests.length).toBe(teamsBefore + 1);

      // Past retryMs: read again, an older hub this time.
      hub.teamsMode = 'http404';
      advance(DIALS.retryMs + 40);
      expect((await me(cookie)).status).toBe(200);
      expect(hub.teamsRequests.length).toBe(teamsBefore + 2);
      expect(await hubIdsOf()).toEqual([TEAM_A, TEAM_B, null]);
    } finally {
      hub.teamsMode = 'ok';
      hub.setOrgTeams(ORG_T, [A, { id: TEAM_B, slug: 'beta-squad', name: 'Beta Squad' }]);
    }
  });

  it('hub_org_teams_refresh_total is on /metrics and counts the successful reads', async () => {
    const res = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer hub-teams-metrics-token' }
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/hub_org_teams_refresh_total\{outcome="ok"\} [1-9]/);
    expect(text).toMatch(/hub_org_teams_refresh_total\{outcome="inconclusive"\} [1-9]/);
  });

  it('an empty page behind a lost cursor is a cut list: nothing is deleted until an honest read (verifier round 1, F1)', async () => {
    // An org of more than one page (the client asks limit=100): 102 teams.
    const pagy: HubUserFixture = {
      sub: 'hub-pagy',
      email: 'pagy@hub-teams.test',
      name: 'Pagy Paged',
      workspaceId: ORG_P,
      role: 'member',
      workspaceName: 'Org P'
    };
    const many = Array.from({ length: 102 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return { id: `27270000-eeee-4eee-8fff-000000000${n}`, slug: `t-${n}`, name: `Team ${n}` };
    });
    const idOf = (n: number) => many[n - 1]!.id;
    const pagedIds = async () => (await teamsOf(ORG_P)).map((t) => t.hub_team_id);
    hub.setOrgTeams(ORG_P, many);
    hub.setUserOrg(pagy.sub, ORG_P, { name: 'Org P', role: 'member', teams: [many[0]!] });
    const firstRead = hub.teamsRequests.length;
    const pagyCookie = await sso.ssoLogin(app, hub, pagy);
    expect(hub.teamsRequests.length).toBe(firstRead + 2);
    expect(await pagedIds()).toHaveLength(102);
    expect(await seatsOf(pagy.email, ORG_P)).toEqual([idOf(1)]);

    // Project entries on a team of the first page and on one of the second
    // (the one an unread page carries: the damage F1 describes).
    const workspaceId = await workspaceIdOf(ORG_P);
    const [project] = await app.db.db
      .insert(projects)
      .values({ workspaceId, name: 'Paged project' })
      .returning({ id: projects.id });
    const local = new Map((await teamsOf(ORG_P)).map((t) => [t.hub_team_id, t.id]));
    for (const n of [50, 101]) {
      await app.db.db
        .insert(projectTeams)
        .values({ projectId: project!.id, teamId: local.get(idOf(n))!, role: 'viewer' });
    }

    // t-102 goes at the hub, and the cursor of page 1 is lost: page 2 answers empty.
    hub.setOrgTeams(ORG_P, many.slice(0, 101));
    hub.teamsCursorLost = true;
    try {
      const okBefore = await refreshOkCount();
      const before = hub.teamsRequests.length;
      expireOrgTeams();
      expect((await me(pagyCookie)).status).toBe(200);
      // Both pages were read, the read counted ok, and nothing was deleted.
      expect(hub.teamsRequests.length).toBe(before + 2);
      expect(await refreshOkCount()).toBe(okBefore + 1);
      expect(await pagedIds()).toHaveLength(102);
      const { rows: entries } = await app.db.pool.query(
        `SELECT team_id FROM project_teams WHERE project_id = $1`,
        [project!.id]
      );
      expect(entries).toHaveLength(2);
    } finally {
      hub.teamsCursorLost = false;
    }

    // The next honest read deletes what the hub dropped, and only that.
    expireOrgTeams();
    expect((await me(pagyCookie)).status).toBe(200);
    const after = await pagedIds();
    expect(after).toHaveLength(101);
    expect(after).not.toContain(idOf(102));
    const { rows: kept } = await app.db.pool.query(
      `SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id`,
      [project!.id]
    );
    expect(kept.map((r) => r.team_id).sort()).toEqual([local.get(idOf(50)), local.get(idOf(101))].sort());
  });

  it('a team projected while the list was being read survives that read’s delete; an older one does not (verifier round 1, F5)', async () => {
    const workspaceId = await workspaceIdOf(ORG_T);
    const OLD = '27270000-dddd-4eee-8fff-0000000000f1';
    const LATE = '27270000-dddd-4eee-8fff-0000000000f2';
    // Projected BEFORE the read, gone from the hub's list: the pass deletes it.
    await app.db.db.insert(workspaceTeams).values({
      workspaceId,
      hubTeamId: OLD,
      slug: 'old-gone',
      name: 'Old gone',
      createdAt: new Date(Date.now() - 60_000)
    });
    // Held under the client's own timeout (the dial's orgsTimeoutMs, 400 ms),
    // long enough for a write to land while the read is out.
    hub.teamsDelayMs = 250;
    try {
      expireOrgTeams();
      const before = hub.teamsRequests.length;
      const pending = me(cookie);
      // The read has begun (the hub holds it): another replica projects a team
      // the list it is reading cannot carry yet.
      for (let i = 0; hub.teamsRequests.length === before && i < 200; i++) await sleep(10);
      expect(hub.teamsRequests.length).toBe(before + 1);
      await sleep(20);
      await app.db.db
        .insert(workspaceTeams)
        .values({ workspaceId, hubTeamId: LATE, slug: 'late-comer', name: 'Late comer' });
      expect((await pending).status).toBe(200);
    } finally {
      hub.teamsDelayMs = 0;
    }
    const ids = await hubIdsOf();
    expect(ids).toContain(LATE);
    expect(ids).not.toContain(OLD);
    // Tidy: the late team is not the hub's; the next honest pass would take it.
    await app.db.db.delete(workspaceTeams).where(eq(workspaceTeams.hubTeamId, LATE));
  });

  it('projectOrgTeams deletes nothing from an incomplete list, and the rest from a complete one (verifier round 1, mutation #11)', async () => {
    const workspaceId = await workspaceIdOf(ORG_T);
    expect(await hubIdsOf()).toEqual(expect.arrayContaining([TEAM_A, TEAM_B]));
    await app.db.db.transaction((tx) => projectOrgTeams(tx, { workspaceId, teams: [A], complete: false }));
    expect(await hubIdsOf()).toEqual(expect.arrayContaining([TEAM_A, TEAM_B]));
    await app.db.db.transaction((tx) => projectOrgTeams(tx, { workspaceId, teams: [A], complete: true }));
    const ids = await hubIdsOf();
    expect(ids).toContain(TEAM_A);
    expect(ids).not.toContain(TEAM_B);
    // The local team is never the projection's.
    expect(ids).toContain(null);
  });

  it('an EMPTY org list deletes every projected team and never a local one (verifier round 1, mutation #10)', async () => {
    const workspaceId = await workspaceIdOf(ORG_T);
    // B back as a projected team she is NOT seated in (the call above took it).
    await app.db.db.transaction((tx) => projectOrgTeams(tx, { workspaceId, teams: [A, B], complete: false }));
    const [local] = await app.db.db
      .insert(workspaceTeams)
      .values({ workspaceId, hubTeamId: null, slug: 'local-survivor', name: 'Local survivor' })
      .returning({ id: workspaceTeams.id });
    expect(await hubIdsOf()).toEqual(expect.arrayContaining([TEAM_A, TEAM_B]));

    hub.setOrgTeams(ORG_T, []);
    expireOrgTeams();
    expect((await me(cookie)).status).toBe(200);

    const { rows } = await app.db.pool.query(
      `SELECT id, hub_team_id FROM workspace_teams WHERE workspace_id = $1`,
      [workspaceId]
    );
    const hubIds = rows.map((r) => r.hub_team_id as string | null);
    expect(hubIds).not.toContain(TEAM_B);
    // Her own seat's team may come back through `projectTeamSeats`; nothing else projected stays.
    expect(hubIds.filter((h) => h !== null && h !== TEAM_A)).toEqual([]);
    expect(rows.map((r) => r.id)).toContain(local!.id);
  });
});

async function refreshOkCount(): Promise<number> {
  const res = await app.app.request('/metrics', {
    headers: { authorization: 'Bearer hub-teams-metrics-token' }
  });
  expect(res.status).toBe(200);
  const match = /hub_org_teams_refresh_total\{outcome="ok"\} (\d+)/.exec(await res.text());
  return match ? Number(match[1]) : 0;
}
