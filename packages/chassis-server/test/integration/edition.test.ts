import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  expectBootRefusal,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The edition split, Phase 2 (internal/federation.md):
 *  - setup stamps the instance's edition; the R7 boot guard refuses an env
 *    EDITION that differs on an already-set-up instance, and
 *    EDITION_CHANGE_ALLOWED=true is the one-boot acknowledgement that
 *    re-stamps it;
 *  - a fresh database boots under any edition (cloud starts from a fresh DB);
 *  - EDITION=oss keeps today's behavior byte-identical — no hub config read.
 *
 * The SSO wiring itself is Phase 3; these tests pin the scaffolding only.
 */

const OWNER = { email: 'owner@edition.test', name: 'Ed Owner', password: 'ed-owner-password-123' };

/** The full hub block a cloud boot requires (dev-shaped values). */
const HUB_ENV = {
  EDITION: 'cloud',
  HUB_ISSUER_URL: 'http://hub.localhost:3300',
  HUB_CLIENT_ID: 'tool-slideless-cloud',
  HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('R7 edition-flip boot guard', () => {
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createDatabase(container, 'edition_guard');
    const app = await createTestApp(connectionString);
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Ed', owner: OWNER })
    );
    expect(res.status).toBe(201);
    await app.stop();
  });

  it('setup stamped the instance as oss (the test boot default)', async () => {
    const app = await createTestApp(connectionString);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'oss' }]);
    await app.stop();
  });

  it('refuses to boot EDITION=cloud on the populated oss instance', async () => {
    await expectBootRefusal(
      createTestApp(connectionString, HUB_ENV),
      /refusing to boot: EDITION=cloud but this instance was set up as 'oss'/
    );
  });

  it('EDITION_CHANGE_ALLOWED=true re-stamps and boots; the flip then holds without the flag', async () => {
    // The flip pre-flights (PRDCT-1356 EDIT-1): an unprojected workspace
    // refuses it. Project the setup workspace first — cloud-lifecycle.test.ts
    // pins the refusal itself.
    const prep = await createTestApp(connectionString);
    await prep.db.pool.query(
      `UPDATE workspaces SET central_account_id = '44444444-aaaa-4bbb-8ccc-0000000000ed'`
    );
    await prep.stop();
    const flipped = await createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' });
    const { rows } = await flipped.db.pool.query<{ edition: string }>(
      `SELECT edition FROM instance_settings`
    );
    expect(rows).toEqual([{ edition: 'cloud' }]);
    await flipped.stop();

    // The stamp moved: a plain cloud boot now succeeds, and an oss boot is
    // now the refused flip (the guard is symmetric) — and the REVERSE flip
    // is refused even with the flag (EDIT-4, cloud-lifecycle.test.ts).
    const cloudAgain = await createTestApp(connectionString, HUB_ENV);
    await cloudAgain.stop();
    await expectBootRefusal(
      createTestApp(connectionString),
      /refusing to boot: EDITION=oss but this instance was set up as 'cloud'/
    );
  });
});

