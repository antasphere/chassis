import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * Break-glass superadmin (ADR 010):
 *  - recognition is SESSION + VERIFIED email + SUPERADMIN_EMAILS allowlist —
 *    an unverified match, a non-listed session, and a machine credential
 *    (even one owned by a listed user) are all rejected;
 *  - unset env = the capability is fully dormant (403 for everyone);
 *  - claim-ownership recovers an ownerless workspace (creating, reactivating,
 *    or promoting the membership — additive, so the 0009 trigger holds);
 *  - reset-2fa clears a locked-out user's factor;
 *  - everything is audited with the superadmin identity + before/after state.
 */

const OWNER = { email: 'owner@bg.test', name: 'BG Owner', password: 'bg-owner-password-123' };
const ROOT = { email: 'root@bg.test', name: 'BG Root', password: 'bg-root-password-1234' };
const SECOND = { email: 'second@bg.test', name: 'BG Second', password: 'bg-second-password-12' };
const ADMIN = { email: 'admin@bg.test', name: 'BG Admin', password: 'bg-admin-password-1234' };
const MEMBER = { email: 'member@bg.test', name: 'BG Member', password: 'bg-member-password-12' };

let container: StartedPostgreSqlContainer;

// The break-glass wall is 10/hour per IP and TRUST_PROXY=true in tests, so
// every request carries a unique forwarded address to stay off one shared
// 'unknown' bucket.
let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter % 250}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function signIn(app: TestApp, email: string, password: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function inviteAndAccept(
  app: TestApp,
  ownerCookie: string,
  person: { email: string; name: string; password: string }
): Promise<void> {
  const inv = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: person.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: person.name, password: person.password })
  );
  expect(accepted.status).toBe(200);
}

