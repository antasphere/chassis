import { expect } from 'vitest';
import { extractCookie, readJson, type TestApp } from './helpers.js';
import type { FakeHub, HubUserFixture } from './fake-hub.js';

/**
 * The SSO dance against the FakeHub, shared by the P3 (hub-sso) and P4
 * (hub-entitlements) suites: initiate the sign-in leg, drive the callback
 * with a hub-minted one-shot code, and hand back the session cookie.
 */

export const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let ipCounter = 0;
/** Unique per-dance client IP — the login limiter (10/15min per IP) must never gate a suite. */
export const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/**
 * Seed a cloud-LOCAL workspace (`central_account_id NULL`) owned by the
 * given user, straight into the database. Cloud setup mints NO workspace
 * (user-scoped federation), so fixtures that need one — guest host
 * workspaces, the P7 local-vs-projected contrast — seed it here; the state
 * is exactly what a pre-flip instance (or break-glass recovery) leaves
 * behind.
 */
export async function seedLocalWorkspace(app: TestApp, name: string, ownerEmail: string): Promise<string> {
  const user = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [ownerEmail]);
  expect(user.rows).toHaveLength(1);
  const ws = await app.db.pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [name]);
  const workspaceId = ws.rows[0].id as string;
  await app.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, $2, 'owner', 'local', true)`,
    [workspaceId, user.rows[0].id]
  );
  return workspaceId;
}

/**
 * Initiate the sign-in leg: returns the `state` plus the signed state
 * cookie the callback must present (better-auth's double-submit check —
 * a browser carries it automatically).
 */
export async function ssoInitiate(
  app: TestApp
): Promise<{ state: string; stateCookie: string; scope: string | null }> {
  const init = json({ providerId: 'antasphere', callbackURL: '/' });
  const signIn = await app.app.request('/api/v1/auth/sign-in/oauth2', {
    ...init,
    headers: { ...init.headers, 'x-forwarded-for': nextIp() }
  });
  expect(signIn.status).toBe(200);
  const { url } = await readJson(signIn);
  const state = new URL(url).searchParams.get('state')!;
  expect(state).toBeTruthy();
  // What the tool REALLY asked the hub for: the fake hub grants exactly this
  // (FakeHub.mintCode), so a scope the tool stops requesting is a scope its
  // grants stop carrying — in the suites as at the real hub.
  return { state, stateCookie: extractCookie(signIn), scope: new URL(url).searchParams.get('scope') };
}

/** Initiate the SSO dance and drive the callback with a hub-minted code. */
export async function ssoDance(app: TestApp, hub: FakeHub, fixture: HubUserFixture): Promise<Response> {
  const { state, stateCookie, scope } = await ssoInitiate(app);
  const code = hub.mintCode(fixture, scope);
  return app.app.request(
    `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: stateCookie } }
  );
}

/** A successful dance: 302 to the callbackURL with a live session cookie. */
export async function ssoLogin(app: TestApp, hub: FakeHub, fixture: HubUserFixture): Promise<string> {
  const res = await ssoDance(app, hub, fixture);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/');
  return extractCookie(res);
}

/** Assert a callback response is a session-less redirect carrying an error code. */
export async function expectFailedLogin(app: TestApp, res: Response, errorContains: string): Promise<void> {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain(errorContains);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    // Whatever cookies the failure path left behind must not resolve a session.
    const me = await app.app.request('/api/v1/me', { headers: { cookie: extractCookie(res) } });
    expect(me.status).toBe(401);
  }
}

/**
 * The in-process OAuth 2.1 dance against the instance's OWN authorization
 * server (register once per app + PKCE + consent) — mints a Bearer JWT for
 * the session's user, so suites can exercise the third credential path.
 *
 * Bound to the scope string the dance requests: the scope NAMES are the
 * tool's, so each host binds its own (`openid <the tool's read scope>`).
 */
const oauthClientIds = new WeakMap<TestApp, string>();
export function makeOauthBearer(scope: string): (app: TestApp, cookie: string) => Promise<string> {
  return (app, cookie) => oauthBearerFor(scope, app, cookie);
}

async function oauthBearerFor(scope: string, app: TestApp, cookie: string): Promise<string> {
  const { createHash, randomBytes } = await import('node:crypto');
  const redirectUri = 'http://127.0.0.1:19999/callback';
  let clientId = oauthClientIds.get(app);
  if (!clientId) {
    const register = await app.app.request(
      '/api/v1/auth/oauth2/register',
      json({
        client_name: 'sso-helper-client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    );
    expect([200, 201]).toContain(register.status);
    clientId = (await readJson(register)).client_id as string;
    oauthClientIds.set(app, clientId);
  }
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: 'helper-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'http://localhost:3000/mcp'
  });
  const authorize = await app.app.request(`/api/v1/auth/oauth2/authorize?${params}`, {
    headers: { cookie }
  });
  let location: string;
  if (authorize.status === 302) {
    location = authorize.headers.get('location') ?? '';
  } else {
    expect(authorize.status).toBe(200);
    location = (await readJson(authorize)).url;
  }
  let codeUrl: URL;
  if (location.includes('/oauth/consent?')) {
    const consent = await app.app.request('/api/v1/auth/oauth2/consent', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: location.split('?')[1] ?? '' })
    });
    expect(consent.status).toBe(200);
    const body = await readJson(consent);
    codeUrl = new URL(body.redirect_uri ?? body.url ?? '');
  } else {
    codeUrl = new URL(location);
  }
  const code = codeUrl.searchParams.get('code');
  expect(code).toBeTruthy();
  const token = await app.app.request('/api/v1/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: 'http://localhost:3000/mcp'
    })
  });
  expect(token.status).toBe(200);
  return (await readJson(token)).access_token as string;
}
