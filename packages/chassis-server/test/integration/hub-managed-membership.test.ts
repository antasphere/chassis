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
import { InvitationService } from '@antasphere/chassis-server/invitations';
import * as sso from './sso-helpers.js';

/**
 * P7 — cloud-gating the local membership surfaces on hub-origin workspaces
 * (internal/federation.md "Hub-managed membership"; binding plan §7; patterns §6).
 *
 * On EDITION=cloud a hub org projects into a workspace whose MEMBERSHIP is
 * the hub's source of truth. This suite pins:
 *
 *  - every local membership MUTATION on the projected workspace answers
 *    403 `hub_managed` with `details.manageUrl` → the hub (invitation
 *    create/accept/revoke, member role-change/deactivate/reactivate/delete,
 *    reset-link, change-email-link) — and mutates NOTHING;
 *  - READS stay: GET /members serves the projected roster, GET /invitations
 *    lists;
 *  - the SAME credential performs the SAME mutations on a cloud-LOCAL
 *    workspace (centralAccountId NULL) — the operator's own — unhindered:
 *    the boundary is the workspace's projection, never the edition alone;
 *  - /me carries the new adaptation signals (workspace.hubOrigin, per-entry
 *    hubOrigin, membership `origin`, hubManageUrl) without leaking the raw
 *    hub org id;
 *  - machine credentials: the fail-closed scope allowlist keeps every
 *    /members + /invitations shape unreachable to keys (403
 *    endpoint_not_allowed) — the P7 gate is a second wall behind it;
 *  - MCP needs zero changes: tools re-enter /api/v1 in-process, so the
 *    tool surface exposes no membership mutation at all, whoami carries the
 *    new /me fields, and per-deck reads work on the projected workspace.
 *
 * The MCP leg (three `it`s that call the deck MCP tools) is the tool's: the
 * tool's app keeps it, `apps/server/test/integration/hub-managed-membership-mcp.test.ts`.
 */

const OPERATOR = { email: 'operator@p7.test', name: 'Operator', password: 'operator-pass-p7-1' };
const HUB_ADMIN_EMAIL = 'hub-admin@p7.test';
const HUB_MEMBER_EMAIL = 'hub-member@p7.test';
const ORG_A = '77777777-aaaa-4bbb-8ccc-000000000001';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

let operatorCookie: string;
/** The setup workspace — cloud-LOCAL (centralAccountId NULL). */
let operatorWorkspaceId: string;
let hubAdminCookie: string;
/** ORG_A's lazy projection — hub-origin (centralAccountId = ORG_A). */
let projectedWorkspaceId: string;
/** The hub member's membership ROW id in the projected workspace. */
let hubMemberRowId: string;
/** hubAdmin's API key, bound to the projected workspace at mint. */
let projectedKey: string;