describe('cloud edition on a fresh database', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'edition_cloud'), HUB_ENV);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('boots (fresh DB — nothing to guard) and setup stamps edition=cloud', async () => {
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'EdCloud', owner: OWNER })
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    // Cloud setup creates NO workspace (user-scoped federation): every
    // cloud workspace is a hub-org projection — the operator bootstrap
    // mints a verified USER only, and the response says so honestly.
    expect(body.workspaceId).toBeNull();
    expect(body.ownerUserId).toBeTruthy();
    const workspaces = await app.db.pool.query(`SELECT id FROM workspaces`);
    expect(workspaces.rows).toHaveLength(0);
    const memberships = await app.db.pool.query(`SELECT id FROM workspace_members`);
    expect(memberships.rows).toHaveLength(0);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'cloud' }]);
  });

  it('the zero-membership operator session gets the /me zero state (200), not a login bounce', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = await readJson(me);
    expect(body.user.email).toBe(OWNER.email);
    expect(body.workspaces).toEqual([]);
    expect(body.workspace).toBeNull();
    expect(body.activeWorkspaceId).toBeNull();
    expect(body.role).toBeNull();
    expect(body.origin).toBeNull();
    expect(body.via).toBe('session');
    // The zero state's CTA target: orgs are created at the hub.
    expect(body.hubManageUrl).toBe(HUB_ENV.HUB_ISSUER_URL);
  });

  it('unauthenticated and machine callers keep their 401 on /me (zero state is session-only)', async () => {
    const anon = await app.app.request('/api/v1/me');
    expect(anon.status).toBe(401);
    // A syntactically valid but unknown API key still dies inside
    // authContext — the route-local session path never runs for bearers.
    const fakeKey = 'slk_AAAAAAAA_' + 'a'.repeat(43);
    const withKey = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${fakeKey}`, 'x-forwarded-for': '10.77.0.1' }
    });
    expect(withKey.status).toBe(401);
  });

  it('a session NAMING a workspace keeps the fail-closed 401 — the zero state is selector-less only', async () => {
    // A failed explicit selection must never soften into the 200 zero state:
    // it is the no-oracle posture AND the dashboard's stale-selection
    // self-heal signal (it drops the stored selector only on failure).
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    const cookie = extractCookie(signIn);
    const res = await app.app.request('/api/v1/me', {
      headers: { cookie, 'x-workspace-id': '99999999-9999-4999-8999-999999999999' }
    });
    expect(res.status).toBe(401);
  });

  it('reports edition=cloud in discovery', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('cloud');
  });

  it('exposes the hub SSO hint-cookie contract in discovery (SL-1)', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    // Defaults: the cross-repo cookie name; domain = issuer host minus its
    // first label (hub.localhost → localhost).
    expect(info.auth.sso).toEqual({ hintCookieName: 'ant_sso_hint', hintCookieDomain: 'localhost' });
  });

  it('lands OAuth-callback AS errors on /login (cloud onAPIError.errorURL, SL-1)', async () => {
    // A prompt=none authorize against a hub with no session answers
    // ?error=login_required at the callback; the genericOAuth callback
    // redirects AS errors to onAPIError.errorURL BEFORE parseState (1.6.15),
    // so no state/cookie is needed to pin the landing.
    const res = await app.app.request(
      '/api/v1/auth/oauth2/callback/antasphere?error=login_required&error_description=Login%20required'
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('http://localhost:3000/login?error=login_required')).toBe(true);
    // The error exit mints no session.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('setup minted the operator emailVerified=true (D9 — the trusted-link bootstrap)', async () => {
    // Under hub-only login (D1, Phase 3) the operator can only enter via the
    // hub trusted-link, which Better Auth refuses onto an unverified local
    // email. An unverified operator = a bricked cloud instance. Pinned here
    // so no auth refactor can silently reopen the trap.
    const { rows } = await app.db.pool.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM "user" WHERE email = $1`,
      [OWNER.email]
    );
    expect(rows).toEqual([{ email_verified: true }]);
  });

  it('advertises the hub-only human entrance (D1): antasphere + machine methods, no password/OTP', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.methods).toContain('antasphere');
    // Hub-only posture (Phase 3): the login page renders ONLY the SSO
    // button; password/OTP/google are hidden (the machinery stays wired for
    // the break-glass CLI, verified in the next test). Machine entrances
    // are edition-independent.
    expect(info.auth.methods).not.toContain('password');
    expect(info.auth.methods).not.toContain('email-otp');
    expect(info.auth.methods).not.toContain('google');
    expect(info.auth.methods).toContain('api-key');
    expect(info.auth.methods).toContain('oauth');
    // Credentials and email are the hub's to manage; local 2FA guards
    // sign-in surfaces the cloud page no longer offers.
    expect(info.auth.passwordReset).toBe(false);
    expect(info.auth.emailChange).toBe(false);
    expect(info.auth.twoFactor).toBe(false);
  });

  it('the provider-grant routes stay closed on CLOUD too (PRDCT-1354 pin; the oss pin lives in minted-credentials)', async () => {
    // On cloud the stored provider grant IS the hub grant (ADR 019): handing
    // it to a caller — or rotating it outside HubGrantService's lock — is
    // the seam PRDCT-1370 hardens. The closure is unconditional in code;
    // this pins it on a cloud boot so an edition-gated regression cannot
    // pass on the oss-only pin alone.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    for (const path of ['/api/v1/auth/get-access-token', '/api/v1/auth/refresh-token']) {
      for (const headers of [{ cookie }, {}]) {
        const res = await app.app.request(path, {
          ...json({ providerId: 'antasphere' }),
          headers: { 'content-type': 'application/json', ...headers }
        });
        expect(res.status, `${path} with ${Object.keys(headers).join(',') || 'no'} cookie`).toBe(403);
        const body = await res.text();
        expect(body).toContain('provider_grant_forbidden');
        expect(body).not.toMatch(/accessToken|idToken|refreshToken|access_token/);
      }
    }
  });

  it('local password sign-in stays WIRED though hidden (the break-glass door, D1)', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await readJson(me)).user.email).toBe(OWNER.email);
  });
});

