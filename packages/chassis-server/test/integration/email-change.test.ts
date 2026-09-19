import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { desc, eq } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Email change (M6):
 *  - with a delivering driver, self-serve change is open: the UNVERIFIED user
 *    (the template's common case) gets the single-leg flow (one verification
 *    mail to the NEW address); a VERIFIED user gets the two-leg flow
 *    (confirmation to OLD, then verification to NEW);
 *  - a duplicate target email answers an identical no-op 200 (no enumeration);
 *  - with no driver the endpoint stays closed (400) and the admin-generated
 *    change link is the SMTP-free path — sign-in-equivalent, single-use, and
 *    authorization-gated;
 *  - discovery reports auth.emailChange per the driver;
 *  - /auth/change-email sits behind the passwordReset rate-limit wall.
 *
 * Change-email tokens are STATELESS HS256 JWTs (never stored), so the
 * delivering-driver tests capture links from a RecordingEmailDriver.
 */

const OWNER = { email: 'owner@ec.test', name: 'Ec Owner', password: 'ec-owner-password-123' };

let container: StartedPostgreSqlContainer;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

/** POST helper with cookie + a per-test XFF ip (isolates rate-limit buckets). */
const withCookie = (cookie: string, body: unknown, ip: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': ip },
  body: JSON.stringify(body)
});

async function signIn(app: TestApp, email: string, password: string): Promise<Response> {
  return app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
}

/** Invite + accept a user; returns nothing (sign in to use them). */
async function addUser(
  app: TestApp,
  ownerCookie: string,
  user: { email: string; name: string; password: string }
): Promise<void> {
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', {
      ...json({ email: user.email, role: 'member' }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    })
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: user.name, password: user.password })
  );
  expect(accepted.status).toBe(200);
}

async function userRow(app: TestApp, email: string): Promise<{ email: string; verified: boolean } | null> {
  const { rows } = await app.db.pool.query<{ email: string; email_verified: boolean }>(
    `SELECT email, email_verified FROM "user" WHERE email = $1`,
    [email]
  );
  return rows[0] ? { email: rows[0].email, verified: rows[0].email_verified } : null;
}

