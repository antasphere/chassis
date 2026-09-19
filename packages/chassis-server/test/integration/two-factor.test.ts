import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * Optional per-user 2FA — TOTP + one-time backup codes (ADR 009):
 *  - enrollment is password-gated and PENDING until one TOTP verifies;
 *  - an enrolled user's password sign-in answers { twoFactorRedirect } with
 *    NO session; /two-factor/verify-totp (or a backup code) completes it;
 *  - a backup code works exactly once;
 *  - the email-OTP sign-in path gets the same second-factor step (the
 *    custom after-hook in identity/better-auth.ts — the plugin only covers
 *    password sign-in, and an emailed code must not collapse 2FA into
 *    mailbox control);
 *  - disable is password-gated and destroys secret + backup codes;
 *  - machine principals (API keys) never see a 2FA step;
 *  - sign-up stays closed and discovery reports auth.twoFactor.
 *
 * TOTP codes are computed in-test from the enrolled secret (RFC 6238,
 * HMAC-SHA1, 6 digits, 30 s period — the plugin's 1.6.15 defaults; verify
 * allows a ±1-period window so mid-test timing is safe).
 */

const OWNER = { email: 'owner@tf.test', name: 'Tf Owner', password: 'tf-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mailer: RecordingEmailDriver;
let ownerCookie: string;
let totpSecret: string; // base32, parsed from the enrollment totpURI
let backupCodes: string[] = [];

// Distinct per-call IPs keep the per-IP login/two-factor walls out of the way
// (the per-EMAIL sign-in bucket still applies — this file stays under it).
let ipCounter = 0;
const nextIp = () => `10.99.0.${++ipCounter}`;

const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': nextIp(),
    ...(cookie ? { cookie } : {})
  },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string): Promise<Response> {
  return app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
}

async function meWithCookie(cookie: string): Promise<Response> {
  return app.app.request('/api/v1/me', { headers: { cookie } });
}

