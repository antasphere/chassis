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
 * Live org reconciliation (identity/hub-reconcile.ts): org and membership
 * truth live ONLY at the hub, read AS THE USER via each user's own grant
 * (never a service key), and every request into a projected workspace
 * reflects it — the live gate runs the cached `reconcile()`, every SSO
 * login the TTL-bypassing force pass. One pass projects missing orgs,
 * syncs names/roles/hub_status/is_default, and deactivates `origin='hub'`
 * memberships the hub no longer asserts.
 *
 * Failure posture pinned here: only a definitive 200 list mutates state;
 * transient hub errors serve local state (nothing deactivated) inside the
 * stale window; probes are retry-throttled. Enforcement verdicts
 * (revoked/suspended/unavailable/grant-dead) are the live-gate suite's.
 *
 * Dials are shrunk so propagation is observable in milliseconds; the stale
 * window is pinned LONG so this suite never trips hub_unavailable.
 */

const OWNER = { email: 'owner@reconcile.test', name: 'Op Owner', password: 'op-owner-password-123' };

const ORG_ONE = '33333333-aaaa-4bbb-8ccc-000000000001';
const ORG_TWO = '33333333-aaaa-4bbb-8ccc-000000000002';
const ORG_THREE = '33333333-aaaa-4bbb-8ccc-000000000003';
const ORG_TINA = '33333333-aaaa-4bbb-8ccc-000000000005';
const ORG_FRESH = '33333333-aaaa-4bbb-8ccc-000000000006';
const ORG_WEIRD = '33333333-aaaa-4bbb-8ccc-000000000009';
const ORG_DANA = '33333333-aaaa-4bbb-8ccc-00000000000a';
const ORG_BG = '33333333-aaaa-4bbb-8ccc-00000000000b';
const ORG_OPX = '33333333-aaaa-4bbb-8ccc-00000000000c';

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

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(
    await createDatabase(container, 'hub_reconcile'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
      METRICS_TOKEN: 'reconcile-metrics-token',
      // The break-glass lifeboat suite below acts as the setup operator.
      SUPERADMIN_EMAILS: OWNER.email
    },
    { hubDials: DIALS }
  );
  const res = await app.app.request(
    '/api/v1/setup',
    sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'Reconcile', owner: OWNER })
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

const orgFetches = () => hub.orgsRequests.length;

async function workspaceIdOf(centralAccountId: string): Promise<string> {
  const { rows } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
    centralAccountId
  ]);
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

async function membershipRow(centralAccountId: string, email: string) {
  const { rows } = await app.db.pool.query(
    `SELECT m.role, m.origin, m.is_active FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      JOIN "user" u ON u.id = m.user_id
     WHERE w.central_account_id = $1 AND u.email = $2`,
    [centralAccountId, email]
  );
  return rows;
}

