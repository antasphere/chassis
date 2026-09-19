import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host as chassisHost
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';

/**
 * The live principal gate (identity/hub-live-gate.ts) — the enforcement
 * face of the user-scoped federation, replacing the retired master-key P4
 * gates. Every verdict is judged on state reconciled AS THE USER via their
 * OWN grant:
 *
 *  - hub-side removal → 401 `membership_revoked` on the very request whose
 *    pass swept the row; all three credential kinds lock out;
 *  - `hub_status='suspended'` → 403 `account_suspended` for sessions, API
 *    keys, AND OAuth bearers — EXCEPT `GET /me` (visible-but-blocked);
 *  - hub outage: local state serves inside the stale window, then 403
 *    `hub_unavailable`, then recovery;
 *  - grant dead (revoked at the hub) → 401 `hub_grant_expired` immediately
 *    (no stale grace); a browser re-login heals it;
 *  - a hub role delta applies to THE request that reconciled it (D11);
 *  - the ACCEPTED BOUND: a guest in a hub-suspended org keeps deck access
 *    until a MEMBER's reconcile materializes the suspension locally — and
 *    is then blocked by the local column, never by a borrowed grant.
 */

const OWNER = { email: 'owner@gate.test', name: 'Op Gate', password: 'op-gate-password-123' };

const ORG_REMOVE = '55555555-aaaa-4bbb-8ccc-000000000001';
const ORG_SUSPEND = '55555555-aaaa-4bbb-8ccc-000000000002';
const ORG_OUTAGE = '55555555-aaaa-4bbb-8ccc-000000000003';
const ORG_DEAD = '55555555-aaaa-4bbb-8ccc-000000000004';
const ORG_ROLE = '55555555-aaaa-4bbb-8ccc-000000000005';

const DIALS = {
  reconcileTtlMs: 120,
  // Wide enough that "inside the stale window" can never flake under
  // parallel-suite container load, small enough that the fail-closed leg
  // costs the outage test ~2.5 s.
  reconcileStaleMaxMs: 2_500,
  retryMs: 100,
  orgsTimeoutMs: 400,
  tokenTimeoutMs: 2_000
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expireTtl = () => sleep(DIALS.reconcileTtlMs + 40);

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
  app = await createTestApp(
    await createDatabase(container, 'hub_live_gate'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
    },
    { hubDials: DIALS }
  );
  const res = await app.app.request(
    '/api/v1/setup',
    sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'Gate', owner: OWNER })
  );
  expect(res.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

const me = async (cookie: string, workspaceId?: string) =>
  app.app.request('/api/v1/me', {
    headers: { cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }
  });

async function mintApiKey(cookie: string): Promise<string> {
  const create = await app.app.request('/api/v1/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'gate key', scopes: [chassisHost.scopes.read, chassisHost.scopes.write] })
  });
  expect(create.status).toBe(201);
  return (await readJson(create)).key;
}