// ── In-test TOTP (RFC 6238 / RFC 4648 base32) ───────────────────────────────

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of encoded.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpNow(base32Secret: string, digits = 6, periodSeconds = 30): string {
  const counter = Math.floor(Date.now() / (periodSeconds * 1000));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(base32Secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    10 ** digits;
  return String(code).padStart(digits, '0');
}

async function userFlags(email: string): Promise<{ twoFactorEnabled: boolean | null } | null> {
  const { rows } = await app.db.pool.query<{ two_factor_enabled: boolean | null }>(
    `SELECT two_factor_enabled FROM "user" WHERE email = $1`,
    [email]
  );
  return rows[0] ? { twoFactorEnabled: rows[0].two_factor_enabled } : null;
}

beforeAll(async () => {
  container = await startPostgres();
  mailer = new RecordingEmailDriver(); // delivering driver → email-OTP login is on
  app = await createTestApp(await createDatabase(container, 'twofactor'), {}, { email: mailer });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Tf', owner: OWNER })
  );
  ownerCookie = extractCookie(await signIn(OWNER.email, OWNER.password));
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('2FA lifecycle (TOTP + backup codes)', () => {
  it('discovery reports auth.twoFactor: true', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.twoFactor).toBe(true);
  });

  it('enrollment is password-gated: a wrong password answers 400', async () => {
    const res = await app.app.request(
      '/api/v1/auth/two-factor/enable',
      json({ password: 'not-the-password-123' }, ownerCookie)
    );
    expect(res.status).toBe(400);
  });

  it('enroll: /two-factor/enable issues a totpURI and 10 one-time backup codes', async () => {
    const res = await app.app.request(
      '/api/v1/auth/two-factor/enable',
      json({ password: OWNER.password }, ownerCookie)
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.backupCodes).toHaveLength(10);
    for (const code of body.backupCodes as string[]) {
      expect(code).toMatch(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/);
    }
    backupCodes = body.backupCodes;
    const secret = new URL(body.totpURI as string).searchParams.get('secret');
    expect(secret).toBeTruthy();
    totpSecret = secret!;
  });

  it('pending enrollment does NOT gate sign-in yet (no verified authenticator)', async () => {
    const res = await signIn(OWNER.email, OWNER.password);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.twoFactorRedirect).toBeUndefined();
    // A real session came back.
    expect((await meWithCookie(extractCookie(res))).status).toBe(200);
    expect((await userFlags(OWNER.email))?.twoFactorEnabled).not.toBe(true);
  });

  it('activation: verifying a computed TOTP flips twoFactorEnabled', async () => {
    const res = await app.app.request(
      '/api/v1/auth/two-factor/verify-totp',
      json({ code: totpNow(totpSecret) }, ownerCookie)
    );
    expect(res.status).toBe(200);
    // Activation rotates the session — adopt the fresh cookie.
    ownerCookie = extractCookie(res);
    expect((await meWithCookie(ownerCookie)).status).toBe(200);
    expect((await userFlags(OWNER.email))?.twoFactorEnabled).toBe(true);
    const { rows } = await app.db.pool.query<{ verified: boolean | null }>(`SELECT verified FROM two_factor`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verified).toBe(true);
  });

  it('password sign-in now requires the second factor: redirect, wrong code 401, valid TOTP completes', async () => {
    // One pending sign-in exercises the whole step (a rejected code does not
    // consume the pending state, so the valid code reuses the same cookie).
    const res = await signIn(OWNER.email, OWNER.password);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.twoFactorRedirect).toBe(true);
    const pending = extractCookie(res);
    // The cookies it set do NOT authenticate — the pending-2FA state is not a session.
    expect((await meWithCookie(pending)).status).toBe(401);

    const wrong = totpNow(totpSecret) === '000000' ? '000001' : '000000';
    const denied = await app.app.request(
      '/api/v1/auth/two-factor/verify-totp',
      json({ code: wrong }, pending)
    );
    expect(denied.status).toBe(401);

    const done = await app.app.request(
      '/api/v1/auth/two-factor/verify-totp',
      json({ code: totpNow(totpSecret) }, pending)
    );
    expect(done.status).toBe(200);
    expect((await meWithCookie(extractCookie(done))).status).toBe(200);
  });

  it('a backup code completes sign-in once and is then consumed', async () => {
    const code = backupCodes[0]!;
    const pending = extractCookie(await signIn(OWNER.email, OWNER.password));
    const first = await app.app.request(
      '/api/v1/auth/two-factor/verify-backup-code',
      json({ code }, pending)
    );
    expect(first.status).toBe(200);
    expect((await meWithCookie(extractCookie(first))).status).toBe(200);

    // The same code again, on a fresh pending sign-in: consumed → rejected.
    const pending2 = extractCookie(await signIn(OWNER.email, OWNER.password));
    const second = await app.app.request(
      '/api/v1/auth/two-factor/verify-backup-code',
      json({ code }, pending2)
    );
    expect(second.status).toBe(401);
  });

  it('email-OTP sign-in cannot bypass the second factor', async () => {
    mailer.sent.length = 0;
    const sent = await app.app.request(
      '/api/v1/auth/email-otp/send-verification-otp',
      json({ email: OWNER.email, type: 'sign-in' })
    );
    expect(sent.status).toBe(200);
    const otp = /\b(\d{6})\b/.exec(mailer.sent[0]?.text ?? '')?.[1];
    expect(otp).toBeTruthy();

    const res = await app.app.request('/api/v1/auth/sign-in/email-otp', json({ email: OWNER.email, otp }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.twoFactorRedirect).toBe(true);
    const pending = extractCookie(res);
    // No session came back...
    expect((await meWithCookie(pending)).status).toBe(401);
    // ...and the pending state completes through the SAME verify-totp step.
    const done = await app.app.request(
      '/api/v1/auth/two-factor/verify-totp',
      json({ code: totpNow(totpSecret) }, pending)
    );
    expect(done.status).toBe(200);
    expect((await meWithCookie(extractCookie(done))).status).toBe(200);
  });

  it('machine principals (API keys) never see a 2FA step', async () => {
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'tf-key', scopes: [host.scopes.read] }, ownerCookie)
      )
    );
    // The key belongs to the 2FA-enabled owner; bearer auth is single-step.
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.via).toBe('api_key');
  });

  it('sign-up stays closed (the 2FA plugin reopens nothing)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/sign-up/email',
      json({ email: 'squatter@tf.test', password: 'squatter-password-123', name: 'Squatter' })
    );
    expect(res.status).toBe(403);
  });

  it('disable requires the password gate and removes 2FA entirely', async () => {
    const denied = await app.app.request(
      '/api/v1/auth/two-factor/disable',
      json({ password: 'not-the-password-123' }, ownerCookie)
    );
    expect(denied.status).toBe(400);

    const res = await app.app.request(
      '/api/v1/auth/two-factor/disable',
      json({ password: OWNER.password }, ownerCookie)
    );
    expect(res.status).toBe(200);
    ownerCookie = extractCookie(res); // disable also rotates the session

    expect((await userFlags(OWNER.email))?.twoFactorEnabled).toBe(false);
    const { rows } = await app.db.pool.query(`SELECT id FROM two_factor`);
    expect(rows).toHaveLength(0);

    // Sign-in is single-step again.
    const signedIn = await signIn(OWNER.email, OWNER.password);
    expect(signedIn.status).toBe(200);
    expect((await readJson(signedIn)).twoFactorRedirect).toBeUndefined();
    expect((await meWithCookie(extractCookie(signedIn))).status).toBe(200);
  });
});