let ipCounter = 0;
const nextIp = () => `10.96.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const hubAdmin: HubUserFixture = {
  sub: 'hub-admin-p7',
  email: HUB_ADMIN_EMAIL,
  name: 'Hub Admin',
  workspaceId: ORG_A,
  role: 'owner',
  workspaceName: 'Org A'
};

const hubMember: HubUserFixture = {
  sub: 'hub-member-p7',
  email: HUB_MEMBER_EMAIL,
  name: 'Hub Member',
  workspaceId: ORG_A,
  role: 'member',
  workspaceName: 'Org A'
};

/** Headers targeting the projected workspace with hubAdmin's session. */
const asHubAdmin = (extra: Record<string, string> = {}) => ({
  cookie: hubAdminCookie,
  'x-workspace-id': projectedWorkspaceId,
  ...extra
});

async function expectHubManaged(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = await readJson(res);
  expect(body.error.code).toBe('hub_managed');
  expect(body.error.details.manageUrl).toBe(hub.issuer);
}

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(await createDatabase(container, 'p7_hub_managed'), {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-p7'
  });

  // The operator's own cloud-LOCAL workspace (centralAccountId NULL). Cloud
  // setup mints NO workspace (user-scoped federation), so the fixture seeds
  // it directly — the P7 contrast under test is the workspace's PROJECTION,
  // not how it came to exist.
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'P7 Cloud', owner: OPERATOR })
  );
  expect(setup.status).toBe(201);
  operatorWorkspaceId = await sso.seedLocalWorkspace(app, 'P7 Cloud', OPERATOR.email);
  operatorCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OPERATOR.email, password: OPERATOR.password })
    )
  );

  // Two hub identities SSO into ORG_A: the first login lazily projects the
  // org into a workspace; the second lands a 'member' row in the SAME one.
  hubAdminCookie = await sso.ssoLogin(app, hub, hubAdmin);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: hubAdminCookie } }));
  projectedWorkspaceId = me.activeWorkspaceId;
  const memberCookie = await sso.ssoLogin(app, hub, hubMember);
  const memberMe = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } }));
  expect(memberMe.activeWorkspaceId).toBe(projectedWorkspaceId);

  const { rows } = await app.db.pool.query(
    `SELECT wm.id FROM workspace_members wm JOIN "user" u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND u.email = $2`,
    [projectedWorkspaceId, HUB_MEMBER_EMAIL]
  );
  hubMemberRowId = rows[0].id;

  // hubAdmin's API key, minted from the session and PINNED to the projected
  // workspace (the optional least-privilege pin of the user-scoped model) —
  // so every request it makes lands on the projection, as this suite pins.
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json(
        {
          name: 'p7-key',
          scopes: [host.scopes.read, host.scopes.write],
          workspaceId: projectedWorkspaceId
        },
        asHubAdmin()
      )
    )
  );
  projectedKey = minted.key;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('mutations on the HUB-ORIGIN workspace → 403 hub_managed + pointer', () => {
  it('invitation create', async () => {
    await expectHubManaged(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'newcomer@p7.test', role: 'member' }, asHubAdmin())
      )
    );
  });

  it('invitation revoke (any local invitation mutation is hub-managed)', async () => {
    await expectHubManaged(
      await app.app.request('/api/v1/invitations/99999999-9999-4999-8999-999999999999', {
        method: 'DELETE',
        headers: asHubAdmin({ 'x-forwarded-for': nextIp() })
      })
    );
  });

  it('member role-change, deactivate, reactivate — and the row never moves', async () => {
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}`, {
        ...json({ role: 'admin' }, asHubAdmin()),
        method: 'PATCH'
      })
    );
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}`, {
        ...json({ isActive: false }, asHubAdmin()),
        method: 'PATCH'
      })
    );
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}`, {
        ...json({ isActive: true }, asHubAdmin()),
        method: 'PATCH'
      })
    );
    const { rows } = await app.db.pool.query(`SELECT role, is_active FROM workspace_members WHERE id = $1`, [
      hubMemberRowId
    ]);
    expect(rows[0]).toEqual({ role: 'member', is_active: true });
  });

  it('member delete', async () => {
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}`, {
        method: 'DELETE',
        headers: asHubAdmin({ 'x-forwarded-for': nextIp() })
      })
    );
    const { rows } = await app.db.pool.query(`SELECT 1 FROM workspace_members WHERE id = $1`, [
      hubMemberRowId
    ]);
    expect(rows).toHaveLength(1);
  });

  it('reset-link and change-email-link (the credential surfaces are the hub’s too)', async () => {
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}/reset-link`, {
        method: 'POST',
        headers: asHubAdmin({ 'x-forwarded-for': nextIp() })
      })
    );
    await expectHubManaged(
      await app.app.request(
        `/api/v1/members/${hubMemberRowId}/change-email-link`,
        json({ newEmail: 'sideways@p7.test' }, asHubAdmin())
      )
    );
  });

  it('the gate covers the WHOLE subtree: unrouted mutation shapes under /members + /invitations are refused before any 404 (fail-closed for future routes)', async () => {
    // None of these paths has a handler today — a future mutation added
    // here must be refused by default, never opened. The refusal must win
    // over the JSON 404 terminator.
    await expectHubManaged(await app.app.request('/api/v1/members', json({ anything: true }, asHubAdmin())));
    await expectHubManaged(
      await app.app.request(`/api/v1/members/${hubMemberRowId}/some-future-mutation`, {
        method: 'POST',
        headers: asHubAdmin({ 'x-forwarded-for': nextIp() })
      })
    );
    await expectHubManaged(
      await app.app.request('/api/v1/invitations/99999999-9999-4999-8999-999999999999/resend', {
        method: 'POST',
        headers: asHubAdmin({ 'x-forwarded-for': nextIp() })
      })
    );
    // The same unrouted shapes OFF the projection stay plain 404s — the
    // subtree mount changes nothing for cloud-LOCAL workspaces.
    const local = await app.app.request('/api/v1/members', {
      ...json({ anything: true }, { cookie: operatorCookie })
    });
    expect(local.status).toBe(404);
  });

  it('invitation ACCEPT against a projected workspace is refused even for a pre-existing row (defense in depth)', async () => {
    // No API path can create this row (the gate above) — seed it through the
    // service directly, the way legacy/seeded data would exist.
    const service = new InvitationService(app.db.db);
    const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [OPERATOR.email]);
    const seeded = await service.create({
      workspaceId: projectedWorkspaceId,
      email: 'seeded-invitee@p7.test',
      role: 'member',
      invitedBy: rows[0].id
    });
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: seeded.token, name: 'Seeded', password: 'a-perfectly-fine-password' })
    );
    await expectHubManaged(res);
    // Nothing was minted for the invitee.
    const { rows: users } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [
      'seeded-invitee@p7.test'
    ]);
    expect(users).toHaveLength(0);
  });
});