describe('hub-side removal → membership_revoked, all three credential kinds', () => {
  const max: HubUserFixture = {
    sub: 'hub-max',
    email: 'max@remove.test',
    name: 'Max Removed',
    workspaceId: ORG_REMOVE,
    role: 'owner',
    workspaceName: 'Remove Org'
  };

  it('locks out sessions, API keys, AND OAuth bearers; the row deactivates with ONE audit row', async () => {
    const cookie = await sso.ssoLogin(app, hub, max);
    const key = await mintApiKey(cookie);
    const bearer = await sso.oauthBearer(app, cookie);

    // All three credential paths live.
    expect((await me(cookie)).status).toBe(200);
    const keyReq = () =>
      app.app.request(chassisHost.probeRoute, { headers: { authorization: `Bearer ${key}` } });
    const bearerReq = () =>
      app.app.request(chassisHost.probeRoute, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await keyReq()).status).toBe(200);
    expect((await bearerReq()).status).toBe(200);

    // Removed on the hub: the next pass sweeps the row, and the REQUEST
    // that ran the pass carries the gate's own verdict.
    hub.removeUserOrg('hub-max', ORG_REMOVE);
    await expireTtl();
    const denied = await me(cookie);
    expect(denied.status).toBe(401);
    expect((await readJson(denied)).error.code).toBe('membership_revoked');

    // Instant lockout of the ORG everywhere: the live-membership re-check
    // now fails at RESOLUTION. Max was removed from his SOLE org, so a
    // selector-less session /me is the zero-membership zero state (200,
    // empty list — the no-organization shell), while NAMING the swept
    // workspace, and every machine credential, still fail closed (401).
    const zero = await me(cookie);
    expect(zero.status).toBe(200);
    expect((await readJson(zero)).workspaces).toEqual([]);
    const wsRemove = (
      await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [ORG_REMOVE])
    ).rows[0].id as string;
    expect((await me(cookie, wsRemove)).status).toBe(401);
    expect((await keyReq()).status).toBe(401);
    expect((await bearerReq()).status).toBe(401);

    // DB truth: deactivated, still origin='hub'; audited once, as system.
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active, m.origin FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_REMOVE]
    );
    expect(rows).toEqual([{ is_active: false, origin: 'hub' }]);
    const { rows: audit } = await app.db.pool.query(
      `SELECT actor_via FROM audit_log WHERE action = 'member.deactivate'
       AND metadata->>'reason' = 'hub_reconcile'`
    );
    expect(audit).toEqual([{ actor_via: 'system' }]);

    // Re-granted at the hub → the next login restores everything.
    hub.setUserOrg('hub-max', ORG_REMOVE, { name: 'Remove Org', role: 'owner' });
    const again = await sso.ssoLogin(app, hub, max);
    expect((await me(again)).status).toBe(200);
  });
});

describe('suspension: visible but blocked (GET /me exempt)', () => {
  const sam: HubUserFixture = {
    sub: 'hub-sam',
    email: 'sam@suspend.test',
    name: 'Sam Suspended',
    workspaceId: ORG_SUSPEND,
    role: 'owner',
    workspaceName: 'Suspend Org'
  };
  let cookie: string;
  let key: string;

  beforeAll(async () => {
    cookie = await sso.ssoLogin(app, hub, sam);
    key = await mintApiKey(cookie);
  });

  it('suspension blocks every surface except GET /me — for sessions AND machine credentials', async () => {
    expect((await me(cookie)).status).toBe(200);
    hub.setUserOrg('hub-sam', ORG_SUSPEND, { name: 'Suspend Org', role: 'owner', status: 'suspended' });
    await expireTtl();

    // Blocked with the reason…
    const denied = await app.app.request(chassisHost.probeRoute, { headers: { cookie } });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('account_suspended');
    const viaKey = await app.app.request(chassisHost.probeRoute, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(viaKey.status).toBe(403);
    expect((await readJson(viaKey)).error.code).toBe('account_suspended');

    // …but /me stays alive and SHOWS the suspension (the dashboard's badge
    // instead of a stranded shell) — for the key too.
    const meRes = await me(cookie);
    expect(meRes.status).toBe(200);
    const body = await readJson(meRes);
    const suspended = body.workspaces.find((w: { name: string }) => w.name === 'Suspend Org');
    expect(suspended.suspended).toBe(true);
    const keyMe = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
    expect(keyMe.status).toBe(200);

    // The column is locally materialized truth.
    const { rows } = await app.db.pool.query(
      `SELECT hub_status FROM workspaces WHERE central_account_id = $1`,
      [ORG_SUSPEND]
    );
    expect(rows).toEqual([{ hub_status: 'suspended' }]);
  });

  it('unsuspension restores access within the window', async () => {
    hub.setUserOrg('hub-sam', ORG_SUSPEND, { name: 'Suspend Org', role: 'owner', status: 'active' });
    await expireTtl();
    const restored = await app.app.request(chassisHost.probeRoute, { headers: { cookie } });
    expect(restored.status).toBe(200);
  });
});

describe('hub outage: stale-served inside the window, then hub_unavailable, then recovery', () => {
  const eva: HubUserFixture = {
    sub: 'hub-eva',
    email: 'eva@outage.test',
    name: 'Eva Outage',
    workspaceId: ORG_OUTAGE,
    role: 'member',
    workspaceName: 'Outage Org'
  };

  it('serves local state within the stale window, fails closed after it, recovers', async () => {
    const cookie = await sso.ssoLogin(app, hub, eva);
    expect((await me(cookie)).status).toBe(200); // definitive pass cached
    hub.orgsMode = 'network';
    try {
      // Inside the stale window: local rows keep serving.
      await expireTtl();
      expect((await me(cookie)).status).toBe(200);
      // Beyond it: fail closed with its own reason code.
      await sleep(DIALS.reconcileStaleMaxMs + 100);
      const closed = await me(cookie);
      expect(closed.status).toBe(403);
      expect((await readJson(closed)).error.code).toBe('hub_unavailable');
    } finally {
      hub.orgsMode = 'ok';
    }
    // Recovery: the next probe (past the retry throttle) reconciles again.
    await sleep(DIALS.retryMs + 40);
    expect((await me(cookie)).status).toBe(200);

    // The membership survived the whole outage: errors never deactivate.
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_OUTAGE]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });
});