/** The first http(s) URL in a recorded mail's text body. */
function linkOf(mail: { text?: string }): string {
  const m = /https?:\/\/\S+/.exec(mail.text ?? '');
  if (!m) throw new Error(`no URL in mail text: ${mail.text}`);
  return m[0];
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('with a delivering email driver (recording)', () => {
  let app: TestApp;
  let mailer: RecordingEmailDriver;
  let ownerCookie: string;

  const MEMBER_A = { email: 'membera@ec.test', name: 'Ec MemberA', password: 'ec-membera-password-1' };
  const MEMBER_B = { email: 'memberb@ec.test', name: 'Ec MemberB', password: 'ec-memberb-password-1' };
  const OWNER_NEW_EMAIL = 'owner2@ec.test';

  beforeAll(async () => {
    mailer = new RecordingEmailDriver();
    app = await createTestApp(await createDatabase(container, 'ec_rec'), {}, { email: mailer });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Ec', owner: OWNER })
    );
    ownerCookie = extractCookie(await signIn(app, OWNER.email, OWNER.password));
    await addUser(app, ownerCookie, MEMBER_A);
    await addUser(app, ownerCookie, MEMBER_B);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('reports emailChange: true in discovery', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.emailChange).toBe(true);
  });

  it('unverified user (the common case): single leg — ONE mail to the NEW address', async () => {
    // Setup now mints the operator verified (D9 — the cloud trusted-link
    // bootstrap); an unverified user WITH a session is a manufactured state
    // here, standing in for the pre-D9 common case.
    await app.db.pool.query(`UPDATE "user" SET email_verified = false WHERE email = $1`, [OWNER.email]);
    mailer.sent.length = 0;

    const res = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(ownerCookie, { newEmail: OWNER_NEW_EMAIL, callbackURL: '/account' }, '10.1.0.1')
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).status).toBe(true);

    // Exactly one mail, to the NEW address (no confirmation leg for unverified).
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(OWNER_NEW_EMAIL);
    expect(mailer.sent[0]!.subject).toContain('Verify');

    // Nothing changed yet — the link does the change.
    expect((await userRow(app, OWNER.email))?.verified).toBe(false);

    // Consume the link (browser flow: still signed in). It redirects to the
    // callbackURL and flips email + emailVerified.
    const verify = await app.app.request(linkOf(mailer.sent[0]!), { headers: { cookie: ownerCookie } });
    expect(verify.status).toBeGreaterThanOrEqual(300);
    expect(verify.status).toBeLessThan(400);
    expect(verify.headers.get('location')).toContain('/account');

    expect(await userRow(app, OWNER.email)).toBeNull();
    expect(await userRow(app, OWNER_NEW_EMAIL)).toEqual({ email: OWNER_NEW_EMAIL, verified: true });

    // Old sessions survive the change (nothing is revoked).
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
    expect(me.user.email).toBe(OWNER_NEW_EMAIL);

    // Sign-in works with the new email (same password), not the old one.
    expect((await signIn(app, OWNER_NEW_EMAIL, OWNER.password)).status).toBe(200);
    expect((await signIn(app, OWNER.email, OWNER.password)).status).toBe(401);

    // Both credential events were audited (request + landing).
    for (const action of ['user.email_change_request', 'user.email_change']) {
      const [row] = await app.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, action))
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(row, `audit row ${action}`).toBeTruthy();
    }
  });

  it('verified user: two legs — confirm at the OLD address, verify at the NEW', async () => {
    await app.db.pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [MEMBER_A.email]);
    const cookie = extractCookie(await signIn(app, MEMBER_A.email, MEMBER_A.password));
    const newEmail = 'membera2@ec.test';
    mailer.sent.length = 0;

    const res = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(cookie, { newEmail, callbackURL: '/account' }, '10.1.0.2')
    );
    expect(res.status).toBe(200);

    // Leg 1: confirmation to the OLD address.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(MEMBER_A.email);
    expect(mailer.sent[0]!.subject).toContain('Confirm');

    // Consuming it does not change the email yet — it sends leg 2 to the NEW.
    const confirm = await app.app.request(linkOf(mailer.sent[0]!), { headers: { cookie } });
    expect(confirm.status).toBeGreaterThanOrEqual(300);
    expect(confirm.status).toBeLessThan(400);
    expect((await userRow(app, MEMBER_A.email))?.email).toBe(MEMBER_A.email);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.to).toBe(newEmail);
    expect(mailer.sent[1]!.subject).toContain('Verify');

    // Leg 2 lands the change.
    const verify = await app.app.request(linkOf(mailer.sent[1]!), { headers: { cookie } });
    expect(verify.status).toBeGreaterThanOrEqual(300);
    expect(verify.status).toBeLessThan(400);
    expect(await userRow(app, MEMBER_A.email)).toBeNull();
    expect(await userRow(app, newEmail)).toEqual({ email: newEmail, verified: true });
  });

  it('does not reveal whether an email exists: duplicate target is a mail-free no-op 200', async () => {
    const cookie = extractCookie(await signIn(app, MEMBER_B.email, MEMBER_B.password));
    mailer.sent.length = 0;

    const res = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(cookie, { newEmail: OWNER_NEW_EMAIL, callbackURL: '/account' }, '10.1.0.3')
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).status).toBe(true);
    expect(mailer.sent).toHaveLength(0);
    expect((await userRow(app, MEMBER_B.email))?.email).toBe(MEMBER_B.email);
  });

  it('rate-limits /auth/change-email on the 6th call', async () => {
    const cookie = extractCookie(await signIn(app, MEMBER_B.email, MEMBER_B.password));
    for (let i = 1; i <= 5; i++) {
      // Duplicate-target no-ops: nothing changes, nothing is mailed.
      const r = await app.app.request(
        '/api/v1/auth/change-email',
        withCookie(cookie, { newEmail: OWNER_NEW_EMAIL, callbackURL: '/account' }, '10.1.0.99')
      );
      expect(r.status, `call ${i}`).toBe(200);
    }
    const sixth = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(cookie, { newEmail: OWNER_NEW_EMAIL, callbackURL: '/account' }, '10.1.0.99')
    );
    expect(sixth.status).toBe(429);
  });
});