describe('reads on the HUB-ORIGIN workspace stay open', () => {
  it('GET /members serves the projected roster', async () => {
    const res = await app.app.request('/api/v1/members', { headers: asHubAdmin() });
    expect(res.status).toBe(200);
    const { members } = await readJson(res);
    const emails = members.map((m: { email: string }) => m.email).sort();
    expect(emails).toEqual([HUB_ADMIN_EMAIL, HUB_MEMBER_EMAIL]);
  });

  it('GET /invitations lists', async () => {
    const res = await app.app.request('/api/v1/invitations', { headers: asHubAdmin() });
    expect(res.status).toBe(200);
  });
});

describe('the SAME mutations on a cloud-LOCAL workspace still work (the boundary is projection, not edition)', () => {
  let acceptToken: string;

  it('operator invites hubAdmin into the operator workspace — 201', async () => {
    const res = await app.app.request(
      '/api/v1/invitations',
      json({ email: HUB_ADMIN_EMAIL, role: 'admin' }, { cookie: operatorCookie })
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    acceptToken = body.acceptUrl.split('/invite/')[1] as string;
  });

  it('hubAdmin ACCEPTS it (public accept works on cloud for local workspaces)', async () => {
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: acceptToken }, { cookie: hubAdminCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(operatorWorkspaceId);
  });

  it('the ONE credential sees both sides: refused on the projection, free on the local workspace', async () => {
    // Same session, local workspace selected: invitation create + revoke work.
    const created = await app.app.request(
      '/api/v1/invitations',
      json(
        { email: 'local-colleague@p7.test', role: 'member' },
        { cookie: hubAdminCookie, 'x-workspace-id': operatorWorkspaceId }
      )
    );
    expect(created.status).toBe(201);
    const { invitation } = await readJson(created);
    const revoked = await app.app.request(`/api/v1/invitations/${invitation.id}`, {
      method: 'DELETE',
      headers: {
        cookie: hubAdminCookie,
        'x-workspace-id': operatorWorkspaceId,
        'x-forwarded-for': nextIp()
      }
    });
    expect(revoked.status).toBe(200);
    // Same session, projected workspace selected: refused (pinned above,
    // re-checked here to make the single-credential contrast explicit).
    await expectHubManaged(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'local-colleague-2@p7.test', role: 'member' }, asHubAdmin())
      )
    );
  });

  it('member mutations on the local workspace work: role change — but reset-link refuses EDITION-wide (P8)', async () => {
    const { rows } = await app.db.pool.query(
      `SELECT wm.id FROM workspace_members wm JOIN "user" u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND u.email = $2`,
      [operatorWorkspaceId, HUB_ADMIN_EMAIL]
    );
    const localRowId = rows[0].id;
    // The reset-link mint is the ONE local-workspace exception to "the
    // boundary is projection, not edition": since the P8 close (ADR 017)
    // the whole password-reset surface refuses on cloud — a minted link
    // would dead-end on the refused POST /reset-password. Distinct code
    // from the projection gate: password_reset_disabled, not hub_managed.
    const reset = await app.app.request(`/api/v1/members/${localRowId}/reset-link`, {
      method: 'POST',
      headers: { cookie: operatorCookie, 'x-forwarded-for': nextIp() }
    });
    expect(reset.status).toBe(403);
    expect((await readJson(reset)).error.code).toBe('password_reset_disabled');
    const rerole = await app.app.request(`/api/v1/members/${localRowId}`, {
      ...json({ role: 'member' }, { cookie: operatorCookie }),
      method: 'PATCH'
    });
    expect(rerole.status).toBe(200);
    expect((await readJson(rerole)).role).toBe('member');
  });
});