describe('login-time reconciliation (the fail-closed assertLogin pass)', () => {
  const rick: HubUserFixture = {
    sub: 'hub-rick',
    email: 'rick@reconcile.test',
    name: 'Rick Reconciled',
    workspaceId: ORG_ONE,
    role: 'owner',
    workspaceName: 'Rick Org'
  };
  let rickCookie: string;

  it('ONE login materializes ALL of the user’s hub orgs, not just the one they came from', async () => {
    // The hub knows rick in a SECOND org before he ever logs in here.
    hub.setUserOrg('hub-rick', ORG_TWO, { name: 'Second Org', role: 'member' });
    rickCookie = await sso.ssoLogin(app, hub, rick);

    const body = await readJson(await me(rickCookie));
    const byName = Object.fromEntries(
      body.workspaces.map((w: { name: string; role: string; hubOrigin: boolean }) => [w.name, w])
    );
    expect(byName['Rick Org']).toMatchObject({ role: 'owner', hubOrigin: true });
    expect(byName['Second Org']).toMatchObject({ role: 'member', hubOrigin: true });
    expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
      { role: 'member', origin: 'hub', is_active: true }
    ]);
  });

  it('a fresh hub org appears IMMEDIATELY after a re-login (force pass bypasses the TTL)', async () => {
    await me(rickCookie); // warm the cache …
    hub.setUserOrg('hub-rick', ORG_FRESH, { name: 'Fresh Org', role: 'admin' });
    await sso.ssoLogin(app, hub, rick); // … the login must NOT wait for its expiry
    const body = await readJson(await me(rickCookie));
    expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Fresh Org');
    hub.removeUserOrg('hub-rick', ORG_FRESH); // keep the later pins focused
    await expireTtl();
    await me(rickCookie); // sweep it back out
  });

  describe('request-time reconciliation (the live gate’s read-through)', () => {
    it('an org created at the hub appears at the next reload', async () => {
      hub.setUserOrg('hub-rick', ORG_THREE, { name: 'Third Org', role: 'member' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Third Org');
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('rename and role change at the hub propagate at the next reload', async () => {
      hub.setUserOrg('hub-rick', ORG_THREE, { name: 'Third Org GmbH', role: 'admin' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      const third = body.workspaces.find((w: { name: string }) => w.name === 'Third Org GmbH');
      expect(third).toMatchObject({ role: 'admin', hubOrigin: true });
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'admin', origin: 'hub', is_active: true }
      ]);
    });

    it('a hub-side removal deactivates the projection with exactly ONE audit row; the workspace dies', async () => {
      hub.removeUserOrg('hub-rick', ORG_THREE);
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).not.toContain('Third Org GmbH');
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'admin', origin: 'hub', is_active: false }
      ]);

      // Naming the swept workspace now fails closed (no membership resolves
      // — the miss-hook retries one cached reconcile and still finds none).
      const wsThree = await workspaceIdOf(ORG_THREE);
      expect((await me(rickCookie, wsThree)).status).toBe(401);

      // Exactly ONE audit row per flip — system actor, hub_reconcile reason.
      await expireTtl();
      await me(rickCookie); // an extra pass must NOT audit again (row already inactive)
      const { rows: audit } = await app.db.pool.query(
        `SELECT a.actor_via FROM audit_log a JOIN workspaces w ON w.id = a.workspace_id
         WHERE w.central_account_id = $1 AND a.action = 'member.deactivate'
           AND a.metadata->>'reason' = 'hub_reconcile'`,
        [ORG_THREE]
      );
      expect(audit).toEqual([{ actor_via: 'system' }]);
    });

    it('an unknown-role entry keeps the membership ALIVE but is never projected/synced', async () => {
      // A brand-new org with an unknown role: never projected.
      hub.setUserOrg('hub-rick', ORG_WEIRD, { name: 'Weird Org', role: 'emperor' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).not.toContain('Weird Org');
      const { rows } = await app.db.pool.query(`SELECT 1 FROM workspaces WHERE central_account_id = $1`, [
        ORG_WEIRD
      ]);
      expect(rows).toHaveLength(0);

      // An EXISTING org whose entry turns unknown-role: kept alive (never
      // read as absence), local role kept (no sync from a malformed entry).
      hub.setUserOrg('hub-rick', ORG_ONE, { name: 'Rick Org', role: 'emperor' });
      await expireTtl();
      await me(rickCookie);
      expect(await membershipRow(ORG_ONE, rick.email)).toEqual([
        { role: 'owner', origin: 'hub', is_active: true }
      ]);
      hub.setUserOrg('hub-rick', ORG_ONE, { name: 'Rick Org', role: 'owner' });
      hub.removeUserOrg('hub-rick', ORG_WEIRD);
    });
  });

  describe('failure posture: hub errors fail OPEN inside the stale window, retry-throttled', () => {
    it('5xx: local state served, nothing deactivated, ONE probe per retry window', async () => {
      await expireTtl();
      await me(rickCookie); // fresh definitive pass first
      hub.orgsMode = 'http500';
      try {
        await expireTtl();
        const before = orgFetches();
        const first = await readJson(await me(rickCookie));
        expect(first.workspaces.length).toBeGreaterThanOrEqual(2); // ORG_ONE + ORG_TWO intact
        expect(orgFetches()).toBe(before + 1);
        // Within retryMs: no second probe, still 200 on local state.
        expect((await me(rickCookie)).status).toBe(200);
        expect((await me(rickCookie)).status).toBe(200);
        expect(orgFetches()).toBe(before + 1);
      } finally {
        hub.orgsMode = 'ok';
      }
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('timeout: the awaited pass is bounded by orgsTimeoutMs and fails open', async () => {
      await sleep(DIALS.retryMs + 40);
      await me(rickCookie);
      hub.orgsDelayMs = DIALS.orgsTimeoutMs + 400;
      try {
        await expireTtl();
        const startedAt = Date.now();
        expect((await me(rickCookie)).status).toBe(200);
        expect(Date.now() - startedAt).toBeLessThan(DIALS.orgsTimeoutMs + 600);
      } finally {
        hub.orgsDelayMs = 0;
      }
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('recovers after the throttle window: the next reload reconciles again', async () => {
      hub.setUserOrg('hub-rick', ORG_FRESH, { name: 'Fresh Org', role: 'member' });
      await sleep(DIALS.retryMs + 40);
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Fresh Org');
      hub.removeUserOrg('hub-rick', ORG_FRESH);
      await expireTtl();
      await me(rickCookie);
    });
  });

  describe('cost discipline: cache, single-flight — and machine credentials reconcile too', () => {
    it('N concurrent reloads share ONE fetch; a fresh cache costs zero', async () => {
      await expireTtl();
      hub.orgsDelayMs = 100; // hold all racers in flight together
      let before: number;
      try {
        before = orgFetches();
        const responses = await Promise.all(Array.from({ length: 8 }, () => me(rickCookie)));
        for (const res of responses) expect(res.status).toBe(200);
      } finally {
        hub.orgsDelayMs = 0;
      }
      expect(orgFetches()).toBe(before + 1); // single-flight
      expect((await me(rickCookie)).status).toBe(200); // within the TTL
      expect(orgFetches()).toBe(before + 1); // cache hit, no fetch
    });

    it('an API key into a projected workspace reconciles like a session (a key IS its user)', async () => {
      const minted = await app.app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: rickCookie },
        body: JSON.stringify({ name: 'reconcile key', scopes: [host.scopes.read] })
      });
      expect(minted.status).toBe(201);
      const { key } = await readJson(minted);
      await expireTtl();
      const before = orgFetches();
      const res = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      // The user-scoped model: /me lists ALL the holder's workspaces…
      expect(body.workspaces.length).toBeGreaterThanOrEqual(2);
      // …and the request ran a real as-the-user reconcile pass.
      expect(orgFetches()).toBe(before + 1);
    });
  });
});