describe('cloud edition closes the local password-reset surface (P8, ADR 017)', () => {
  // The P3 residual: on cloud, a hub-JIT user (no credential account) could
  // use the reset surface to SET a local password, then /sign-in/email to
  // mint sessions that skip the per-login SSO re-sync. D1's hub-only posture
  // closes the WHOLE reset class (core + emailOTP alias routes) while the
  // break-glass operator door — /sign-in/email with the SETUP password plus
  // the break-glass endpoints — stays fully independent of it.
  let app: TestApp;
  let email: RecordingEmailDriver;

  // The reset wall is 5/10min per IP (rate-limit.ts) and several reset paths
  // share one limiter — a unique forwarded address per request (TRUST_PROXY
  // is on in tests) keeps this suite off one shared 'unknown' bucket, so it
  // pins the 403 REFUSAL, never a 429.
  let ipCounter = 0;
  const jsonIp = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${++ipCounter % 250}`,
      ...headers
    },
    body: JSON.stringify(body)
  });

  beforeAll(async () => {
    email = new RecordingEmailDriver();
    // A DELIVERING mailer + superadmin: the strongest configuration — on oss
    // this would open self-serve reset; on cloud every reset door must still
    // refuse while break-glass keeps working.
    app = await createTestApp(
      await createDatabase(container, 'edition_cloud_reset'),
      { ...HUB_ENV, SUPERADMIN_EMAILS: OWNER.email },
      { email }
    );
    const res = await app.app.request(
      '/api/v1/setup',
      jsonIp({ setupToken: 'integration-test-setup-token', instanceName: 'EdReset', owner: OWNER })
    );
    expect(res.status).toBe(201);
    // Cloud setup mints no workspace — the cloud-LOCAL workspace this
    // suite's reset-link + break-glass fixtures need is seeded directly.
    await sso.seedLocalWorkspace(app, 'EdReset', OWNER.email);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function resetTokenCount(): Promise<number> {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
    );
    return rows[0]!.n;
  }

  it('refuses every reset-shaped route (core + emailOTP) despite the delivering mailer', async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        '/api/v1/auth/request-password-reset',
        { email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' }
      ],
      ['/api/v1/auth/reset-password', { newPassword: 'sso-bypass-password-99', token: 'whatever' }],
      ['/api/v1/auth/email-otp/request-password-reset', { email: OWNER.email }],
      ['/api/v1/auth/forget-password/email-otp', { email: OWNER.email }],
      [
        '/api/v1/auth/email-otp/reset-password',
        { email: OWNER.email, otp: '123456', password: 'sso-bypass-password-99' }
      ]
    ];
    for (const [path, body] of attempts) {
      const res = await app.app.request(path, jsonIp(body));
      expect(res.status, path).toBe(403);
    }
    // The tokened GET callback (the mailed-link landing) refuses too.
    const cb = await app.app.request('/api/v1/auth/reset-password/some-token', {
      headers: { 'x-forwarded-for': `198.51.100.${++ipCounter % 250}` }
    });
    expect(cb.status).toBe(403);
    // Nothing was mailed and no reset token was minted.
    expect(email.sent).toHaveLength(0);
    expect(await resetTokenCount()).toBe(0);
  });

  it('refuses to CONSUME a valid reset token — even one minted straight into the store', async () => {
    // An attacker (or a leftover admin link) holding a well-formed token in
    // Better Auth's own verification table still cannot set a password: the
    // refusal is on the route, not on token acquisition.
    const { rows } = await app.db.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    await app.db.pool.query(
      `INSERT INTO verification (id, identifier, value, expires_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), 'reset-password:direct-mint-token', rows[0]!.id, new Date(Date.now() + 3600_000)]
    );
    const res = await app.app.request(
      '/api/v1/auth/reset-password',
      jsonIp({ newPassword: 'sso-bypass-password-99', token: 'direct-mint-token' })
    );
    expect(res.status).toBe(403);
    // The password did not change: the setup password still signs in, the
    // attempted one does not.
    const bypass = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: 'sso-bypass-password-99' })
    );
    expect(bypass.status).toBe(401);
    // Remove the hand-minted row so the next test's "the mint added nothing"
    // count starts from zero again.
    await app.db.pool.query(`DELETE FROM verification WHERE identifier = 'reset-password:direct-mint-token'`);
  });

  it('refuses the admin reset-link mint on a cloud-LOCAL workspace (password_reset_disabled)', async () => {
    // Hub-origin workspaces already refuse at the P7 subtree gate
    // (hub_managed); this pins the cloud-LOCAL half — otherwise an admin
    // would mint links that dead-end on the refused /reset-password.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const { members } = await readJson(await app.app.request('/api/v1/members', { headers: { cookie } }));
    const minted = await app.app.request(`/api/v1/members/${members[0].id}/reset-link`, {
      method: 'POST',
      headers: { cookie }
    });
    expect(minted.status).toBe(403);
    expect((await readJson(minted)).error.code).toBe('password_reset_disabled');
    expect(await resetTokenCount()).toBe(0);
  });

  it('refuses the admin change-email-link mint on a cloud-LOCAL workspace (email_change_disabled)', async () => {
    // AUTH-1 (PRDCT-1354): the sibling mint had NO cloud closure at all, yet
    // its token is the STRONGER of the two — consuming it signs the target in
    // AND rewrites the address the hub identity is keyed on, while on cloud
    // the email is the hub's to own (D10 re-syncs it every login). Same shape
    // as the reset-link closure above, distinct code.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const { members } = await readJson(await app.app.request('/api/v1/members', { headers: { cookie } }));
    const minted = await app.app.request(`/api/v1/members/${members[0].id}/change-email-link`, {
      ...jsonIp({ newEmail: 'hijacked@edreset.test' }, { cookie })
    });
    expect(minted.status).toBe(403);
    const body = await readJson(minted);
    expect(body.error.code).toBe('email_change_disabled');
    expect(body.verifyUrl).toBeUndefined();
  });

  it('the operator door survives the closure: /sign-in/email + break-glass need no reset route', async () => {
    // The full recovery chain, reset-free: sign in with the SETUP password
    // (D9 minted the operator emailVerified=true), then claim-ownership and
    // reset-2fa — the ADR 010 surface — both work.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;

    const claim = await app.app.request('/api/v1/admin/break-glass/claim-ownership', {
      ...jsonIp({}),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(claim.status).toBe(200);
    expect((await readJson(claim)).role).toBe('owner');

    const { rows } = await app.db.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    const reset2fa = await app.app.request('/api/v1/admin/break-glass/reset-2fa', {
      ...jsonIp({ userId: rows[0]!.id }),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(reset2fa.status).toBe(200);
  });
});

describe('cloud edition closes the OTP entrances (D1 hub-only credentials)', () => {
  // The ADR 017 §7 charter call, now taken: beyond the P8 reset closure,
  // the two remaining non-SSO credential-MINTING entrances refuse on cloud
  // so every human session AND CLI key traces through the hub (its audit
  // log is the complete access record). Both were hub-gated per request by
  // the P4 re-assertion already — posture, not a hole. The self-revoke
  // (DELETE /cli/auth/key) is the deliberate exception: revocation narrows
  // access, and `slideless logout --org` needs it.
  let app: TestApp;
  let email: RecordingEmailDriver;

  let ipCounter = 0;
  const jsonIp = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.101.${++ipCounter % 250}`,
      ...headers
    },
    body: JSON.stringify(body)
  });

  beforeAll(async () => {
    email = new RecordingEmailDriver();
    // A DELIVERING mailer AND Google credentials set: the strongest
    // misconfiguration — on oss both would open OTP login and Google social
    // sign-in; on cloud every one of them must be closed by construction.
    app = await createTestApp(
      await createDatabase(container, 'edition_cloud_otp'),
      { ...HUB_ENV, GOOGLE_CLIENT_ID: 'cloud-google-id', GOOGLE_CLIENT_SECRET: 'cloud-google-secret' },
      { email }
    );
    const res = await app.app.request(
      '/api/v1/setup',
      jsonIp({ setupToken: 'integration-test-setup-token', instanceName: 'EdOtp', owner: OWNER })
    );
    expect(res.status).toBe(201);
    // Cloud setup mints no workspace — the key-mint fixture below needs the
    // operator to hold a membership; seed a cloud-LOCAL one.
    await sso.seedLocalWorkspace(app, 'EdOtp', OWNER.email);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('refuses the emailOTP session surface (send / sign-in / verify-email) despite the mailer', async () => {
    // The enumerated 1.6.15 session-minting surface (isOtpSignInPath): the
    // sign-in mint, the verify-email conditional mint (config insurance),
    // and the send leg (no dead codes get mailed).
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['/api/v1/auth/email-otp/send-verification-otp', { email: OWNER.email, type: 'sign-in' }],
      ['/api/v1/auth/sign-in/email-otp', { email: OWNER.email, otp: '123456' }],
      ['/api/v1/auth/email-otp/verify-email', { email: OWNER.email, otp: '123456' }]
    ];
    for (const [path, body] of attempts) {
      const res = await app.app.request(path, jsonIp(body));
      expect(res.status, path).toBe(403);
      expect(res.headers.get('set-cookie'), path).toBeNull(); // no session minted
    }
    // The refusal carries the steering code, and nothing was mailed.
    const refusal = await app.app.request(
      '/api/v1/auth/sign-in/email-otp',
      jsonIp({ email: OWNER.email, otp: '123456' })
    );
    expect((await readJson(refusal)).code).toBe('otp_signin_disabled');
    expect(email.sent).toHaveLength(0);
  });

  it('does NOT register the Google social provider despite GOOGLE_CLIENT_ID/SECRET set', async () => {
    // Google social is a self-host option only: on cloud the provider is
    // not registered at all, so /sign-in/social mints no session even with
    // the credentials configured (defense in depth — the audit-completeness
    // guarantee holds by construction, not by "operator didn't set the env
    // var"). 1.6.15 answers PROVIDER_NOT_FOUND (404) for an unregistered
    // provider, and no session cookie is set.
    const social = await app.app.request('/api/v1/auth/sign-in/social', jsonIp({ provider: 'google' }));
    expect(social.status).toBe(404);
    expect(social.headers.get('set-cookie')).toBeNull();
    // Discovery never advertises google on cloud either (the hub-only
    // descriptor), the credentials notwithstanding.
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.methods).not.toContain('google');
  });

  it('refuses the CLI OTP mint pair (cli_otp_disabled → `antasphere login`)', async () => {
    const request = await app.app.request('/api/v1/cli/auth/request', jsonIp({ email: OWNER.email }));
    expect(request.status).toBe(403);
    const requestBody = await readJson(request);
    expect(requestBody.error.code).toBe('cli_otp_disabled');
    expect(requestBody.error.message).toContain('antasphere login');

    const complete = await app.app.request(
      '/api/v1/cli/auth/complete',
      jsonIp({ email: OWNER.email, otp: '123456' })
    );
    expect(complete.status).toBe(403);
    expect((await readJson(complete)).error.code).toBe('cli_otp_disabled');
    expect(email.sent).toHaveLength(0); // still nothing mailed
  });

  it('the self-revoke stays open: a key kills exactly ITSELF; the operator door survives', async () => {
    // /sign-in/email still works AFTER the OTP close (the break-glass door).
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;

    const mint = async (name: string) => {
      const res = await app.app.request('/api/v1/api-keys', {
        ...jsonIp({ name, scopes: [host.scopes.read, host.scopes.write] }),
        headers: { 'content-type': 'application/json', cookie }
      });
      expect(res.status).toBe(201);
      return readJson(res);
    };
    const keyA = await mint('cloud-cli-a');
    const keyB = await mint('cloud-cli-b');

    const revoke = await app.app.request('/api/v1/cli/auth/key', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${keyA.key}` }
    });
    expect(revoke.status).toBe(200);
    expect(await readJson(revoke)).toEqual({ revoked: true, id: keyA.apiKey.id });

    // The presenting key is dead; the OTHER key is untouched — the route
    // names no key, so nothing else was revocable.
    const deadMe = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyA.key}` }
    });
    expect(deadMe.status).toBe(401);
    const liveMe = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyB.key}` }
    });
    expect(liveMe.status).toBe(200);
  });
});