describe('/me carries the adaptation signals (and never the raw hub org id)', () => {
  it('projected workspace: hubOrigin true, origin hub, hubManageUrl → the hub', async () => {
    const res = await app.app.request('/api/v1/me', { headers: asHubAdmin() });
    expect(res.status).toBe(200);
    const me = await readJson(res);
    expect(me.workspace.hubOrigin).toBe(true);
    expect(me.origin).toBe('hub');
    expect(me.hubManageUrl).toBe(hub.issuer);
    // Per-entry flags across BOTH memberships of the one session.
    const byId = Object.fromEntries(
      me.workspaces.map((w: { id: string; hubOrigin: boolean }) => [w.id, w.hubOrigin])
    );
    expect(byId[projectedWorkspaceId]).toBe(true);
    expect(byId[operatorWorkspaceId]).toBe(false);
    // The raw hub org id never crosses the wire.
    expect(JSON.stringify(me)).not.toContain(ORG_A);
  });

  it('local workspace, same session: hubOrigin false, origin local, hubManageUrl null', async () => {
    const res = await app.app.request('/api/v1/me', {
      headers: { cookie: hubAdminCookie, 'x-workspace-id': operatorWorkspaceId }
    });
    const me = await readJson(res);
    expect(me.workspace.hubOrigin).toBe(false);
    expect(me.origin).toBe('local');
    expect(me.hubManageUrl).toBeNull();
  });

  it('the API key pinned to the projected workspace reports the same signals (via api_key)', async () => {
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${projectedKey}` }
    });
    expect(res.status).toBe(200);
    const me = await readJson(res);
    expect(me.via).toBe('api_key');
    expect(me.workspace.hubOrigin).toBe(true);
    expect(me.origin).toBe('hub');
    expect(me.hubManageUrl).toBe(hub.issuer);
    // The ACTIVE workspace is the pin; /me enumerates ALL the holder's
    // memberships (user-scoped model — the pin restricts reach, not what
    // the holder may see about themselves), each with its own flag.
    expect(me.activeWorkspaceId).toBe(projectedWorkspaceId);
    const flags = Object.fromEntries(
      me.workspaces.map((w: { id: string; hubOrigin: boolean }) => [w.id, w.hubOrigin])
    );
    expect(flags[projectedWorkspaceId]).toBe(true);
  });
});

describe('machine credentials: the fail-closed scope map is the first wall', () => {
  it('every /members + /invitations shape 403s endpoint_not_allowed for a key — reads included', async () => {
    const key = { authorization: `Bearer ${projectedKey}` };
    for (const [path, init] of [
      ['/api/v1/members', { headers: { ...key, 'x-forwarded-for': nextIp() } }],
      [`/api/v1/members/${hubMemberRowId}`, { ...json({ role: 'admin' }, key), method: 'PATCH' }],
      [
        `/api/v1/members/${hubMemberRowId}`,
        { method: 'DELETE', headers: { ...key, 'x-forwarded-for': nextIp() } }
      ],
      ['/api/v1/invitations', { headers: { ...key, 'x-forwarded-for': nextIp() } }],
      ['/api/v1/invitations', json({ email: 'x@p7.test', role: 'member' }, key)]
    ] as const) {
      const res = await app.app.request(path, init as RequestInit);
      expect(res.status, `${path} should be scope-refused`).toBe(403);
      expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
    }
  });
});
