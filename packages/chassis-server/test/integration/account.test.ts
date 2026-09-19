import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { desc, eq } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Self-service account management (WS3 feature C): change your own name and
 * password through Better-Auth-native routes, mounted under /api/v1/auth.
 * Email change (M6) needs a delivering email driver; this app has none, so
 * the endpoint answers 400 — the full flows live in email-change.test.ts.
 */

const OWNER = { email: 'owner@acct.test', name: 'Acct Owner', password: 'acct-owner-password-12' };

let container: StartedPostgreSqlContainer;
let app: TestApp;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

const withCookie = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string): Promise<Response> {
  return app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'acct'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Acct', owner: OWNER })
  );
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('profile: change your own name', () => {
  it('updates the name and /me reflects it', async () => {
    const cookie = extractCookie(await signIn(OWNER.email, OWNER.password));
    const res = await app.app.request(
      '/api/v1/auth/update-user',
      withCookie(cookie, { name: 'Renamed Owner' })
    );
    expect(res.status).toBe(200);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.name).toBe('Renamed Owner');
  });
});

describe('change password', () => {
  it('rejects a wrong current password', async () => {
    const cookie = extractCookie(await signIn(OWNER.email, OWNER.password));
    const res = await app.app.request(
      '/api/v1/auth/change-password',
      withCookie(cookie, { currentPassword: 'not-the-password', newPassword: 'acct-owner-brandnew-1' })
    );
    expect(res.status).toBe(400);
  });

  it('changes the password, revokes other sessions, and lands in the audit log', async () => {
    const sessionA = extractCookie(await signIn(OWNER.email, OWNER.password));
    const sessionB = extractCookie(await signIn(OWNER.email, OWNER.password));
    const newPassword = 'acct-owner-changed-42';

    const res = await app.app.request(
      '/api/v1/auth/change-password',
      withCookie(sessionA, {
        currentPassword: OWNER.password,
        newPassword,
        revokeOtherSessions: true
      })
    );
    expect(res.status).toBe(200);

    // The other session is dead; sign-in works only with the new password.
    expect((await app.app.request('/api/v1/me', { headers: { cookie: sessionB } })).status).toBe(401);
    expect((await signIn(OWNER.email, OWNER.password)).status).toBe(401);
    expect((await signIn(OWNER.email, newPassword)).status).toBe(200);

    // The change was audited (Better Auth routes bypass the /api/v1 middleware;
    // an after-hook records it).
    const [row] = await app.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'user.password_change'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(row).toBeTruthy();
  });
});

describe('change email without an email driver', () => {
  it('answers 400 (self-serve change needs a delivering driver; see email-change.test.ts)', async () => {
    const cookie = extractCookie(await signIn(OWNER.email, 'acct-owner-changed-42'));
    const res = await app.app.request(
      '/api/v1/auth/change-email',
      withCookie(cookie, { newEmail: 'new@acct.test' })
    );
    expect(res.status).toBe(400);
  });
});
