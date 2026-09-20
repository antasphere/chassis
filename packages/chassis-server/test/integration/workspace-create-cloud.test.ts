import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp, host } from './helpers.js';
import { FakeHub, LEGACY_GRANT_SCOPE, type HubUserFixture } from '@antasphere/chassis-server/testing';
import type { HubCreateOrgResult } from '@antasphere/chassis-server/identity';
import * as sso from './sso-helpers.js';

/**
 * POST /api/v1/workspaces on the CLOUD edition (PRDCT-2443): the
 * organization is created AT THE HUB as the caller — their own grant, no
 * service key, nothing naming a user — and projected locally before the
 * answer, which carries the LOCAL workspace id.
 *
 * Two apps over one FakeHub:
 *  - `app` runs the REAL client against the fake hub's POST /api/v1/orgs
 *    (the wire: bearer, body, no blind retry, the projection);
 *  - `scripted` fakes the hub call AT THE FUNCTION BOUNDARY the route
 *    depends on (`BootOverrides.hubCreateOrg`), so every verdict maps to its
 *    code without needing a hub that can produce it.
 */

const OPERATOR = { email: 'operator@wscloud.test', name: 'Op Cloud', password: 'op-cloud-password-1234' };
const ORG_HOME = '66666666-aaaa-4bbb-8ccc-000000000001';
const ORG_ZERO = '66666666-aaaa-4bbb-8ccc-000000000002';
const ORG_SCRIPTED = '66666666-aaaa-4bbb-8ccc-000000000003';

const DIALS = {
  reconcileTtlMs: 120,
  reconcileStaleMaxMs: 60_000,
  retryMs: 50,
  orgsTimeoutMs: 1_000,
  tokenTimeoutMs: 2_000
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expireTtl = () => sleep(DIALS.reconcileTtlMs + 60);

const CLOUD_ENV = (hub: FakeHub) => ({
  EDITION: 'cloud',
  HUB_ISSUER_URL: hub.issuer,
  HUB_CLIENT_ID: host.hubClientId,
  HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
});

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let scripted: TestApp;
let nextScripted: HubCreateOrgResult = { kind: 'inconclusive' };
const scriptedCalls: Array<{ userId: string; name: string }> = [];

const ada: HubUserFixture = {
  sub: 'hub-ada',
  email: 'ada@wscloud.test',
  name: 'Ada Cloud',
  workspaceId: ORG_HOME,
  role: 'member', // a plain member of her home org — creation is not an admin act
  workspaceName: 'Home Org'
};

const create = (target: TestApp, cookie: string, name: string, headers: Record<string, string> = {}) =>
  target.app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: JSON.stringify({ name })
  });

const me = async (target: TestApp, cookie: string) =>
  readJson(await target.app.request('/api/v1/me', { headers: { cookie } }));

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(await createDatabase(container, 'ws_create_cloud'), CLOUD_ENV(hub), {
    hubDials: DIALS
  });
  scripted = await createTestApp(
    await createDatabase(container, 'ws_create_cloud_scripted'),
    CLOUD_ENV(hub),
    {
      hubDials: DIALS,
      hubCreateOrg: async (userId, name) => {
        scriptedCalls.push({ userId, name });
        return nextScripted;
      }
    }
  );
  for (const target of [app, scripted]) {
    const res = await target.app.request(
      '/api/v1/setup',
      sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'Cloud', owner: OPERATOR })
    );
    expect(res.status).toBe(201);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([app?.stop(), scripted?.stop()]);
  await Promise.all([container?.stop(), hub?.stop()]);
});

beforeEach(() => {
  hub.orgCreateMode = 'ok';
  hub.orgsMode = 'ok';
  hub.orgCreateRequests.length = 0;
});