async function memberIdOf(
  app: TestApp,
  cookie: string,
  email: string
): Promise<{ id: string; userId: string }> {
  const { members } = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie, 'x-forwarded-for': nextIp() } })
  );
  const m = members.find((x: { email: string }) => x.email === email);
  expect(m).toBeTruthy();
  return { id: m.id, userId: m.userId };
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('with SUPERADMIN_EMAILS set', () => {
  let app: TestApp;
  let connectionString: string;
  let ownerCookie: string;
  let rootCookie: string;

  beforeAll(async () => {
    connectionString = await createDatabase(container, 'bg_armed');
    // Deliberately messy allowlist value: mixed case + stray whitespace must
    // still match (parse trims + lowercases; Better Auth stores lowercase).
    app = await createTestApp(connectionString, { SUPERADMIN_EMAILS: ' Root@bg.test , second@bg.test ' });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'BG', owner: OWNER })
    );
    ownerCookie = await signIn(app, OWNER.email, OWNER.password);
    await inviteAndAccept(app, ownerCookie, ROOT);
    await inviteAndAccept(app, ownerCookie, ADMIN);
    await inviteAndAccept(app, ownerCookie, MEMBER);
    const admin = await memberIdOf(app, ownerCookie, ADMIN.email);
    const promoted = await app.app.request(`/api/v1/members/${admin.id}`, {
      ...json({ role: 'admin' }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(promoted.status).toBe(200);
    rootCookie = await signIn(app, ROOT.email, ROOT.password);
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('rejects an unauthenticated call with 401', async () => {
    const res = await app.app.request('/api/v1/admin/break-glass/claim-ownership', json({}));
    expect(res.status).toBe(401);
  });

  it('rejects the allowlisted caller while their email is UNVERIFIED', async () => {
    // ROOT accepted via the admin-visible copyable link — honestly unverified.
    const { rows } = await app.db.pool.query(`SELECT email_verified FROM "user" WHERE email = $1`, [
      ROOT.email
    ]);
    expect(rows[0].email_verified).toBe(false);
    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({}, { cookie: rootCookie })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('forbidden');
  });

  it('rejects verified sessions whose email is NOT on the allowlist', async () => {
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = ANY($1)`, [
      [OWNER.email, ADMIN.email, MEMBER.email]
    ]);
    for (const person of [ADMIN, MEMBER]) {
      const cookie = await signIn(app, person.email, person.password);
      const res = await app.app.request('/api/v1/admin/break-glass/claim-ownership', json({}, { cookie }));
      expect(res.status).toBe(403);
    }
  });

  it('rejects a MACHINE principal fail-closed even when its owner is allowlisted + verified', async () => {
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [ROOT.email]);
    // Key minted BY the superadmin themselves — ownership must not transfer.
    const minted = await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'root-key', scopes: [host.scopes.read, host.scopes.write] }, { cookie: rootCookie })
    );
    expect(minted.status).toBe(201);
    const { key } = await readJson(minted);
    const res = await app.app.request('/api/v1/admin/break-glass/claim-ownership', {
      ...json({}),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': nextIp(),
        authorization: `Bearer ${key}`
      }
    });
    expect(res.status).toBe(403);
    // The fail-closed scope gate, not the handler: the path is unlisted.
    expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
  });

  it('claim-ownership recovers a workspace with NO active owner (audited, trigger satisfied)', async () => {
    // Brick the workspace the only way possible: bypass the 0009 trigger the
    // way an operator's broken migration/surgery would (the trigger blocks
    // every normal path to a zero-owner state).
    const surgical = new pg.Client({ connectionString });
    await surgical.connect();
    try {
      await surgical.query('BEGIN');
      await surgical.query(`SET LOCAL session_replication_role = replica`);
      await surgical.query(
        `UPDATE workspace_members SET role = 'member', is_active = false WHERE role = 'owner'`
      );
      await surgical.query('COMMIT');
    } finally {
      await surgical.end();
    }
    const owners = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM workspace_members WHERE role = 'owner' AND is_active = true`
    );
    expect(owners.rows[0].n).toBe(0);

    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({}, { cookie: rootCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.role).toBe('owner');
    expect(body.isActive).toBe(true);
    expect(body.created).toBe(false); // ROOT already had a (member) row — promoted, not created

    // The claim is real: the session now acts as an active owner.
    const me = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie: rootCookie, 'x-forwarded-for': nextIp() } })
    );
    expect(me.role).toBe('owner');

    // Audited with the superadmin identity and before/after state.
    const audit = await app.db.pool.query(
      `SELECT actor_user_id, actor_via, metadata FROM audit_log WHERE action = 'break_glass.claim_ownership' ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_via).toBe('session');
    expect(audit.rows[0].metadata.superadminEmail).toBe(ROOT.email);
    // ROOT's own row was an ACTIVE MEMBER before the claim (the surgery only
    // demoted the owners) — the claim promoted it in place.
    expect(audit.rows[0].metadata.before).toEqual({ role: 'member', isActive: true });
    expect(audit.rows[0].metadata.after).toEqual({ role: 'owner', isActive: true });
  });

  it('claim-ownership for a NAMED user reactivates and promotes them', async () => {
    const member = await memberIdOf(app, rootCookie, MEMBER.email);
    // Deactivate the member first (root is an active owner now).
    const deactivated = await app.app.request(`/api/v1/members/${member.id}`, {
      ...json({ isActive: false }, { cookie: rootCookie }),
      method: 'PATCH'
    });
    expect(deactivated.status).toBe(200);

    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ userId: member.userId }, { cookie: rootCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.userId).toBe(member.userId);
    expect(body.role).toBe('owner');
    expect(body.isActive).toBe(true);
    expect(body.created).toBe(false);
  });

  it('claim-ownership CREATES the membership for a membership-less superadmin session', async () => {
    // SECOND joins, then loses their membership row entirely (the orphaned
    // state a lost setup race produces): can sign in, but reaches no
    // workspace — /me is the zero-membership zero state (200, empty list),
    // real workspace endpoints 401. Break-glass rescues exactly this.
    await inviteAndAccept(app, rootCookie, SECOND);
    await app.db.pool.query(
      `DELETE FROM workspace_members WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [SECOND.email]
    );
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [SECOND.email]);
    const secondCookie = await signIn(app, SECOND.email, SECOND.password);
    const orphaned = await app.app.request('/api/v1/me', {
      headers: { cookie: secondCookie, 'x-forwarded-for': nextIp() }
    });
    expect(orphaned.status).toBe(200);
    expect((await readJson(orphaned)).workspaces).toEqual([]);
    const noAccess = await app.app.request(host.probeRoute, {
      headers: { cookie: secondCookie, 'x-forwarded-for': nextIp() }
    });
    expect(noAccess.status).toBe(401);

    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({}, { cookie: secondCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.created).toBe(true);
    expect(body.role).toBe('owner');

    const me = await app.app.request('/api/v1/me', {
      headers: { cookie: secondCookie, 'x-forwarded-for': nextIp() }
    });
    expect(me.status).toBe(200);
    expect((await readJson(me)).role).toBe('owner');
  });

  it('claim-ownership answers 404 for an unknown named target', async () => {
    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ userId: 'no-such-user' }, { cookie: rootCookie })
    );
    expect(res.status).toBe(404);
  });

  it('reset-2fa clears the target factor for a superadmin and 403s everyone else', async () => {
    const member = await memberIdOf(app, rootCookie, MEMBER.email);
    // Enrolled state, set directly: two-factor.test.ts proves enrollment; this
    // suite proves the CLEARING (row + flag).
    await app.db.pool.query(
      `INSERT INTO two_factor (id, secret, backup_codes, user_id) VALUES ('bg-2fa-1', 'sekret', 'codes', $1)`,
      [member.userId]
    );
    await app.db.pool.query(`UPDATE "user" SET two_factor_enabled = true WHERE id = $1`, [member.userId]);

    // A verified admin who is NOT allowlisted cannot reset anyone's 2FA.
    const adminCookie = await signIn(app, ADMIN.email, ADMIN.password);
    const asAdmin = await app.app.request(
      '/api/v1/admin/break-glass/reset-2fa',
      json({ userId: member.userId }, { cookie: adminCookie })
    );
    expect(asAdmin.status).toBe(403);

    const res = await app.app.request(
      '/api/v1/admin/break-glass/reset-2fa',
      json({ userId: member.userId }, { cookie: rootCookie })
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).hadTwoFactor).toBe(true);

    const rows = await app.db.pool.query(`SELECT count(*)::int AS n FROM two_factor WHERE user_id = $1`, [
      member.userId
    ]);
    expect(rows.rows[0].n).toBe(0);
    const flag = await app.db.pool.query(`SELECT two_factor_enabled FROM "user" WHERE id = $1`, [
      member.userId
    ]);
    expect(flag.rows[0].two_factor_enabled).toBe(false);

    const audit = await app.db.pool.query(
      `SELECT metadata FROM audit_log WHERE action = 'break_glass.reset_two_factor' ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.targetUserId).toBe(member.userId);
    expect(audit.rows[0].metadata.hadTwoFactor).toBe(true);

    // Idempotent: a second reset is a truthful no-op.
    const again = await app.app.request(
      '/api/v1/admin/break-glass/reset-2fa',
      json({ userId: member.userId }, { cookie: rootCookie })
    );
    expect(again.status).toBe(200);
    expect((await readJson(again)).hadTwoFactor).toBe(false);
  });

  it('claim-ownership stamps origin=local on BOTH the insert and the conflict path (BG-1, PRDCT-1356)', async () => {
    // Conflict path: a hub-projected row (the shape the cloud reconciler
    // sweeps when the hub stops asserting it), seeded raw so the test does
    // not depend on what earlier cases did to the fixture members.
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('bg-hub-user', 'Hub Row', 'hubrow@bg.test', true, now(), now())`
    );
    const ws = (
      await app.db.pool.query<{ id: string }>(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`)
    ).rows[0]!;
    const seeded = await app.db.pool.query<{ id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, 'bg-hub-user', 'member', 'hub', true) RETURNING id`,
      [ws.id]
    );
    const promoted = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ userId: 'bg-hub-user', workspaceId: ws.id }, { cookie: rootCookie })
    );
    expect(promoted.status).toBe(200);
    const { rows } = await app.db.pool.query<{ origin: string; role: string }>(
      `SELECT origin, role FROM workspace_members WHERE id = $1`,
      [seeded.rows[0]!.id]
    );
    expect(rows).toEqual([{ origin: 'local', role: 'owner' }]);
    // Insert path: root has no membership row on a fresh workspace — claim
    // it and read the origin back.
    const fresh = await app.db.pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('BG fresh') RETURNING id`
    );
    const claimed = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ workspaceId: fresh.rows[0]!.id }, { cookie: rootCookie })
    );
    expect(claimed.status).toBe(200);
    const inserted = await app.db.pool.query<{ origin: string }>(
      `SELECT origin FROM workspace_members WHERE id = $1`,
      [(await readJson(claimed)).memberId]
    );
    expect(inserted.rows).toEqual([{ origin: 'local' }]);
  });
});

describe('with SUPERADMIN_EMAILS unset (default)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'bg_dormant'));
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'BG2', owner: ROOT })
    );
    // Even a VERIFIED owner whose email would be on a typical allowlist gets
    // nothing: no env = no superadmin exists, the capability is dormant.
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [ROOT.email]);
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('403s every session on both break-glass endpoints', async () => {
    const cookie = await signIn(app, ROOT.email, ROOT.password);
    const claim = await app.app.request('/api/v1/admin/break-glass/claim-ownership', json({}, { cookie }));
    expect(claim.status).toBe(403);
    const reset = await app.app.request(
      '/api/v1/admin/break-glass/reset-2fa',
      json({ userId: 'anyone' }, { cookie })
    );
    expect(reset.status).toBe(403);
  });

  it('401s unauthenticated callers (no session, no capability)', async () => {
    const res = await app.app.request('/api/v1/admin/break-glass/claim-ownership', json({}));
    expect(res.status).toBe(401);
  });
});

describe('multi-workspace targeting (ADR 014)', () => {
  const ROOT3 = { email: 'root@bg3.test', name: 'BG3 Root', password: 'bg3-root-password-123' };
  let app: TestApp;
  let rootCookie: string;
  let w2 = '';

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'bg_multi'), {
      SUPERADMIN_EMAILS: ROOT3.email
    });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'BG3', owner: ROOT3 })
    );
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [ROOT3.email]);
    // A second workspace owned by someone else — root has NO standing in it.
    const other = await app.auth.api.signUpEmail({
      body: { email: 'other@bg3.test', password: 'bg3-other-password-12', name: 'BG3 Other' }
    });
    w2 = (await app.registry.workspaces.create('BG3 Second', other.user.id)).workspaceId;
    rootCookie = await signIn(app, ROOT3.email, ROOT3.password);
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('refuses to guess: several workspaces and no workspaceId → 400 workspace_required', async () => {
    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({}, { cookie: rootCookie })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('workspace_required');
  });

  it('claims ownership in the EXPLICIT workspace', async () => {
    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ workspaceId: w2 }, { cookie: rootCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(w2);
    expect(body.role).toBe('owner');
    expect(body.created).toBe(true);
    const { rows } = await app.db.pool.query(
      `SELECT role, is_active FROM workspace_members wm
       JOIN "user" u ON u.id = wm.user_id
       WHERE u.email = $1 AND wm.workspace_id = $2`,
      [ROOT3.email, w2]
    );
    expect(rows).toEqual([{ role: 'owner', is_active: true }]);
  });

  it('404s a workspace that does not exist', async () => {
    const res = await app.app.request(
      '/api/v1/admin/break-glass/claim-ownership',
      json({ workspaceId: '00000000-0000-4000-8000-000000000000' }, { cookie: rootCookie })
    );
    expect(res.status).toBe(404);
  });
});