describe('session TTL split (SL-5): cloud 30d FIXED, oss 365d sliding', () => {
  // The one-login-concept mechanics: a cloud tool session is a PROJECTION of
  // the hub anchor — sliding it would let the anchor die under an active
  // user, so cloud sessions are fixed-duration (disableSessionRefresh, the
  // 1.6.15 knob) and re-derive silently from the anchor. oss keeps the
  // template's sliding sessions byte-identically.

  interface SessionRow {
    id: string;
    expires_at: Date;
    created_at: Date;
  }

  async function newestSession(app: TestApp, email: string): Promise<SessionRow> {
    const { rows } = await app.db.pool.query<SessionRow>(
      `SELECT s.id, s.expires_at, s.created_at FROM session s
         JOIN "user" u ON u.id = s.user_id WHERE u.email = $1
        ORDER BY s.created_at DESC LIMIT 1`,
      [email]
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** Backdate a session so the sliding rule (expiresAt − expiresIn + updateAge ≤ now) fires. */
  async function backdate(app: TestApp, id: string): Promise<Date> {
    const { rows } = await app.db.pool.query<{ expires_at: Date }>(
      `UPDATE session SET expires_at = now() + interval '1 hour' WHERE id = $1 RETURNING expires_at`,
      [id]
    );
    return rows[0]!.expires_at;
  }

  it('cloud: sessions mint at 30 days and expiresAt does NOT advance on use', async () => {
    const app = await createTestApp(await createDatabase(container, 'session_ttl_cloud'), HUB_ENV);
    try {
      expect(
        (
          await app.app.request(
            '/api/v1/setup',
            json({ setupToken: 'integration-test-setup-token', instanceName: 'Ttl', owner: OWNER })
          )
        ).status
      ).toBe(201);
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      expect(signIn.status).toBe(200);
      const cookie = extractCookie(signIn);

      const minted = await newestSession(app, OWNER.email);
      const ttlDays = (minted.expires_at.getTime() - minted.created_at.getTime()) / 86_400_000;
      expect(ttlDays).toBeGreaterThan(29.9);
      expect(ttlDays).toBeLessThan(30.1);

      // Trip the sliding rule deliberately, then USE the session: with
      // disableSessionRefresh the row must not move — the hard expiry is
      // what forces the silent re-derivation from the hub anchor.
      const backdated = await backdate(app, minted.id);
      const use = await app.app.request('/api/v1/auth/get-session', { headers: { cookie } });
      expect(use.status).toBe(200);
      expect((await readJson(use))?.session).toBeTruthy();
      const after = await newestSession(app, OWNER.email);
      expect(after.id).toBe(minted.id);
      expect(after.expires_at.toISOString()).toBe(backdated.toISOString());
    } finally {
      await app.stop();
    }
  });

  it('oss: the template sliding behavior is unchanged — the same use DOES advance expiresAt', async () => {
    const app = await createTestApp(await createDatabase(container, 'session_ttl_oss'));
    try {
      expect(
        (
          await app.app.request(
            '/api/v1/setup',
            json({ setupToken: 'integration-test-setup-token', instanceName: 'TtlOss', owner: OWNER })
          )
        ).status
      ).toBe(201);
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      expect(signIn.status).toBe(200);
      const cookie = extractCookie(signIn);

      const minted = await newestSession(app, OWNER.email);
      const ttlDays = (minted.expires_at.getTime() - minted.created_at.getTime()) / 86_400_000;
      expect(ttlDays).toBeGreaterThan(364);
      expect(ttlDays).toBeLessThan(366);

      const backdated = await backdate(app, minted.id);
      const use = await app.app.request('/api/v1/auth/get-session', { headers: { cookie } });
      expect(use.status).toBe(200);
      const after = await newestSession(app, OWNER.email);
      expect(after.id).toBe(minted.id);
      // Slid forward: a fresh ~365d horizon, far past the backdated hour.
      expect(after.expires_at.getTime()).toBeGreaterThan(backdated.getTime() + 300 * 86_400_000);
    } finally {
      await app.stop();
    }
  });
});

describe('oss stays dark: zero hub-shaped calls across boot + a request matrix (fetch-spy)', () => {
  it('an oss boot with HUB_* vars present makes NO outbound fetch at all', async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    const spy: typeof fetch = (input, init) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return realFetch(input as Parameters<typeof fetch>[0], init);
    };
    globalThis.fetch = spy;
    try {
      // Positive control first: the spy really intercepts global fetch.
      await spy('http://127.0.0.1:1/spy-probe').catch(() => {});
      expect(fetched).toEqual(['http://127.0.0.1:1/spy-probe']);
      fetched.length = 0;

      // Adversarial config: every HUB_* var set — EDITION=oss must leave
      // them completely unread (hubConfig() is the single switch).
      const app = await createTestApp(await createDatabase(container, 'edition_oss_dark'), {
        HUB_ISSUER_URL: 'http://hub.localhost:3300',
        HUB_CLIENT_ID: 'tool-slideless-cloud',
        HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
      });
      try {
        // The request matrix: setup, session login, whoami, key mint, key
        // use, a domain read — every credential kind exercised.
        const setup = await app.app.request(
          '/api/v1/setup',
          json({ setupToken: 'integration-test-setup-token', instanceName: 'Dark', owner: OWNER })
        );
        expect(setup.status).toBe(201);
        const signIn = await app.app.request(
          '/api/v1/auth/sign-in/email',
          json({ email: OWNER.email, password: OWNER.password })
        );
        expect(signIn.status).toBe(200);
        const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
        expect((await app.app.request('/api/v1/me', { headers: { cookie } })).status).toBe(200);
        const mint = await app.app.request('/api/v1/api-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: 'dark key', scopes: [host.scopes.read] })
        });
        expect(mint.status).toBe(201);
        const { key } = await readJson(mint);
        expect(
          (await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status
        ).toBe(200);
        expect((await app.app.request(host.probeRoute, { headers: { cookie } })).status).toBe(200);
        // The cloud-only surfaces stay dark 404s on oss — probed INSIDE the
        // spy window so a regression that mounts them (or makes them phone
        // the hub) fails the zero-fetch assertion below too.
        const ssoLogout = await app.app.request('/api/v1/sso/logout', {
          method: 'POST',
          headers: { cookie }
        });
        expect(ssoLogout.status).toBe(404);
        const dismiss = await app.app.request('/api/v1/me/onboarding/dismiss', {
          method: 'POST',
          headers: { cookie }
        });
        expect(dismiss.status).toBe(404);
      } finally {
        await app.stop();
      }
      // The whole boot + matrix performed ZERO outbound fetches — no hub
      // grant, no reconcile, no token endpoint, nothing. Byte-identity is
      // not "no hub calls", it is "no network surface constructed at all".
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('oss edition discovery (unchanged)', () => {
  it('never advertises the hub SSO method, and never carries auth.sso (SL-1 pin)', async () => {
    const app = await createTestApp(await createDatabase(container, 'edition_oss_disc'));
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('oss');
    expect(info.auth.methods).not.toContain('antasphere');
    expect(info.auth.methods).toContain('password');
    // The discovery wire shape stays byte-identical on oss: no sso block —
    // key ABSENT, not null.
    expect('sso' in info.auth).toBe(false);
    // And the error surfaces keep their pre-change defaults: the antasphere
    // callback path does not exist (no genericOAuth plugin registered) and
    // the better-auth error route renders its own page — no /login redirect
    // (onAPIError.errorURL is cloud-gated).
    const cb = await app.app.request('/api/v1/auth/oauth2/callback/antasphere?error=login_required');
    expect(cb.status).toBe(404);
    const errRoute = await app.app.request('/api/v1/auth/error?error=probe');
    expect(errRoute.status).toBe(200);
    expect(errRoute.headers.get('content-type')).toContain('text/html');
    await app.stop();
  });

  it('keeps Google social sign-in when configured (the cloud gate is cloud-only)', async () => {
    // The mirror of the cloud closure above: on oss the same GOOGLE_CLIENT_ID/
    // SECRET REGISTER the provider — /sign-in/social builds a real Google
    // authorization URL (200 + url, never PROVIDER_NOT_FOUND) and discovery
    // lists 'google'. Proves the gate touches cloud alone.
    const app = await createTestApp(await createDatabase(container, 'edition_oss_google'), {
      GOOGLE_CLIENT_ID: 'oss-google-id',
      GOOGLE_CLIENT_SECRET: 'oss-google-secret'
    });
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('oss');
    expect(info.auth.methods).toContain('google');

    const social = await app.app.request('/api/v1/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google' })
    });
    expect(social.status).toBe(200);
    const body = await readJson(social);
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('accounts.google.com');
    await app.stop();
  });
});
