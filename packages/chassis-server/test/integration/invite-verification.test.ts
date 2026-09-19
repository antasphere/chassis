import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
 * Email verification on invite acceptance (ADR 009). Each invitation carries
 * TWO tokens for one row: the copyable link returned to the inviter, and a
 * second token that exists ONLY inside the invitation email. Honesty rule:
 *  - accepting with the EMAILED token proves control of the invited mailbox
 *    (the admin never saw that token) → emailVerified = true;
 *  - accepting with the admin-visible copyable link proves nothing → the
 *    account stays unverified, and (driver delivering) Better Auth's
 *    verification mail fires so the address can still be proven;
 *  - with no email driver there is no emailed token in flight and no
 *    verification mail — the account is unverified, documented, never
 *    silently flipped.
 */

const OWNER = { email: 'owner@iv.test', name: 'Iv Owner', password: 'iv-owner-password-123' };

let container: StartedPostgreSqlContainer;

const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body)
});

async function verifiedOf(app: TestApp, email: string): Promise<boolean | null> {
  const { rows } = await app.db.pool.query<{ email_verified: boolean }>(
    `SELECT email_verified FROM "user" WHERE email = $1`,
    [email]
  );
  return rows[0] ? rows[0].email_verified : null;
}

/** The invite-page token inside a recorded mail (the /invite/<token> link). */
function inviteTokenOf(mail: { text?: string }): string {
  const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text ?? '');
  if (!m) throw new Error(`no invite link in mail text: ${mail.text}`);
  return m[1]!;
}

beforeAll(async () => {
  container = await startPostgres();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('with a delivering email driver', () => {
  let app: TestApp;
  let mailer: RecordingEmailDriver;
  let ownerCookie: string;

  beforeAll(async () => {
    mailer = new RecordingEmailDriver();
    app = await createTestApp(await createDatabase(container, 'iv_rec'), {}, { email: mailer });
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Iv', owner: OWNER })
    );
    ownerCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
  });

  afterAll(async () => {
    await app.stop();
  });

  it('the emailed token differs from the admin copyable link, and both resolve via lookup', async () => {
    mailer.sent.length = 0;
    const created = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'alice@iv.test', role: 'member' }, ownerCookie)
      )
    );
    expect(created.emailSent).toBe(true);
    const adminToken = (created.acceptUrl as string).split('/invite/')[1]!;
    const mailToken = inviteTokenOf(mailer.sent[0]!);
    expect(mailToken).not.toBe(adminToken);

    for (const token of [adminToken, mailToken]) {
      const lookup = await app.app.request(`/api/v1/invitations/lookup?token=${token}`);
      expect(lookup.status).toBe(200);
      expect((await readJson(lookup)).email).toBe('alice@iv.test');
    }
  });

  it('accepting with the EMAILED token proves the mailbox → emailVerified = true', async () => {
    // The invitation from the previous test is still live; redeem its mail token.
    const mailToken = inviteTokenOf(mailer.sent[0]!);
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: mailToken, name: 'Alice', password: 'alice-password-12345' })
    );
    expect(res.status).toBe(200);
    expect(await verifiedOf(app, 'alice@iv.test')).toBe(true);
  });

  it('accepting with the admin copyable link does NOT get silently verified — the verification mail fires instead', async () => {
    mailer.sent.length = 0;
    const created = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'bob@iv.test', role: 'member' }, ownerCookie)
      )
    );
    const adminToken = (created.acceptUrl as string).split('/invite/')[1]!;

    mailer.sent.length = 0; // drop the invite mail — watch for the verification mail
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: adminToken, name: 'Bob', password: 'bob-password-123456' })
    );
    expect(res.status).toBe(200);
    // Not verified: link possession proves nothing about the address.
    expect(await verifiedOf(app, 'bob@iv.test')).toBe(false);

    // But the M6-style verification mail went to the invited address...
    const verifyMail = mailer.sent.find((m) => m.to === 'bob@iv.test');
    expect(verifyMail).toBeTruthy();
    const link = /https?:\/\/\S*\/verify-email\?\S+/.exec(verifyMail!.text ?? '')?.[0];
    expect(link).toBeTruthy();

    // ...and consuming it completes verification honestly.
    const consumed = await app.app.request(link!);
    expect([200, 302]).toContain(consumed.status);
    expect(await verifiedOf(app, 'bob@iv.test')).toBe(true);
  });

  it('a token can only be redeemed once, whichever form was used', async () => {
    mailer.sent.length = 0;
    const created = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'carol@iv.test', role: 'member' }, ownerCookie)
      )
    );
    const adminToken = (created.acceptUrl as string).split('/invite/')[1]!;
    const mailToken = inviteTokenOf(mailer.sent[0]!);

    const first = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: mailToken, name: 'Carol', password: 'carol-password-12345' })
    );
    expect(first.status).toBe(200);

    // The sibling token dies with the invitation.
    const second = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: adminToken, name: 'Carol', password: 'carol-password-12345' })
    );
    expect(second.status).toBe(404); // no longer live (accepted)
  });
});

describe('with no email driver', () => {
  let app: TestApp;
  let ownerCookie: string;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'iv_none'));
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'IvNone', owner: OWNER })
    );
    ownerCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
  });

  afterAll(async () => {
    await app.stop();
  });

  it('a copyable-link accept stays unverified (documented, never silently flipped)', async () => {
    const created = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'dave@iv.test', role: 'member' }, ownerCookie)
      )
    );
    expect(created.emailSent).toBe(false);
    const adminToken = (created.acceptUrl as string).split('/invite/')[1]!;
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: adminToken, name: 'Dave', password: 'dave-password-123456' })
    );
    expect(res.status).toBe(200);
    expect(await verifiedOf(app, 'dave@iv.test')).toBe(false);
  });
});