describe('grant death: 401 hub_grant_expired immediately, healed by a browser re-login', () => {
  const dora: HubUserFixture = {
    sub: 'hub-dora',
    email: 'dora@dead.test',
    name: 'Dora Dead',
    workspaceId: ORG_DEAD,
    role: 'owner',
    workspaceName: 'Dead Org'
  };

  it('a hub-side grant revocation cuts the user on the next pass — no stale grace', async () => {
    const cookie = await sso.ssoLogin(app, hub, dora);
    const key = await mintApiKey(cookie);
    expect((await me(cookie)).status).toBe(200);

    // The hub revokes this tool's access for dora: her access tokens stop
    // working and her refresh family is dead.
    hub.revokeGrants('hub-dora');
    await expireTtl();
    const denied = await me(cookie);
    expect(denied.status).toBe(401);
    expect((await readJson(denied)).error.code).toBe('hub_grant_expired');
    // Machine credentials answer the same — a key must not outlive the grant.
    const viaKey = await app.app.request(chassisHost.probeRoute, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(viaKey.status).toBe(401);
    expect((await readJson(viaKey)).error.code).toBe('hub_grant_expired');

    // The row was NOT swept (org truth was never read) — the grant is what
    // died. The dead marker is on the account row.
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_DEAD]
    );
    expect(rows).toEqual([{ is_active: true }]);
    const { rows: grant } = await app.db.pool.query(
      `SELECT a.refresh_token FROM account a JOIN "user" u ON u.id = a.user_id
       WHERE u.email = $1 AND a.provider_id = 'antasphere'`,
      [dora.email]
    );
    expect(grant).toEqual([{ refresh_token: null }]);

    // One browser SSO re-login re-seeds the grant; everything works again
    // (the fresh force pass overwrites the cached dead verdict).
    const again = await sso.ssoLogin(app, hub, dora);
    expect((await me(again)).status).toBe(200);
    expect(
      (await app.app.request(chassisHost.probeRoute, { headers: { authorization: `Bearer ${key}` } })).status
    ).toBe(200);
  });
});

