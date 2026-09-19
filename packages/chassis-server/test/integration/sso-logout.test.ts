import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { decodeJwt } from 'jose';
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
 * Single logout, the server leg (SL-2) + the SL-1 silent-connect authorize
 * seam, against the FakeHub (discovery now advertises end_session_endpoint;
 * id_tokens optionally carry `sid`):
 *
 *  - POST /sso/logout resolves the session ROUTE-LOCALLY (zero-membership
 *    sessions included), builds the hub end-session URL (sid required,
 *    discovery-cached endpoint, exact post_logout_redirect_uri), revokes
 *    the local session server-side, clears the shared hint cookie, and
 *    answers {url} — url null on ANY hub-leg failure, with the local
 *    revoke + hint clear untouched;
 *  - machines 403 fail-closed (unlisted in the scope allowlist); anonymous
 *    401; oss = JSON 404 (zero hub surface);
 *  - the sign-in leg forwards ONLY the whitelisted prompt=none into the hub
 *    authorize URL.
 */

const OWNER = { email: 'owner@logout.test', name: 'Log Out', password: 'log-out-password-123' };
const ORG_A = '22222222-aaaa-4bbb-8ccc-000000000001';

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

function cloudEnv(issuer = hub.issuer) {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
    // Pin the hint domain explicitly: the FakeHub issuer is an IP, so the
    // derived default is meaningless here (the derivation rule itself is
    // unit-pinned in env.test.ts).
    HUB_HINT_COOKIE_DOMAIN: 'slideless.test'
  };
}

const HINT_CLEAR = 'ant_sso_hint=; Max-Age=0; Domain=slideless.test; Path=/; SameSite=Lax';

/** The set-cookie list of a response (Node 20 Headers). */
const setCookies = (res: Response) => res.headers.getSetCookie();