describe('the sweep’s blast radius: ONLY hub rows in projected workspaces', () => {
  it('an empty definitive list deactivates hub projections and NOTHING else', async () => {
    const tina: HubUserFixture = {
      sub: 'hub-tina',
      email: 'tina@reconcile.test',
      workspaceId: ORG_TINA,
      role: 'owner',
      workspaceName: 'Tina Org'
    };
    const cookie = await sso.ssoLogin(app, hub, tina);
    expect((await me(cookie)).status).toBe(200);
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [tina.email]);
    const tinaId = users[0].id as string;

    // Three rows the sweep must NEVER touch: a local row in an unprojected
    // workspace, a guest row, and a hub-origin RESIDUE row whose workspace
    // is not a projection (centralAccountId NULL).
    const mkWorkspace = async (name: string) => {
      const { rows } = await app.db.pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        name
      ]);
      return rows[0].id as string;
    };
    const localWs = await mkWorkspace('Tina Local');
    const guestWs = await mkWorkspace('Tina Guest Host');
    const residueWs = await mkWorkspace('Tina Residue');
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active) VALUES
       ($1, $4, 'member', 'local', true),
       ($2, $4, 'member', 'guest', true),
       ($3, $4, 'member', 'hub', true)`,
      [localWs, guestWs, residueWs, tinaId]
    );

    // The hub now asserts NO orgs for tina.
    hub.clearUserOrgs('hub-tina');
    await expireTtl();
    // The FIRST request into the projected workspace runs the sweep and is
    // refused by the gate's own verdict — enforcement and freshness are one
    // pass now.
    const swept = await me(cookie);
    expect(swept.status).toBe(401);
    expect((await readJson(swept)).error.code).toBe('membership_revoked');

    const { rows: after } = await app.db.pool.query(
      `SELECT w.name, m.origin, m.is_active FROM workspace_members m
        JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 ORDER BY w.name`,
      [tinaId]
    );
    expect(after).toEqual([
      { name: 'Tina Guest Host', origin: 'guest', is_active: true },
      { name: 'Tina Local', origin: 'local', is_active: true },
      { name: 'Tina Org', origin: 'hub', is_active: false }, // the ONE swept row
      { name: 'Tina Residue', origin: 'hub', is_active: true } // unprojected: out of scope
    ]);
    const { rows: audit } = await app.db.pool.query(
      `SELECT a.workspace_id FROM audit_log a
       WHERE a.action = 'member.deactivate' AND a.metadata->>'reason' = 'hub_reconcile'
         AND a.resource_id = $1`,
      [tinaId]
    );
    expect(audit).toHaveLength(1);

    // Tina still reaches her LOCAL workspace: the session survives; only
    // the hub-asserted membership died.
    const local = await me(cookie, localWs);
    expect(local.status).toBe(200);
  });
});

describe('the unknown-workspace retry: a named miss reconciles once and re-resolves — all three credential kinds', () => {
  const dana: HubUserFixture = {
    sub: 'hub-dana',
    email: 'dana@reconcile.test',
    workspaceId: ORG_DANA,
    role: 'owner',
    workspaceName: 'Dana Org'
  };
  let danaCookie: string;
  let wsTwo: string;

  it('“invited at the hub, clicks a deep link” resolves without a re-login (session)', async () => {
    danaCookie = await sso.ssoLogin(app, hub, dana);
    // Granted membership of rick's ORG_TWO at the hub AFTER her login; its
    // workspace already exists locally (rick's projection) — the deep-link
    // URL names it, but dana holds no local membership row yet.
    hub.setUserOrg('hub-dana', ORG_TWO, { name: 'Second Org', role: 'member' });
    wsTwo = await workspaceIdOf(ORG_TWO);
    await expireTtl(); // the retry rides the CACHED reconcile — let it expire
    const res = await me(danaCookie, wsTwo);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(wsTwo);
    expect(body.role).toBe('member');
    expect(await membershipRow(ORG_TWO, dana.email)).toEqual([
      { role: 'member', origin: 'hub', is_active: true }
    ]);
  });

  it('an API key naming a freshly granted org resolves through the same retry', async () => {
    const minted = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: danaCookie },
      body: JSON.stringify({ name: 'dana key', scopes: [host.scopes.read] })
    });
    expect(minted.status).toBe(201);
    const { key } = await readJson(minted);
    // Deactivate the row the session retry just projected — the KEY's own
    // miss must re-project it.
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false
       WHERE workspace_id = $1 AND user_id = (SELECT id FROM "user" WHERE email = $2)`,
      [wsTwo, dana.email]
    );
    await expireTtl();
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${key}`, 'x-workspace-id': wsTwo }
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(wsTwo);
  });

  it('an OAuth bearer naming a freshly granted org resolves through the same retry', async () => {
    const bearer = await sso.oauthBearer(app, danaCookie);
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false
       WHERE workspace_id = $1 AND user_id = (SELECT id FROM "user" WHERE email = $2)`,
      [wsTwo, dana.email]
    );
    await expireTtl();
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${bearer}`, 'x-workspace-id': wsTwo }
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(wsTwo);
  });

  it('a workspace the hub does not grant stays a fail-closed 401 (one retry, no oracle)', async () => {
    await expireTtl();
    // A real workspace she has no grant for, and a phantom id: same answer.
    const solo = await me(danaCookie, await workspaceIdOf(ORG_ONE));
    expect(solo.status).toBe(401);
    const phantom = await me(danaCookie, '99999999-9999-4999-8999-999999999999');
    expect(phantom.status).toBe(401);
  });
});

describe('observability', () => {
  it('hub_reconcile_passes_total and hub_grant_refreshes_total are registered and counting', async () => {
    const res = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer reconcile-metrics-token' }
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/hub_reconcile_passes_total\{outcome="ok"\} [1-9]/);
    expect(text).toMatch(/hub_reconcile_passes_total\{outcome="inconclusive"\} [1-9]/);
    expect(text).toMatch(/hub_grant_refreshes_total/);
  });
});

describe('break-glass claim on a PROJECTED workspace: the origin=local lifeboat (pin)', () => {
  // Decision 2 (user-scoped federation): cloud setup mints no workspace, so
  // operator recovery targets PROJECTED workspaces — break-glass
  // claim-ownership writes an `origin='local'` owner row there, and the
  // reconcile sweep is scoped to `origin='hub'` rows ONLY. This pin proves
  // the whole lifeboat: the zero-membership operator claims a projection,
  // gains dashboard access, and KEEPS it through the maximal sweep — a
  // reconcile pass whose hub org list is EMPTY.
  let operatorCookie: string;
  let wsBg: string;

  it('a zero-membership operator claims ownership of a projected workspace', async () => {
    // A hub user projects ORG_BG first (the workspace break-glass targets).
    await sso.ssoLogin(app, hub, {
      sub: 'hub-bg-owner',
      email: 'bg-owner@reconcile.test',
      workspaceId: ORG_BG,
      role: 'owner',
      workspaceName: 'BG Org'
    });
    wsBg = await workspaceIdOf(ORG_BG);

    // The operator: setup ran in beforeAll — a verified user with ZERO
    // memberships (cloud setup creates no workspace). The break-glass door
    // is the wired-but-hidden password sign-in.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      sso.json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    operatorCookie = extractCookie(signIn);
    const zero = await readJson(await me(operatorCookie));
    expect(zero.workspaces).toEqual([]);

    const claim = await app.app.request('/api/v1/admin/break-glass/claim-ownership', {
      ...sso.json({ workspaceId: wsBg }),
      headers: { 'content-type': 'application/json', cookie: operatorCookie, 'x-forwarded-for': '10.88.0.1' }
    });
    expect(claim.status).toBe(200);
    const claimed = await readJson(claim);
    expect(claimed.role).toBe('owner');
    expect(claimed.created).toBe(true);

    // Dashboard access: the projected workspace resolves for the operator,
    // via the local row (the live gate skips hub enforcement for it).
    const meRes = await me(operatorCookie, wsBg);
    expect(meRes.status).toBe(200);
    const body = await readJson(meRes);
    expect(body.activeWorkspaceId).toBe(wsBg);
    expect(body.origin).toBe('local');
    expect(body.role).toBe('owner');

    // The row break-glass wrote is origin='local' — the sweep's blind spot,
    // by design.
    const { rows } = await app.db.pool.query(
      `SELECT m.origin, m.role, m.is_active FROM workspace_members m
        JOIN "user" u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND u.email = $2`,
      [wsBg, OWNER.email]
    );
    expect(rows).toEqual([{ origin: 'local', role: 'owner', is_active: true }]);
  });

  it('the claim survives an EMPTY-hub-list reconcile (the maximal sweep)', async () => {
    // Give the operator a hub identity + one hub org of their own: the D9
    // trusted link rides the verified operator email.
    const operatorSsoCookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-operator-bg',
      email: OWNER.email,
      workspaceId: ORG_OPX,
      role: 'owner',
      workspaceName: 'Operator Own Org'
    });
    const wsOpx = await workspaceIdOf(ORG_OPX);
    expect((await me(operatorSsoCookie, wsOpx)).status).toBe(200);

    // The hub now asserts NOTHING for the operator: the next reconcile pass
    // runs with an EMPTY org list — the maximal deactivation sweep.
    hub.clearUserOrgs('hub-operator-bg');
    await expireTtl();
    const swept = await me(operatorSsoCookie, wsOpx);
    expect(swept.status).toBe(401); // the hub-origin row went with the sweep

    // …but the break-glass claim row is origin='local': untouched. The
    // operator keeps full dashboard access to the projected workspace.
    const kept = await me(operatorSsoCookie, wsBg);
    expect(kept.status).toBe(200);
    const body = await readJson(kept);
    expect(body.activeWorkspaceId).toBe(wsBg);
    expect(body.origin).toBe('local');
    expect(body.role).toBe('owner');
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m
        JOIN "user" u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND u.email = $2`,
      [wsBg, OWNER.email]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });
});

