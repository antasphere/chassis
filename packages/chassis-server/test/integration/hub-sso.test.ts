import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp, host } from './helpers.js';
import { FakeHub, type HubTokenOverrides, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { HUB_SSO_SCOPES } from '@antasphere/chassis-server/identity';
import * as sso from './sso-helpers.js';

/**
 * "Sign in with Antasphere" under the user-scoped federation model
 * (internal/federation.md), exercised against the FakeHub (real OIDC discovery
 * + JWKS + token endpoint with refresh rotation + a caller-scoped
 * /api/v1/orgs):
 *
 *  - identity comes from the ID TOKEN ONLY (aud = client id); the access
 *    token is HUB-audienced (`resource=<hub>/mcp` on the code exchange) and
 *    never claim-bearing — org truth is the login-time reconcile's read of
 *    the hub's caller-scoped org list AS THE USER;
 *  - the login reconcile is FAIL-CLOSED: a pass that cannot definitively
 *    read the org list revokes the just-minted session
 *    (sso_projection_failed) — a cloud login without its projection must
 *    not exist;
 *  - the offline grant (`offline_access account:read`) persists ENCRYPTED
 *    on the account row — the between-logins credential;
 *  - JIT provisioning, D9 operator trusted-link, D10 email sync, the
 *    identity-conflict guards, and the fail-closed id_token negative space
 *    all survive the reshape;
 *  - oss: zero SSO surface.
 */

const OWNER = { email: 'owner@sso.test', name: 'Op Erator', password: 'op-erator-password-123' };

const ORG_ACME = '11111111-aaaa-4bbb-8ccc-000000000001';
const ORG_BETA = '11111111-aaaa-4bbb-8ccc-000000000002';
const ORG_RACE = '11111111-aaaa-4bbb-8ccc-000000000003';
const ORG_LEFT = '11111111-aaaa-4bbb-8ccc-000000000004';
const ORG_RIGHT = '11111111-aaaa-4bbb-8ccc-000000000005';
const ORG_DARK = '11111111-aaaa-4bbb-8ccc-000000000006';
const ORG_WEIRD = '11111111-aaaa-4bbb-8ccc-000000000007';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
let hub: FakeHub;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
});

afterAll(async () => {
  await Promise.all([container?.stop(), hub?.stop()]);
});

function cloudEnv() {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
  };
}

// The dance itself lives in sso-helpers.ts; these wrappers bind this hub.
const ssoInitiate = (app: TestApp) => sso.ssoInitiate(app);
const ssoDance = (app: TestApp, fixture: HubUserFixture) => sso.ssoDance(app, hub, fixture);
const ssoLogin = (app: TestApp, fixture: HubUserFixture) => sso.ssoLogin(app, hub, fixture);
const expectFailedLogin = sso.expectFailedLogin;