describe('no email driver (default): the admin change link', () => {
  let app: TestApp;
  let ownerCookie: string;
  let memberId: string;
  let ownerId: string;

  const MEMBER = { email: 'member@ecadm.test', name: 'Adm Member', password: 'adm-member-password-1' };
  const ADMIN = { email: 'admin@ecadm.test', name: 'Adm Admin', password: 'adm-admin-password-12' };
  const MEMBER_NEW_EMAIL = 'member-new@ecadm.test';

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'ec_none'));
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'EcAdm', owner: OWNER })
    );
    ownerCookie = extractCookie(await signIn(app, OWNER.email, OWNER.password));
    await addUser(app, ownerCookie, MEMBER);
    await addUser(app, ownerCookie, ADMIN);

    const { members } = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    memberId = members.find((m: { email: string }) => m.email === MEMBER.email).id;
    ownerId = members.find((m: { email: string }) => m.email === OWNER.email).id;
    const adminMemberId = members.find((m: { email: string }) => m.email === ADMIN.email).id;
    await app.app.request(`/api/v1/members/${adminMemberId}`, {
      ...json({ role: 'admin' }),
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('reports emailChange: false in discovery and closes self-serve change', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.emailChange).toBe(false);

    const res = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(ownerCookie, { newEmail: 'else@ecadm.test' }, '10.2.0.1')
    );
    expect(res.status).toBe(400);
  });

  it('admin mints a single-use link that changes the email AND signs the member in', async () => {
    const minted = await app.app.request(`/api/v1/members/${memberId}/change-email-link`, {
      ...json({ newEmail: MEMBER_NEW_EMAIL }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    expect(minted.status).toBe(200);
    const link = await readJson(minted);
    expect(link.newEmail).toBe(MEMBER_NEW_EMAIL);
    expect(link.verifyUrl).toContain('/api/v1/auth/verify-email?token=');
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The mint is audited.
    const [audit] = await app.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'member.change_email_link'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit).toBeTruthy();

    // Consumed LOGGED OUT: it redirects to /account and creates a session
    // for the member — the sign-in-equivalent property the dialog warns about.
    const verify = await app.app.request(link.verifyUrl);
    expect(verify.status).toBeGreaterThanOrEqual(300);
    expect(verify.status).toBeLessThan(400);
    expect(verify.headers.get('location')).toContain('/account');
    const sessionCookie = extractCookie(verify);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: sessionCookie } }));
    expect(me.user.email).toBe(MEMBER_NEW_EMAIL);

    const row = await app.db.pool.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM "user" WHERE email = $1`,
      [MEMBER_NEW_EMAIL]
    );
    expect(row.rows[0]!.email_verified).toBe(true);

    // Single-use in effect: the old email no longer resolves, so a replay
    // redirects with an error instead of changing anything.
    const reuse = await app.app.request(link.verifyUrl);
    expect(reuse.status).toBeGreaterThanOrEqual(300);
    expect(reuse.status).toBeLessThan(400);
    expect(reuse.headers.get('location')).toContain('error=');
  });

  it('refuses minting to non-admins, admin-on-owner, unknown members, and taken emails', async () => {
    // A plain member cannot mint at all (the explicit 3-segment gate).
    const memberCookie = extractCookie(await signIn(app, MEMBER_NEW_EMAIL, MEMBER.password));
    const asMember = await app.app.request(`/api/v1/members/${memberId}/change-email-link`, {
      ...json({ newEmail: 'whatever@ecadm.test' }),
      headers: { 'content-type': 'application/json', cookie: memberCookie }
    });
    expect(asMember.status).toBe(403);

    // An admin (non-owner) cannot mint for an owner.
    const adminCookie = extractCookie(await signIn(app, ADMIN.email, ADMIN.password));
    const asAdmin = await app.app.request(`/api/v1/members/${ownerId}/change-email-link`, {
      ...json({ newEmail: 'whatever@ecadm.test' }),
      headers: { 'content-type': 'application/json', cookie: adminCookie }
    });
    expect(asAdmin.status).toBe(403);

    // Unknown member id → 404.
    const unknown = await app.app.request(
      `/api/v1/members/00000000-0000-0000-0000-000000000000/change-email-link`,
      {
        ...json({ newEmail: 'whatever@ecadm.test' }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie }
      }
    );
    expect(unknown.status).toBe(404);

    // An email that already belongs to a user → 409 email_taken.
    const taken = await app.app.request(`/api/v1/members/${memberId}/change-email-link`, {
      ...json({ newEmail: ADMIN.email.toUpperCase() }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    expect(taken.status).toBe(409);
    expect((await readJson(taken)).error.code).toBe('email_taken');
  });
});

describe('with EMAIL_DRIVER configured (env path)', () => {
  let app: TestApp;

  beforeAll(async () => {
    // Dead SMTP port — delivery would fail, but discovery only reflects the
    // configured driver.
    app = await createTestApp(await createDatabase(container, 'ec_smtp'), {
      EMAIL_DRIVER: 'smtp',
      SMTP_URL: 'smtp://127.0.0.1:1',
      EMAIL_FROM: 'Ec <noreply@ec.test>'
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('flips discovery to emailChange: true', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.emailChange).toBe(true);
  });
});