describe('a severed hub link fails CLOSED for a hub-origin principal (CLOUD-1, PRDCT-1356)', () => {
  const ORG_SEV = '33333333-aaaa-4bbb-8ccc-00000000000d';
  const sev: HubUserFixture = {
    sub: 'hub-sev',
    email: 'sev@reconcile.test',
    name: 'Sev Ered',
    workspaceId: ORG_SEV,
    role: 'member',
    workspaceName: 'Sev Org'
  };
  const SEV_ENV = {
    EDITION: 'cloud',
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
  };

  it('no account row + hub-origin memberships → 401 hub_grant_expired, never the fail-open no_link', async () => {
    // Own database + own boots: the grant store caches the hub access token
    // in PROCESS memory, so the severed row is only observed by a fresh
    // process — which is the honest shape anyway (a replica restart, the
    // next deploy).
    const url = await createDatabase(container, 'hub_severed');
    const first = await createTestApp(url, { ...SEV_ENV, HUB_ISSUER_URL: hub.issuer }, { hubDials: DIALS });
    let cookie: string;
    let userId: string;
    try {
      const setup = await first.app.request(
        '/api/v1/setup',
        sso.json({ setupToken: 'integration-test-setup-token', instanceName: 'Severed', owner: OWNER })
      );
      expect(setup.status).toBe(201);
      cookie = await sso.ssoLogin(first, hub, sev);
      const ws = await first.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
        ORG_SEV
      ]);
      expect(ws.rows).toHaveLength(1);
      const ok = await first.app.request('/api/v1/me', {
        headers: { cookie, 'x-workspace-id': ws.rows[0].id }
      });
      expect(ok.status).toBe(200);
      const u = await first.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [sev.email]);
      userId = u.rows[0].id as string;
      // Sever the link the way an unlink (now refused) or a partial cleanup
      // would: the account row goes, the hub-origin membership stays.
      await first.db.pool.query(`DELETE FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`, [
        userId
      ]);
    } finally {
      await first.stop();
    }

    const second = await createTestApp(url, { ...SEV_ENV, HUB_ISSUER_URL: hub.issuer }, { hubDials: DIALS });
    try {
      const ws = await second.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
        ORG_SEV
      ]);
      const res = await second.app.request('/api/v1/me', {
        headers: { cookie, 'x-workspace-id': ws.rows[0].id }
      });
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('hub_grant_expired');
      // The membership row itself was NOT swept (no org truth was read).
      const rows = await second.db.pool.query(
        `SELECT origin, is_active FROM workspace_members WHERE user_id = $1`,
        [userId]
      );
      expect(rows.rows).toEqual([{ origin: 'hub', is_active: true }]);
    } finally {
      await second.stop();
    }
  });
});