describe('cloud: the real client against the hub', () => {
  let cookie = '';

  it('creates the organization AT THE HUB as the user, projects it, answers the LOCAL id', async () => {
    cookie = await sso.ssoLogin(app, hub, ada);
    expect((await me(app, cookie)).canCreateWorkspace).toBe(true);

    const res = await create(app, cookie, '  Ada’s lab ');
    expect(res.status).toBe(201);
    const { workspace } = await readJson(res);
    expect(workspace.name).toBe('Ada’s lab');

    // The hub call: ONE POST, the user's own bearer, the name and nothing else.
    expect(hub.orgCreateRequests).toHaveLength(1);
    const sent = hub.orgCreateRequests[0]!;
    expect(sent.auth).toMatch(/^Bearer ey/); // a user access token (JWT), never a service key
    expect(sent.body).toEqual({ name: 'Ada’s lab' });
    const hubOrgId = hub.orgIdsOf('hub-ada').find((id) => id !== ORG_HOME)!;
    expect(hubOrgId).toBeTruthy();

    // The answer is the LOCAL id — never the hub org id.
    expect(workspace.id).not.toBe(hubOrgId);
    const ws = await app.db.pool.query(`SELECT central_account_id, name FROM workspaces WHERE id = $1`, [
      workspace.id
    ]);
    expect(ws.rows[0]).toEqual({ central_account_id: hubOrgId, name: 'Ada’s lab' });
    const members = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE workspace_id = $1`,
      [workspace.id]
    );
    expect(members.rows).toEqual([{ role: 'owner', origin: 'hub', is_active: true }]);

    // Usable at once: the header selects it, hub-origin, owner.
    const selected = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie, 'x-workspace-id': workspace.id } })
    );
    expect(selected.activeWorkspaceId).toBe(workspace.id);
    expect(selected.role).toBe('owner');
    expect(selected.workspace.hubOrigin).toBe(true);

    // Audited in the NEW workspace; the home org's trail hears nothing.
    const audit = await app.db.pool.query(
      `SELECT workspace_id, action, actor_via FROM audit_log WHERE action ILIKE '%workspace%'`
    );
    expect(audit.rows).toEqual([
      { workspace_id: workspace.id, action: 'workspace.create', actor_via: 'session' }
    ]);
  });

  it('the grant that created it CARRIED orgs:create — because the sign-in asked for it', async () => {
    const { scope } = await sso.ssoInitiate(app);
    expect(scope?.split(' ')).toContain('orgs:create');
    expect(scope?.split(' ')).not.toContain('account:write');
  });

  it.each([
    ['a grant from before the scope existed (account:read only)', LEGACY_GRANT_SCOPE],
    ['a grant with account:write but NOT orgs:create', `${LEGACY_GRANT_SCOPE} account:write`]
  ])('%s answers 401 hub_reauth_required; /me stays true; a fresh sign-in heals it', async (label, scope) => {
    const sub = `hub-old-${scope.length}`;
    const old: HubUserFixture = {
      ...ada,
      sub,
      email: `${sub}@wscloud.test`,
      name: 'Old Grant',
      overrides: { scope }
    };
    const oldCookie = await sso.ssoLogin(app, hub, old);
    // The entry is OFFERED: the creation is one sign-in away, and false
    // would hide it from every person who signed in before this shipped.
    expect((await me(app, oldCookie)).canCreateWorkspace).toBe(true);

    const refreshes = hub.refreshCount();
    const before = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    const res = await create(app, oldCookie, 'Too early');
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('hub_reauth_required'); // NOT hub_refused, NOT hub_grant_expired
    expect(body.error.message).not.toMatch(/organi[sz]ation|hub|antasphere/i);
    // One POST, no refresh (a refreshed token carries the same scopes), nothing created anywhere.
    expect(hub.orgCreateRequests).toHaveLength(1);
    expect(hub.refreshCount()).toBe(refreshes);
    expect(hub.orgIdsOf(sub)).toEqual([ORG_HOME]);
    const after = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // The grant is NOT dead: the rest of the product keeps working on it.
    expect((await app.app.request(host.probeRoute, { headers: { cookie: oldCookie } })).status).toBe(200);

    // The cure: sign in again — the fresh grant carries what the tool now asks for.
    const fresh = await sso.ssoLogin(app, hub, { ...old, overrides: undefined });
    const healed = await create(app, fresh, 'Now it works');
    expect(healed.status).toBe(201);
  });

  it('a CLI connect REPLACES the stored grant with the hub’s own (no orgs:create): reauth, then healed', async () => {
    const kit: HubUserFixture = { ...ada, sub: 'hub-kit', email: 'kit@wscloud.test', name: 'Kit CLI' };
    const kitCookie = await sso.ssoLogin(app, hub, kit);
    const { token, hubRefreshToken } = await hub.signConnectToken(kit, 'http://localhost:3000/mcp');
    const connect = await app.app.request('/api/v1/sso/cli-connect', sso.json({ token, hubRefreshToken }));
    expect(connect.status).toBeLessThan(300);
    await app.db.pool.query(
      `UPDATE account SET access_token_expires_at = now() - interval '1 hour'
        WHERE provider_id = 'antasphere' AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [kit.email]
    );
    const res = await create(app, kitCookie, 'After the CLI');
    expect(res.status).toBe(401);
    expect((await readJson(res)).error.code).toBe('hub_reauth_required');
    const again = await sso.ssoLogin(app, hub, kit);
    expect((await create(app, again, 'After the browser')).status).toBe(201);
  });

  it('the hub cap answers 403 workspace_limit_reached and projects nothing', async () => {
    hub.orgCreateMode = 'limit';
    const before = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    const res = await create(app, cookie, 'One too many');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('workspace_limit_reached');
    expect(hub.orgCreateRequests).toHaveLength(1);
    const after = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a hub that does not open creation to grants answers 403 hub_refused — one POST, no refresh storm', async () => {
    hub.orgCreateMode = 'forbidden';
    const refreshes = hub.refreshCount();
    const res = await create(app, cookie, 'Refused');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('hub_refused');
    expect(hub.orgCreateRequests).toHaveLength(1);
    expect(hub.refreshCount()).toBe(refreshes);
  });

  it('a hub 5xx or a dropped connection answers 403 hub_unavailable and is NEVER re-posted', async () => {
    for (const mode of ['http500', 'network'] as const) {
      hub.orgCreateMode = mode;
      hub.orgCreateRequests.length = 0;
      const res = await create(app, cookie, `Down ${mode}`);
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('hub_unavailable');
      expect(hub.orgCreateRequests).toHaveLength(1);
    }
  });

  it('an organization the hub COMMITTED before failing is not duplicated — the next pass projects it', async () => {
    hub.orgCreateMode = 'commit_then_500';
    const res = await create(app, cookie, 'Committed anyway');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('hub_unavailable');
    expect(hub.orgCreateRequests).toHaveLength(1);
    await expireTtl();
    const names = ((await me(app, cookie)).workspaces as Array<{ name: string }>).map((w) => w.name);
    expect(names.filter((n) => n === 'Committed anyway')).toHaveLength(1);
  });

  it('machine credentials are refused on cloud too (fail-closed allowlist)', async () => {
    const minted = await readJson(
      await app.app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'k', scopes: [host.scopes.read, host.scopes.write] })
      })
    );
    const res = await create(app, '', 'By key', { authorization: `Bearer ${minted.key}` });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
    expect(hub.orgCreateRequests).toHaveLength(0);
  });

  it('an EXPIRED grant answers the existing verdict, 401 hub_grant_expired — nothing reaches the hub', async () => {
    const bea: HubUserFixture = { ...ada, sub: 'hub-bea', email: 'bea@wscloud.test', name: 'Bea' };
    const beaCookie = await sso.ssoLogin(app, hub, bea);
    hub.revokeGrants('hub-bea');
    // Age the stored access token so the next grant read must refresh — and
    // the refresh discovers the dead family (invalid_grant).
    await app.db.pool.query(
      `UPDATE account SET access_token_expires_at = now() - interval '1 hour'
        WHERE provider_id = 'antasphere' AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [bea.email]
    );
    await expireTtl();
    const res = await create(app, beaCookie, 'Too late');
    // Whichever door answers first (the live gate's reconcile, or the route's
    // own grant read), the verdict is the one existing verdict.
    expect(res.status).toBe(401);
    expect((await readJson(res)).error.code).toBe('hub_grant_expired');
    expect(hub.orgIdsOf('hub-bea')).toEqual([ORG_HOME]);
  });

  it('a break-glass operator with no hub link is told so: 403 hub_link_required, /me false', async () => {
    await sso.seedLocalWorkspace(app, 'Operator local', OPERATOR.email);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      sso.json({ email: OPERATOR.email, password: OPERATOR.password })
    );
    expect(signIn.status).toBe(200);
    const { extractCookie } = await import('./helpers.js');
    const opCookie = extractCookie(signIn);
    expect((await me(app, opCookie)).canCreateWorkspace).toBe(false);
    const res = await create(app, opCookie, 'Local on cloud');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('hub_link_required');
    expect(hub.orgCreateRequests).toHaveLength(0);
  });

  it('the ZERO-membership session creates its next organization from the zero state', async () => {
    const zed: HubUserFixture = {
      sub: 'hub-zed',
      email: 'zed@wscloud.test',
      name: 'Zed',
      workspaceId: ORG_ZERO,
      role: 'owner',
      workspaceName: 'Zed Org'
    };
    const zedCookie = await sso.ssoLogin(app, hub, zed);
    hub.clearUserOrgs('hub-zed');
    await expireTtl();
    await app.app.request(host.probeRoute, { headers: { cookie: zedCookie } }); // the sweeping request
    const zero = await me(app, zedCookie);
    expect(zero.workspaces).toEqual([]);
    expect(zero.canCreateWorkspace).toBe(true);

    // Naming a workspace while holding none keeps the fail-closed 401.
    const named = await create(app, zedCookie, 'Named', { 'x-workspace-id': ORG_ZERO });
    expect(named.status).toBe(401);

    const res = await create(app, zedCookie, 'Zed again');
    expect(res.status).toBe(201);
    const after = await me(app, zedCookie);
    expect(after.workspaces.map((w: { name: string }) => w.name)).toEqual(['Zed again']);
    expect(after.role).toBe('owner');
  });
});

describe('cloud: the hub call faked at the function boundary', () => {
  let cookie = '';
  let userId = '';
  const cy: HubUserFixture = {
    sub: 'hub-cy',
    email: 'cy@wscloud.test',
    name: 'Cy Scripted',
    workspaceId: ORG_HOME,
    role: 'admin',
    workspaceName: 'Home Org'
  };

  beforeAll(async () => {
    cookie = await sso.ssoLogin(scripted, hub, cy);
    userId = (await me(scripted, cookie)).user.id;
  });

  beforeEach(() => {
    scriptedCalls.length = 0;
  });

  it('calls it with the CALLER and the trimmed name — there is no other parameter', async () => {
    nextScripted = { kind: 'limit_reached' };
    await create(scripted, cookie, '  Trim me  ');
    expect(scriptedCalls).toEqual([{ userId, name: 'Trim me' }]);
  });

  it('HOSTILE input cannot steer it: headers and body fields naming another user or another name are ignored', async () => {
    const victim = await scripted.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [OPERATOR.email]);
    const victimId = victim.rows[0].id as string;
    expect(victimId).not.toBe(userId);
    nextScripted = { kind: 'limit_reached' };
    const res = await scripted.app.request('/api/v1/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-target-user': victimId,
        'x-target-name': 'Steered by header',
        'x-user-id': victimId,
        'x-owner-id': victimId
      },
      body: JSON.stringify({
        name: '  Mine  ',
        ownerId: victimId,
        userId: victimId,
        owner: victimId,
        ownerUserId: victimId,
        targetUser: victimId,
        org: { name: 'Steered by body', ownerId: victimId }
      })
    });
    expect(res.status).toBe(403); // the scripted cap: the call was made
    // The call's arguments: the SESSION's user and the validated, trimmed name. Nothing else exists.
    expect(scriptedCalls).toEqual([{ userId, name: 'Mine' }]);
    expect(JSON.stringify(scriptedCalls)).not.toContain(victimId);
    expect(JSON.stringify(scriptedCalls)).not.toContain('Steered');
  });

  it.each([
    [{ kind: 'limit_reached' }, 403, 'workspace_limit_reached'],
    [{ kind: 'reauth_required' }, 401, 'hub_reauth_required'],
    [{ kind: 'refused', status: 403, code: 'forbidden' }, 403, 'hub_refused'],
    [{ kind: 'refused', status: 409, code: 'whatever' }, 403, 'hub_refused'],
    [{ kind: 'invalid' }, 400, 'validation_error'],
    [{ kind: 'inconclusive' }, 403, 'hub_unavailable'],
    [{ kind: 'grant_dead' }, 401, 'hub_grant_expired'],
    [{ kind: 'no_link' }, 403, 'hub_link_required']
  ] as Array<[HubCreateOrgResult, number, string]>)(
    '%j → %i %s, nothing projected',
    async (result, status, code) => {
      nextScripted = result;
      const before = await scripted.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
      const res = await create(scripted, cookie, 'Scripted');
      expect(res.status).toBe(status);
      expect((await readJson(res)).error.code).toBe(code);
      const after = await scripted.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      const audit = await scripted.db.pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.create'`
      );
      expect(audit.rows[0].n).toBe(0);
    }
  );

  it('201: the forced reconcile projects the org the hub now lists; the answer is the local id', async () => {
    hub.setUserOrg('hub-cy', ORG_SCRIPTED, { name: 'Scripted Org', role: 'owner' });
    nextScripted = { kind: 'created', org: { id: ORG_SCRIPTED, name: 'Scripted Org', role: 'owner' } };
    const res = await create(scripted, cookie, 'Scripted Org');
    expect(res.status).toBe(201);
    const { workspace } = await readJson(res);
    const row = await scripted.db.pool.query(
      `SELECT w.central_account_id, m.role, m.origin FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = $1`,
      [workspace.id]
    );
    expect(row.rows).toEqual([{ central_account_id: ORG_SCRIPTED, role: 'owner', origin: 'hub' }]);
  });

  it('201 even when the pass right after the creation blips: projected from the hub’s own 201, as hub-origin', async () => {
    const orgId = '66666666-aaaa-4bbb-8ccc-000000000004';
    hub.setUserOrg('hub-cy', orgId, { name: 'Blip Org', role: 'owner' });
    hub.orgsMode = 'http500';
    nextScripted = { kind: 'created', org: { id: orgId, name: 'Blip Org', role: 'owner' } };
    const res = await create(scripted, cookie, 'Blip Org');
    expect(res.status).toBe(201);
    const { workspace } = await readJson(res);
    const row = await scripted.db.pool.query(
      `SELECT w.central_account_id, w.name, m.role, m.origin, m.is_active FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = $1`,
      [workspace.id]
    );
    expect(row.rows).toEqual([
      { central_account_id: orgId, name: 'Blip Org', role: 'owner', origin: 'hub', is_active: true }
    ]);
    // The hub recovers: the next pass KEEPS it (the hub lists it) — the
    // fallback wrote nothing the reconcile would not have.
    hub.orgsMode = 'ok';
    await expireTtl();
    const names = ((await me(scripted, cookie)).workspaces as Array<{ name: string }>).map((w) => w.name);
    expect(names).toContain('Blip Org');
  });

  it('a 201 the hub does NOT back is swept by the next pass — the 201 is never a standing grant', async () => {
    const ghost = '66666666-aaaa-4bbb-8ccc-000000000005';
    hub.orgsMode = 'http500';
    nextScripted = { kind: 'created', org: { id: ghost, name: 'Ghost', role: 'owner' } };
    expect((await create(scripted, cookie, 'Ghost')).status).toBe(201);
    hub.orgsMode = 'ok'; // the hub's list never carried it
    await expireTtl();
    const names = ((await me(scripted, cookie)).workspaces as Array<{ name: string }>).map((w) => w.name);
    expect(names).not.toContain('Ghost');
  });

  it('a 201 without a usable role is not projected by the fallback: 403 hub_unavailable', async () => {
    hub.orgsMode = 'http500';
    nextScripted = {
      kind: 'created',
      org: { id: '66666666-aaaa-4bbb-8ccc-000000000006', name: 'Roleless', role: null }
    };
    const res = await create(scripted, cookie, 'Roleless');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('hub_unavailable');
  });
});