describe('cloud: POST /sso/logout + the prompt=none authorize seam', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'sso_logout'), cloudEnv());
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Logout', owner: OWNER })
    );
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  const alice: HubUserFixture = {
    sub: 'hub-alice',
    email: 'alice@logout.test',
    name: 'Alice',
    workspaceId: ORG_A,
    role: 'member',
    workspaceName: 'Org A',
    overrides: { idTokenSid: 'hub-session-alice-1' }
  };
  const bob: HubUserFixture = {
    sub: 'hub-bob',
    email: 'bob@logout.test',
    name: 'Bob',
    workspaceId: ORG_A,
    role: 'member',
    workspaceName: 'Org A'
    // no idTokenSid: the pre-flip id_token shape
  };

  it('forwards ONLY the whitelisted prompt=none into the hub authorize URL (SL-1)', async () => {
    const init = (body: Record<string, unknown>) => ({
      ...json({ providerId: 'antasphere', callbackURL: '/', ...body }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp() }
    });
    // The silent-connect shape: prompt=none passes through.
    const silent = await app.app.request(
      '/api/v1/auth/sign-in/oauth2',
      init({ additionalData: { prompt: 'none' } })
    );
    expect(silent.status).toBe(200);
    const silentUrl = new URL((await readJson(silent)).url);
    expect(silentUrl.searchParams.get('prompt')).toBe('none');

    // A plain interactive sign-in carries no prompt at all.
    const plain = await app.app.request('/api/v1/auth/sign-in/oauth2', init({}));
    expect(plain.status).toBe(200);
    const plainUrl = new URL((await readJson(plain)).url);
    expect(plainUrl.searchParams.has('prompt')).toBe(false);

    // Anything else in additionalData is dropped — no prompt smuggling, no
    // extra params.
    const hostile = await app.app.request(
      '/api/v1/auth/sign-in/oauth2',
      init({ additionalData: { prompt: 'consent', login_hint: 'x@y.z' } })
    );
    expect(hostile.status).toBe(200);
    const hostileUrl = new URL((await readJson(hostile)).url);
    expect(hostileUrl.searchParams.has('prompt')).toBe(false);
    expect(hostileUrl.searchParams.has('login_hint')).toBe(false);
  });

  it('sid-carrying login → logout answers the exact hub end-session URL, revokes, clears the hint', async () => {
    const cookie = await sso.ssoLogin(app, hub, alice);
    const res = await app.app.request('/api/v1/sso/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const { url } = await readJson(res);
    expect(typeof url).toBe('string');
    const endSession = new URL(url);
    expect(`${endSession.origin}${endSession.pathname}`).toBe(`${hub.issuer}/api/v1/auth/oauth2/end-session`);
    // The exact contract redirect — must match the hub registry entry.
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:3000/login?signed_out=1'
    );
    // The hint is the stored id_token, sid intact.
    const hint = endSession.searchParams.get('id_token_hint')!;
    expect(decodeJwt(hint).sid).toBe('hub-session-alice-1');

    // Local revoke happened server-side (session cookie cleared + row dead)…
    const cookies = setCookies(res);
    expect(cookies.some((v) => v.includes('better-auth.session_token=;') || /session_token=;/.test(v))).toBe(
      true
    );
    // …and the shared hint cookie is cleared with the EXACT contract
    // attributes (Domain on the parent, Path=/, Lax, NOT HttpOnly; no
    // Secure on this http test origin).
    const hintClear = cookies.find((v) => v.startsWith('ant_sso_hint='));
    expect(hintClear).toBe(HINT_CLEAR);
    expect(hintClear).not.toContain('HttpOnly');
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('sid-less (pre-flip) login → url null, local revoke + hint clear still happen', async () => {
    const cookie = await sso.ssoLogin(app, hub, bob);
    const res = await app.app.request('/api/v1/sso/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await readJson(res)).url).toBeNull();
    expect(setCookies(res).find((v) => v.startsWith('ant_sso_hint='))).toBe(HINT_CLEAR);
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('a ZERO-MEMBERSHIP operator session (no antasphere account row) logs out: url null, revoked', async () => {
    // Cloud setup mints no workspace: the operator session resolves to a
    // null principal upstream — the route-local session check must still
    // let them log out (the /me zero-state pattern).
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const zeroState = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(zeroState.status).toBe(200);
    expect((await readJson(zeroState)).workspaces).toEqual([]);

    const res = await app.app.request('/api/v1/sso/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await readJson(res)).url).toBeNull();
    expect(setCookies(res).find((v) => v.startsWith('ant_sso_hint='))).toBe(HINT_CLEAR);
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('machines 403 fail-closed (unlisted in the scope allowlist); anonymous 401', async () => {
    // A machine credential must never be able to end its user's sessions.
    await sso.seedLocalWorkspace(app, 'LogoutWs', OWNER.email);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    const cookie = extractCookie(signIn);
    const mint = await app.app.request('/api/v1/api-keys', {
      ...json({
        name: 'logout probe',
        scopes: [host.scopes.read, host.scopes.write, host.scopes.dataExport]
      }),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(mint.status).toBe(201);
    const { key } = await readJson(mint);

    const withKey = await app.app.request('/api/v1/sso/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` }
    });
    expect(withKey.status).toBe(403);
    expect((await readJson(withKey)).error.code).toBe('endpoint_not_allowed');
    // The key's session-holding USER is untouched: their session cookie
    // still resolves (the machine call revoked nothing).
    expect((await app.app.request('/api/v1/me', { headers: { cookie } })).status).toBe(200);

    const anon = await app.app.request('/api/v1/sso/logout', { method: 'POST' });
    expect(anon.status).toBe(401);
  });
});

describe('cloud: logout degrades to local-only when hub discovery is down', () => {
  it('a sid-carrying session still logs out — url null, session revoked, hint cleared', async () => {
    // A dedicated hub so this suite can kill discovery without touching the
    // shared FakeHub: log in while it lives, stop it, THEN log out.
    const hub2 = await FakeHub.start();
    const app2 = await createTestApp(
      await createDatabase(container, 'sso_logout_down'),
      cloudEnv(hub2.issuer)
    );
    try {
      const setup = await app2.app.request(
        '/api/v1/setup',
        json({ setupToken: 'integration-test-setup-token', instanceName: 'Down', owner: OWNER })
      );
      expect(setup.status).toBe(201);
      const cookie = await sso.ssoLogin(app2, hub2, {
        sub: 'hub-carol',
        email: 'carol@logout.test',
        name: 'Carol',
        workspaceId: ORG_A,
        role: 'member',
        workspaceName: 'Org A',
        overrides: { idTokenSid: 'hub-session-carol-1' }
      });
      await hub2.stop();

      const res = await app2.app.request('/api/v1/sso/logout', { method: 'POST', headers: { cookie } });
      expect(res.status).toBe(200);
      expect((await readJson(res)).url).toBeNull();
      expect(setCookies(res).find((v) => v.startsWith('ant_sso_hint='))).toBe(HINT_CLEAR);
      const me = await app2.app.request('/api/v1/me', { headers: { cookie } });
      expect(me.status).toBe(401);
    } finally {
      await app2.stop();
    }
  });
});

describe('oss: zero logout surface', () => {
  it('POST /sso/logout answers the JSON 404 terminator', async () => {
    const app = await createTestApp(await createDatabase(container, 'sso_logout_oss'));
    try {
      const res = await app.app.request('/api/v1/sso/logout', { method: 'POST' });
      expect(res.status).toBe(404);
      expect((await readJson(res)).error.code).toBe('not_found');
    } finally {
      await app.stop();
    }
  });
});