describe('role deltas apply to the request that reconciled them (D11)', () => {
  const rita: HubUserFixture = {
    sub: 'hub-rita',
    email: 'rita@role.test',
    name: 'Rita Role',
    workspaceId: ORG_ROLE,
    role: 'admin',
    workspaceName: 'Role Org'
  };

  it('a demotion closes the admin surface on the next pass; a promotion reopens it', async () => {
    const cookie = await sso.ssoLogin(app, hub, rita);
    expect((await app.app.request('/api/v1/audit', { headers: { cookie } })).status).toBe(200);

    hub.setUserOrg('hub-rita', ORG_ROLE, { name: 'Role Org', role: 'member' });
    await expireTtl();
    const demoted = await app.app.request('/api/v1/audit', { headers: { cookie } });
    expect(demoted.status).toBe(403); // the delta bit on THIS request
    expect((await readJson(await me(cookie))).role).toBe('member');
    const { rows } = await app.db.pool.query(
      `SELECT m.role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_ROLE]
    );
    expect(rows).toEqual([{ role: 'member' }]);

    hub.setUserOrg('hub-rita', ORG_ROLE, { name: 'Role Org', role: 'admin' });
    await expireTtl();
    expect((await app.app.request('/api/v1/audit', { headers: { cookie } })).status).toBe(200);
  });
});

describe('the ACCEPTED BOUND: guest suspension staleness (documented, deliberate)', () => {
  it('a guest is gated by the LOCALLY MATERIALIZED hub_status only — refreshed by a member, never a borrowed grant', async () => {
    // A member workspace + a guest row planted in it (the claim path's
    // shape, minimal fixture). The guest signs in via the break-glass-style
    // local door on oss… on cloud guests hold hub identities — model that:
    // the guest is a hub user whose OWN org list never includes this org.
    const host: HubUserFixture = {
      sub: 'hub-host',
      email: 'host@guestbound.test',
      workspaceId: '55555555-aaaa-4bbb-8ccc-000000000006',
      role: 'owner',
      workspaceName: 'Guest Host Org'
    };
    const guest: HubUserFixture = {
      sub: 'hub-guesty',
      email: 'guesty@guestbound.test',
      workspaceId: '55555555-aaaa-4bbb-8ccc-000000000007',
      role: 'owner',
      workspaceName: 'Guesty Personal'
    };
    const hostCookie = await sso.ssoLogin(app, hub, host);
    const guestCookie = await sso.ssoLogin(app, hub, guest);
    const { rows: hostWs } = await app.db.pool.query(
      `SELECT id FROM workspaces WHERE central_account_id = $1`,
      [host.workspaceId]
    );
    const hostWorkspaceId = hostWs[0].id as string;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, (SELECT id FROM "user" WHERE email = $2), 'member', 'guest', true)`,
      [hostWorkspaceId, guest.email]
    );
    // The guest reaches the host workspace (their grant's whole point).
    expect((await me(guestCookie, hostWorkspaceId)).status).toBe(200);

    // The org is suspended at the hub. The guest's OWN reconciles never
    // list this org, so the local hub_status stays stale — the guest KEEPS
    // access. This is the accepted bound (same class as ungated share-link
    // viewing): every cheap fix leaks or borrows credentials.
    hub.setUserOrg('hub-host', host.workspaceId, {
      name: 'Guest Host Org',
      role: 'owner',
      status: 'suspended'
    });
    await expireTtl();
    const preMaterialize = await app.app.request(chassisHost.probeRoute, {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(preMaterialize.status).toBe(200); // stale — accepted

    // A MEMBER touches Slideless: their pass materializes the suspension…
    await expireTtl();
    const memberBlocked = await app.app.request(chassisHost.probeRoute, {
      headers: { cookie: hostCookie }
    });
    expect(memberBlocked.status).toBe(403);
    expect((await readJson(memberBlocked)).error.code).toBe('account_suspended');

    // …and NOW the guest is blocked too, by the local column.
    const postMaterialize = await app.app.request(chassisHost.probeRoute, {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(postMaterialize.status).toBe(403);
    expect((await readJson(postMaterialize)).error.code).toBe('account_suspended');
    // The guest's /me stays alive (visible-but-blocked applies to them too).
    expect((await me(guestCookie, hostWorkspaceId)).status).toBe(200);
    // The guest row itself was never touched by any hub machinery.
    const { rows: guestRow } = await app.db.pool.query(
      `SELECT is_active, origin FROM workspace_members
       WHERE workspace_id = $1 AND user_id = (SELECT id FROM "user" WHERE email = $2)`,
      [hostWorkspaceId, guest.email]
    );
    expect(guestRow).toEqual([{ is_active: true, origin: 'guest' }]);
  });
});

describe('workspaces with no hub projection never touch the hub', () => {
  it('a cloud-LOCAL workspace costs zero hub calls', async () => {
    // Cloud setup mints no workspace (user-scoped federation), so seed a
    // cloud-LOCAL one for the operator — exactly the shape a break-glass
    // claim leaves. Its requests carry NO accountRef, so the live gate
    // short-circuits with zero hub surface.
    const localWs = await sso.seedLocalWorkspace(app, 'Operator Local', OWNER.email);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      sso.json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const before = hub.orgsRequests.length + hub.refreshRequests.length;
    for (let i = 0; i < 3; i += 1) {
      await sleep(DIALS.reconcileTtlMs + 20);
      expect((await me(cookie, localWs)).status).toBe(200);
    }
    expect(
      (
        await app.app.request(chassisHost.probeRoute, {
          headers: { cookie, 'x-workspace-id': localWs }
        })
      ).status
    ).toBe(200);
    expect(hub.orgsRequests.length + hub.refreshRequests.length).toBe(before);
  });
});
