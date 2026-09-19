import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Password reset / account recovery (WS3 feature B):
 *  - self-serve reset is closed (400) with no email driver, open with one;
 *  - the admin-generated reset link works with NO email driver (the SMTP-free
 *    recovery path), is single-use, revokes the target's sessions, and is
 *    authorization-gated (member 403, admin-on-owner 403);
 *  - the self-serve flow does not leak whether an email exists.
 */

const OWNER = { email: 'owner@rec.test', name: 'Rec Owner', password: 'rec-owner-password-12' };
const MEMBER = { email: 'member@rec.test', name: 'Rec Member', password: 'rec-member-password-1' };

let container: StartedPostgreSqlContainer;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function signIn(app: TestApp, email: string, password: string): Promise<Response> {
  return app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('no email driver (default)', () => {
  let app: TestApp;
  let ownerCookie: string;
  let memberId: string;
  let adminMemberId: string;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'rec_none'));
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Rec', owner: OWNER })
    );
    ownerCookie = extractCookie(await signIn(app, OWNER.email, OWNER.password));

    // Add a member (invite → accept) and a separate admin.
    const inv = await readJson(
      await app.app.request('/api/v1/invitations', {
        ...json({ email: MEMBER.email, role: 'member' }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie }
      })
    );
    const token = (inv.acceptUrl as string).split('/invite/')[1]!;
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: MEMBER.name, password: MEMBER.password })
    );

    const admin = { email: 'admin@rec.test', name: 'Rec Admin', password: 'rec-admin-password-12' };
    const inv2 = await readJson(
      await app.app.request('/api/v1/invitations', {
        ...json({ email: admin.email, role: 'member' }),
        headers: { 'content-type': 'application/json', cookie: ownerCookie }
      })
    );
    const token2 = (inv2.acceptUrl as string).split('/invite/')[1]!;
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: token2, name: admin.name, password: admin.password })
    );

    const { members } = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    memberId = members.find((m: { email: string }) => m.email === MEMBER.email).id;
    adminMemberId = members.find((m: { email: string }) => m.email === admin.email).id;
    // Promote the admin.
    await app.app.request(`/api/v1/members/${adminMemberId}`, {
      ...json({ role: 'admin' }),
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('reports passwordReset: false in discovery and closes self-serve reset', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.passwordReset).toBe(false);

    const res = await app.app.request(
      '/api/v1/auth/request-password-reset',
      json({ email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' })
    );
    expect(res.status).toBe(400); // RESET_PASSWORD_DISABLED
  });

  it('admin mints a working single-use reset link that revokes the target sessions', async () => {
    // The member has a live session before the reset.
    const memberCookie = extractCookie(await signIn(app, MEMBER.email, MEMBER.password));
    expect((await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } })).status).toBe(200);

    const minted = await app.app.request(`/api/v1/members/${memberId}/reset-link`, {
      method: 'POST',
      headers: { cookie: ownerCookie }
    });
    expect(minted.status).toBe(200);
    const { resetUrl } = await readJson(minted);
    const token = new URL(resetUrl).searchParams.get('token')!;
    expect(token).toBeTruthy();

    const newPassword = 'rec-member-new-password-9';
    const reset = await app.app.request('/api/v1/auth/reset-password', json({ newPassword, token }));
    expect(reset.status).toBe(200);

    // Old password is dead, the new one works.
    expect((await signIn(app, MEMBER.email, MEMBER.password)).status).toBe(401);
    expect((await signIn(app, MEMBER.email, newPassword)).status).toBe(200);

    // The token is single-use.
    const reuse = await app.app.request('/api/v1/auth/reset-password', json({ newPassword, token }));
    expect(reuse.status).toBe(400);

    // The pre-reset session was revoked.
    expect((await app.app.request('/api/v1/me', { headers: { cookie: memberCookie } })).status).toBe(401);
  });

  it('refuses reset-link minting to non-admins and admin-on-owner', async () => {
    // A plain member cannot mint at all (403 from the role gate).
    const memberCookie = extractCookie(await signIn(app, MEMBER.email, 'rec-member-new-password-9'));
    const asMember = await app.app.request(`/api/v1/members/${memberId}/reset-link`, {
      method: 'POST',
      headers: { cookie: memberCookie }
    });
    expect(asMember.status).toBe(403);

    // An admin (non-owner) cannot mint for an owner.
    const admin = { email: 'admin@rec.test', password: 'rec-admin-password-12' };
    const adminCookie = extractCookie(await signIn(app, admin.email, admin.password));
    const { members } = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: adminCookie } })
    );
    const ownerId = members.find((m: { email: string }) => m.email === OWNER.email).id;
    const asAdmin = await app.app.request(`/api/v1/members/${ownerId}/reset-link`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    expect(asAdmin.status).toBe(403);
  });
});

describe('with an email driver', () => {
  let app: TestApp;

  beforeAll(async () => {
    // SMTP points at a dead port — sends fail, but Better Auth runs them in the
    // background (errors swallowed), so the endpoint still answers generically
    // and the verification row is created regardless.
    app = await createTestApp(await createDatabase(container, 'rec_smtp'), {
      EMAIL_DRIVER: 'smtp',
      SMTP_URL: 'smtp://127.0.0.1:1',
      EMAIL_FROM: 'Rec <noreply@rec.test>'
    });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'RecSmtp', owner: OWNER })
    );
  });

  afterAll(async () => {
    await app.stop();
  });

  it('reports passwordReset: true and completes a self-serve reset', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.passwordReset).toBe(true);

    const res = await app.app.request(
      '/api/v1/auth/request-password-reset',
      json({ email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' })
    );
    expect(res.status).toBe(200);

    // Read the token the plugin stored, then complete the reset.
    const { rows } = await app.db.pool.query<{ identifier: string }>(
      `SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`
    );
    const token = rows[0]!.identifier.replace('reset-password:', '');
    const newPassword = 'rec-owner-new-password-77';
    const reset = await app.app.request('/api/v1/auth/reset-password', json({ newPassword, token }));
    expect(reset.status).toBe(200);
    expect((await signIn(app, OWNER.email, newPassword)).status).toBe(200);
  });

  it('does not reveal whether an email exists (identical 200 for unknown)', async () => {
    const before = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
    );
    const res = await app.app.request(
      '/api/v1/auth/request-password-reset',
      json({ email: 'nobody@rec.test', redirectTo: 'http://localhost:3000/reset-password' })
    );
    expect(res.status).toBe(200);
    const after = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
    );
    // No new reset token minted for a non-existent account.
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('rate-limits repeated reset requests', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 10 && !sawRateLimit; i++) {
      const r = await app.app.request(
        '/api/v1/auth/request-password-reset',
        json({ email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' })
      );
      if (r.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});