describe('cloud edition: the SSO entrance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'hub_sso'), cloudEnv());
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'SSO', owner: OWNER })
    );
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  const u1: HubUserFixture = {
    sub: 'hub-u1',
    email: 'alice@acme.test',
    name: 'Alice Acme',
    workspaceId: ORG_ACME,
    role: 'member',
    workspaceName: 'Acme Corp'
  };

  it('first login JIT-provisions the user; the LOGIN RECONCILE projects the org from /orgs', async () => {
    const cookie = await ssoLogin(app, u1);

    // The session is real and lands in the projected workspace.
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe('alice@acme.test');
    const projected = me.workspaces.find((w: { name: string }) => w.name === 'Acme Corp');
    expect(projected).toBeTruthy();
    expect(me.activeWorkspaceId).toBe(projected.id);

    // Deck list serves from the projected workspace (empty but authorized).
    const decks = await app.app.request(host.probeRoute, { headers: { cookie } });
    expect(decks.status).toBe(200);

    // DB truth: verified user, projection stamped with the hub org id,
    // membership carries the hub role verbatim with origin='hub'.
    const { rows: users } = await app.db.pool.query(
      `SELECT id, email_verified FROM "user" WHERE email = 'alice@acme.test'`
    );
    expect(users).toHaveLength(1);
    expect(users[0].email_verified).toBe(true);
    const { rows: ws } = await app.db.pool.query(
      `SELECT id, name, hub_status FROM workspaces WHERE central_account_id = $1`,
      [ORG_ACME]
    );
    expect(ws).toHaveLength(1);
    expect(ws[0].name).toBe('Acme Corp');
    expect(ws[0].hub_status).toBe('active');
    const { rows: members } = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [ws[0].id, users[0].id]
    );
    expect(members).toEqual([{ role: 'member', origin: 'hub', is_active: true }]);

    // The login's org read hit the caller-scoped /orgs AS THE USER, with a
    // hub-audienced bearer — never a service key.
    expect(hub.orgsRequests.length).toBeGreaterThan(0);
    for (const req of hub.orgsRequests) {
      expect(req.auth).toMatch(/^Bearer /);
      expect(req.auth).not.toContain('ant_');
    }
  });

  it('the code exchange carries the HUB-audienced resource (the tokenResource seam) + the offline scopes', async () => {
    // RFC 8707 resource = <hub>/mcp — the flip from <own>/mcp: the callback
    // access token is a bearer for the HUB's /api/v1, not for ours.
    expect(hub.lastTokenRequest?.get('resource')).toBe(`${hub.issuer}/mcp`);
    // Confidential client: the secret rode the token request too.
    expect(hub.lastTokenRequest?.get('client_secret')).toBe('integration-test-hub-secret-0001');
    // The authorize leg requests the offline grant scopes.
    const init = json({ providerId: 'antasphere', callbackURL: '/' });
    const signIn = await app.app.request('/api/v1/auth/sign-in/oauth2', {
      ...init,
      headers: { ...init.headers, 'x-forwarded-for': sso.nextIp() }
    });
    const { url } = await readJson(signIn);
    const scope = new URL(url).searchParams.get('scope') ?? '';
    expect(scope).toContain('offline_access');
    expect(scope).toContain('account:read');
    // PRDCT-2443: the hub's dedicated scope for POST /orgs — and the list is
    // EXACTLY the stated one (a scope the hub does not know fails the whole
    // sign-in, so nothing rides along unannounced; account:write never does).
    expect(scope.split(' ').sort()).toEqual([...HUB_SSO_SCOPES].sort());
    expect(scope.split(' ')).toContain('orgs:create');
    expect(scope.split(' ')).not.toContain('account:write');
  });

  it('persists the offline grant ENCRYPTED on the account row (never plaintext at rest)', async () => {
    const { rows } = await app.db.pool.query(
      `SELECT a.access_token, a.refresh_token FROM account a JOIN "user" u ON u.id = a.user_id
       WHERE u.email = 'alice@acme.test' AND a.provider_id = 'antasphere'`
    );
    expect(rows).toHaveLength(1);
    const { access_token, refresh_token } = rows[0] as { access_token: string; refresh_token: string };
    expect(refresh_token).toBeTruthy();
    expect(access_token).toBeTruthy();
    // The fake mints raw refresh tokens as `rt_<uuid>`; what is stored must
    // be Better Auth's symmetric ciphertext (hex or $ba$ envelope), never
    // the raw secret.
    expect(refresh_token).not.toMatch(/^rt_/);
    expect(/^\$ba\$/.test(refresh_token) || /^[0-9a-f]+$/i.test(refresh_token)).toBe(true);
    expect(access_token.split('.').length).not.toBe(3); // not the raw JWT
  });

  it('second login re-syncs email (D10) and follows the hub org list (role + name) — no duplicate projection', async () => {
    const cookie = await ssoLogin(app, {
      ...u1,
      email: 'alice.renamed@acme.test',
      role: 'admin',
      workspaceName: 'Acme Corp GmbH'
    });
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe('alice.renamed@acme.test');

    const { rows: ws } = await app.db.pool.query(
      `SELECT id, name FROM workspaces WHERE central_account_id = $1`,
      [ORG_ACME]
    );
    expect(ws).toHaveLength(1); // the unique partial index held — same row, renamed
    expect(ws[0].name).toBe('Acme Corp GmbH');
    const { rows: members } = await app.db.pool.query(
      `SELECT m.role, m.origin, m.is_active FROM workspace_members m
       JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2`,
      [ws[0].id, 'alice.renamed@acme.test']
    );
    expect(members).toEqual([{ role: 'admin', origin: 'hub', is_active: true }]);
    // The old address is gone — one user, synced in place.
    const { rows: old } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = 'alice@acme.test'`);
    expect(old).toHaveLength(0);
  });

  it('reactivates a deactivated hub membership at the next login', async () => {
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false
       WHERE workspace_id = (SELECT id FROM workspaces WHERE central_account_id = $1)`,
      [ORG_ACME]
    );
    await ssoLogin(app, { ...u1, email: 'alice.renamed@acme.test', role: 'admin' });
    const { rows } = await app.db.pool.query(
      `SELECT is_active FROM workspace_members
       WHERE workspace_id = (SELECT id FROM workspaces WHERE central_account_id = $1)`,
      [ORG_ACME]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });

  it('projects under a placeholder when the hub omits the org name, and self-heals later', async () => {
    const u2: HubUserFixture = {
      sub: 'hub-u2',
      email: 'bob@beta.test',
      workspaceId: ORG_BETA,
      role: 'owner',
      workspaceName: null // hub without a name on the entry
    };
    await ssoLogin(app, u2);
    const { rows: before } = await app.db.pool.query(
      `SELECT name FROM workspaces WHERE central_account_id = $1`,
      [ORG_BETA]
    );
    expect(before[0].name).toBe(`Antasphere workspace ${ORG_BETA.slice(0, 8)}`);

    // The name appears at a later login — the projection follows.
    await ssoLogin(app, { ...u2, workspaceName: 'Beta LLC' });
    const { rows: after } = await app.db.pool.query(
      `SELECT name FROM workspaces WHERE central_account_id = $1`,
      [ORG_BETA]
    );
    expect(after[0].name).toBe('Beta LLC');
  });

  it('materializes the hub-level default org on the membership rows (is_default)', async () => {
    // Give alice a second org and mark ACME as her hub default.
    hub.setUserOrg('hub-u1', ORG_BETA, { name: 'Beta LLC', role: 'member' });
    hub.setUserOrg('hub-u1', ORG_ACME, { name: 'Acme Corp GmbH', role: 'admin', isDefault: true });
    const cookie = await ssoLogin(app, {
      ...u1,
      email: 'alice.renamed@acme.test',
      role: 'admin',
      workspaceName: 'Acme Corp GmbH'
    });
    const { rows } = await app.db.pool.query(
      `SELECT w.central_account_id, m.is_default FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN "user" u ON u.id = m.user_id
       WHERE u.email = 'alice.renamed@acme.test' ORDER BY w.central_account_id`
    );
    expect(rows).toEqual([
      { central_account_id: ORG_ACME, is_default: true },
      { central_account_id: ORG_BETA, is_default: false }
    ]);
    // Selector-less requests land on the default — and /me marks it
    // explicitly (clients read the flag, never index 0).
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    const acme = me.workspaces.find((w: { name: string }) => w.name === 'Acme Corp GmbH');
    expect(me.activeWorkspaceId).toBe(acme.id);
    expect(acme.default).toBe(true);

    // The default moves hub-side → the flag follows at the next login.
    hub.setUserOrg('hub-u1', ORG_ACME, { name: 'Acme Corp GmbH', role: 'admin' });
    hub.setUserOrg('hub-u1', ORG_BETA, { name: 'Beta LLC', role: 'member', isDefault: true });
    await ssoLogin(app, {
      ...u1,
      email: 'alice.renamed@acme.test',
      role: 'admin',
      workspaceName: 'Acme Corp GmbH'
    });
    const { rows: moved } = await app.db.pool.query(
      `SELECT w.central_account_id, m.is_default FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN "user" u ON u.id = m.user_id
       WHERE u.email = 'alice.renamed@acme.test' ORDER BY w.central_account_id`
    );
    expect(moved).toEqual([
      { central_account_id: ORG_ACME, is_default: false },
      { central_account_id: ORG_BETA, is_default: true }
    ]);
    // Back to a single-org alice for the tests below.
    hub.removeUserOrg('hub-u1', ORG_BETA);
    hub.setUserOrg('hub-u1', ORG_ACME, { name: 'Acme Corp GmbH', role: 'admin' });
    await ssoLogin(app, {
      ...u1,
      email: 'alice.renamed@acme.test',
      role: 'admin',
      workspaceName: 'Acme Corp GmbH'
    });
  });

  it('links the setup operator via the D9 trusted-provider path instead of duplicating', async () => {
    const cookie = await ssoLogin(app, {
      sub: 'hub-operator',
      email: OWNER.email,
      name: OWNER.name,
      workspaceId: ORG_ACME,
      role: 'owner',
      workspaceName: 'Acme Corp GmbH'
    });
    // Still exactly ONE local user for the operator's email…
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [OWNER.email]);
    expect(users).toHaveLength(1);
    // …now carrying the hub account link…
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ account_id: 'hub-operator' }]);
    // …with exactly the projection: cloud setup mints NO workspace
    // (user-scoped federation), so the operator's only membership is the
    // hub org their SSO login reconciled in.
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    const names = me.workspaces.map((w: { name: string }) => w.name).sort();
    expect(names).toContain('Acme Corp GmbH');
    expect(me.workspaces.length).toBe(1);
    const { rows: memberships } = await app.db.pool.query(
      `SELECT origin, role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 AND w.central_account_id = $2`,
      [users[0].id, ORG_ACME]
    );
    expect(memberships).toEqual([{ origin: 'hub', role: 'owner' }]);
  });

  it('two concurrent first-logins into a fresh org project exactly ONE workspace', async () => {
    const fixtures: HubUserFixture[] = [
      {
        sub: 'hub-race-1',
        email: 'r1@race.test',
        workspaceId: ORG_RACE,
        role: 'member',
        workspaceName: 'Race Org'
      },
      {
        sub: 'hub-race-2',
        email: 'r2@race.test',
        workspaceId: ORG_RACE,
        role: 'admin',
        workspaceName: 'Race Org'
      }
    ];
    // Two full states first, then both callbacks in flight together.
    const dances = [];
    for (const f of fixtures) {
      const { state, stateCookie } = await ssoInitiate(app);
      dances.push({ code: hub.mintCode(f), state, stateCookie });
    }
    const results = await Promise.all(
      dances.map(({ code, state, stateCookie }) =>
        app.app.request(
          `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { headers: { cookie: stateCookie } }
        )
      )
    );
    for (const res of results) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    const { rows: ws } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
      ORG_RACE
    ]);
    expect(ws).toHaveLength(1);
    const { rows: members } = await app.db.pool.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 ORDER BY role`,
      [ws[0].id]
    );
    expect(members).toEqual([{ role: 'admin' }, { role: 'member' }]);
  });

  it('parallel logins of ONE user project the org-list union with per-org roles intact', async () => {
    const base = { sub: 'hub-multi', email: 'multi@orgs.test', name: 'Multi Org' };
    // Establish the user first (two parallel FIRST logins of a brand-new
    // user race the JIT insert; the loser fails cleanly on uniqueness).
    await ssoLogin(app, { ...base, workspaceId: ORG_LEFT, role: 'owner', workspaceName: 'Left Org' });
    hub.setUserOrg('hub-multi', ORG_RIGHT, { name: 'Right Org', role: 'member' });

    const dances = [];
    for (let i = 0; i < 2; i++) {
      const { state, stateCookie } = await ssoInitiate(app);
      dances.push({
        code: hub.mintCode({ ...base, workspaceId: ORG_LEFT, role: 'owner', workspaceName: 'Left Org' }),
        state,
        stateCookie
      });
    }
    const results = await Promise.all(
      dances.map(({ code, state, stateCookie }) =>
        app.app.request(
          `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { headers: { cookie: stateCookie } }
        )
      )
    );
    for (const res of results) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    // Both orgs projected, each with the role the HUB LIST asserts for it —
    // the org list is per-user hub truth, not per-login claims.
    const { rows } = await app.db.pool.query(
      `SELECT w.central_account_id, m.role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN "user" u ON u.id = m.user_id
       WHERE u.email = 'multi@orgs.test' ORDER BY w.central_account_id`,
      []
    );
    expect(rows).toEqual([
      { central_account_id: ORG_LEFT, role: 'owner' },
      { central_account_id: ORG_RIGHT, role: 'member' }
    ]);
  });

  describe('the FAIL-CLOSED login reconcile (a login without its projection must not exist)', () => {
    it('an /orgs outage during the callback revokes the session (sso_projection_failed)', async () => {
      const dana: HubUserFixture = {
        sub: 'hub-dark',
        email: 'dana@dark.test',
        workspaceId: ORG_DARK,
        role: 'owner',
        workspaceName: 'Dark Org'
      };
      hub.orgsMode = 'network';
      try {
        const res = await ssoDance(app, dana);
        await expectFailedLogin(app, res, 'error=sso_projection_failed');
      } finally {
        hub.orgsMode = 'ok';
      }
      // No session, no projection. (The JIT user row exists — created
      // before the after-hook; the orphan purge covers it, and a later
      // successful login adopts it.)
      const { rows: ws } = await app.db.pool.query(`SELECT 1 FROM workspaces WHERE central_account_id = $1`, [
        ORG_DARK
      ]);
      expect(ws).toHaveLength(0);
      // The retry heals end-to-end once the hub answers again.
      const cookie = await ssoLogin(app, dana);
      const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
      expect(me.workspaces.map((w: { name: string }) => w.name)).toContain('Dark Org');
    });

    it('a hub 500 on /orgs fails the login the same way', async () => {
      hub.orgsMode = 'http500';
      try {
        const res = await ssoDance(app, {
          sub: 'hub-dark',
          email: 'dana@dark.test',
          workspaceId: ORG_DARK,
          role: 'owner',
          workspaceName: 'Dark Org'
        });
        await expectFailedLogin(app, res, 'error=sso_projection_failed');
      } finally {
        hub.orgsMode = 'ok';
      }
    });
  });

  describe('the access token is a bearer, not an identity: wrong shapes self-heal via refresh', () => {
    it('an OPAQUE callback access token still logs in (one refresh retry mints a hub-callable JWT)', async () => {
      const opal: HubUserFixture = {
        sub: 'hub-opal',
        email: 'opal@selfheal.test',
        workspaceId: ORG_BETA,
        role: 'member',
        workspaceName: 'Beta LLC',
        overrides: { forceOpaque: true }
      };
      const refreshesBefore = hub.refreshCount();
      const cookie = await ssoLogin(app, opal);
      expect(hub.refreshCount()).toBeGreaterThan(refreshesBefore); // the heal was a refresh
      const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
      expect(me.workspaces.map((w: { name: string }) => w.name)).toContain('Beta LLC');
    });

    it('a WRONG-AUDIENCE callback access token (a hub not honoring resource) self-heals too', async () => {
      const wanda: HubUserFixture = {
        sub: 'hub-wanda',
        email: 'wanda@selfheal.test',
        workspaceId: ORG_BETA,
        role: 'member',
        workspaceName: 'Beta LLC',
        overrides: { accessAud: ['http://other-tool.test/mcp'] }
      };
      const cookie = await ssoLogin(app, wanda);
      const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
      expect(me.workspaces.map((w: { name: string }) => w.name)).toContain('Beta LLC');
    });
  });

  describe('fail-closed id_token negatives (no user, no session)', () => {
    const intruder = (overrides: HubTokenOverrides): HubUserFixture => ({
      sub: 'hub-evil',
      email: 'evil@negative.test',
      workspaceId: '11111111-aaaa-4bbb-8ccc-00000000dead',
      role: 'member',
      overrides
    });

    async function expectRejected(fixture: HubUserFixture) {
      const res = await ssoDance(app, fixture);
      // getUserInfo returned null → the plugin redirects to its error URL.
      await expectFailedLogin(app, res, 'error=');
      const { rows } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [fixture.email]);
      expect(rows).toHaveLength(0);
    }

    it('rejects tokens from a foreign issuer', async () => {
      await expectRejected(intruder({ iss: 'http://evil-hub.test' }));
    });

    it('rejects an expired id_token', async () => {
      await expectRejected(intruder({ expiresInSeconds: -60 }));
    });
  });

  it('an unknown hub role is never projected — the login succeeds but grants nothing (D11)', async () => {
    // Role semantics are the org list's business now: the id_token carries
    // no role, so the login itself cannot be refused on one — instead the
    // reconcile refuses to project an unknown role (derived, never mapped).
    const weird: HubUserFixture = {
      sub: 'hub-weird',
      email: 'weird@role.test',
      workspaceId: ORG_WEIRD,
      role: 'emperor',
      workspaceName: 'Weird Org'
    };
    const cookie = await ssoLogin(app, weird);
    const { rows: ws } = await app.db.pool.query(`SELECT 1 FROM workspaces WHERE central_account_id = $1`, [
      ORG_WEIRD
    ]);
    expect(ws).toHaveLength(0); // nothing projected
    // The session exists but reaches no workspace (the sole org's unknown
    // role projected nothing) — /me answers the zero-membership zero state
    // (200, empty list), not a 401: the dashboard renders the
    // no-organization page, never a login bounce (user-scoped federation).
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    const meBody = await readJson(me);
    expect(meBody.workspaces).toEqual([]);
    expect(meBody.activeWorkspaceId).toBeNull();
  });

  it('fails the login cleanly when the hub-asserted email collides with another local user (D10)', async () => {
    const u6: HubUserFixture = {
      sub: 'hub-u6',
      email: 'carol@collide.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, u6); // establishes carol
    // The hub now asserts the OPERATOR's address for carol (hub-side email
    // change to an address someone else still holds locally).
    const res = await ssoDance(app, { ...u6, email: OWNER.email });
    await expectFailedLogin(app, res, 'error=sso_email_conflict');
    // Nothing corrupted: carol keeps her email, the operator keeps theirs.
    const { rows: carol } = await app.db.pool.query(
      `SELECT email FROM "user" u JOIN account a ON a.user_id = u.id
       WHERE a.provider_id = 'antasphere' AND a.account_id = 'hub-u6'`
    );
    expect(carol).toEqual([{ email: 'carol@collide.test' }]);
    const { rows: owners } = await app.db.pool.query(
      `SELECT COUNT(*)::int AS n FROM "user" WHERE email = $1`,
      [OWNER.email]
    );
    expect(owners).toEqual([{ n: 1 }]);
  });

  it('refuses to merge two hub identities onto one local user (stale-email takeover)', async () => {
    // dave logs in with u7 …
    const dave: HubUserFixture = {
      sub: 'hub-u7',
      email: 'dave@stale.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, dave);
    // … then a DIFFERENT hub identity asserts dave's (now stale hub-side)
    // address: the trusted email-match link would merge it onto dave's local
    // user — the guard undoes the link and fails the login.
    const res = await ssoDance(app, { ...dave, sub: 'hub-u8', name: 'Mallory' });
    await expectFailedLogin(app, res, 'error=sso_identity_conflict');
    const { rows: accounts } = await app.db.pool.query(
      `SELECT a.account_id FROM account a JOIN "user" u ON u.id = a.user_id
       WHERE u.email = 'dave@stale.test' AND a.provider_id = 'antasphere' ORDER BY a.account_id`
    );
    expect(accounts).toEqual([{ account_id: 'hub-u7' }]); // the merge left no trace
  });

  it('maps the hub email_verified claim honestly on JIT (unverified stays unverified)', async () => {
    await ssoLogin(app, {
      sub: 'hub-u9',
      email: 'eve@unverified.test',
      emailVerified: false,
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    });
    const { rows } = await app.db.pool.query(`SELECT email_verified FROM "user" WHERE email = $1`, [
      'eve@unverified.test'
    ]);
    expect(rows).toEqual([{ email_verified: false }]);
  });

  it('never syncs emailVerified DOWNWARD for an unchanged address (the break-glass latch)', async () => {
    const grace: HubUserFixture = {
      sub: 'hub-u11',
      email: 'grace@latch.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, grace); // JIT, verified (hub default)
    // The hub now asserts email_verified=false for the SAME address (a hub
    // posture change / bug): the local latch must hold — break-glass refuses
    // unverified users, so a downward flip would close the operator door.
    await ssoLogin(app, { ...grace, emailVerified: false });
    const { rows } = await app.db.pool.query(`SELECT email_verified FROM "user" WHERE email = $1`, [
      'grace@latch.test'
    ]);
    expect(rows).toEqual([{ email_verified: true }]);
  });

  it('takes the hub-asserted verification state when the address CHANGES (no false latch)', async () => {
    // grace's hub email changes to a NEW address asserted unverified: the
    // new mailbox is unproven, so the honest state is unverified.
    await ssoLogin(app, {
      sub: 'hub-u11',
      email: 'grace.moved@latch.test',
      emailVerified: false,
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    });
    const { rows } = await app.db.pool.query(`SELECT email, email_verified FROM "user" WHERE email = $1`, [
      'grace.moved@latch.test'
    ]);
    expect(rows).toEqual([{ email: 'grace.moved@latch.test', email_verified: false }]);
  });

  it('a residue second hub link is undone in favor of the OLDER identity (guard keys on recency)', async () => {
    const frank: HubUserFixture = {
      sub: 'hub-u10',
      email: 'frank@residue.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, frank);
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      'frank@residue.test'
    ]);
    // Simulate the residue a crash between better-auth's link and the
    // after-hook (or an explicit /oauth2/link) leaves behind: a SECOND,
    // newer antasphere row on the same user that no guard ever saw.
    await app.db.pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('residue-acct-1', 'hub-ghost', 'antasphere', $1, now() + interval '1 second', now())`,
      [users[0].id]
    );
    // Frank's own (older, legitimate) identity logs in: the guard must
    // delete the GHOST row, not frank's — deleting the current-sub row here
    // would destroy the established identity and strand the user.
    const res = await ssoDance(app, frank);
    await expectFailedLogin(app, res, 'error=sso_identity_conflict');
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ account_id: 'hub-u10' }]); // ghost gone, frank intact
    // Self-healed: the retry logs straight in.
    await ssoLogin(app, frank);
  });
});

describe('oss edition: zero SSO surface', () => {
  it('registers no OAuth relying party at all', async () => {
    const app = await createTestApp(await createDatabase(container, 'hub_sso_oss'));
    // The genericOAuth plugin is absent → its routes do not exist.
    const res = await app.app.request(
      '/api/v1/auth/sign-in/oauth2',
      json({ providerId: 'antasphere', callbackURL: '/' })
    );
    expect(res.status).toBe(404);
    const cb = await app.app.request('/api/v1/auth/oauth2/callback/antasphere?code=x&state=y');
    expect(cb.status).toBe(404);
    await app.stop();
  });
});
