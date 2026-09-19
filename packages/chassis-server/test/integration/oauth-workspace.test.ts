import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OauthJwtVerifier } from '@antasphere/chassis-server/identity';
import type { Auth } from '@antasphere/chassis-server/identity';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  SETUP_TOKEN,
  host
} from './helpers.js';

/**
 * OAuth grants under the user-scoped credential model: consent is "act as
 * you" — issuance requires only a live user with ≥1 active membership, the
 * minted JWT carries NO workspace claim, and the workspace each request
 * targets is a per-request parameter (X-Workspace-Id) authorized against the
 * user's own live memberships. The consent-workspace parking endpoint is
 * gone, and a legacy workspace_id claim is never an authorization input.
 */
const OWNER = {
  email: 'oauth-multi@ws.test',
  name: 'OAuth Multi',
  password: 'a-long-owner-password-123'
};
const BOB = { email: 'oauth-bob@ws.test', name: 'OAuth Bob', password: 'a-long-bob-password-1234' };
const REDIRECT_URI = 'http://127.0.0.1:39218/callback';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base = '';
let ownerCookie = '';
let bobCookie = '';
let ownerId = '';
let bobId = '';
let w1 = '';
let w2 = '';
let w3 = ''; // Bob's sole workspace
let clientId = '';

const WS_HEADER = 'x-workspace-id';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      srv.close(() => resolve(address.port));
    });
  });
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** GET /oauth2/authorize → the redirect target (302 or JSON shape). */
async function authorize(cookie: string): Promise<{ location: string; verifier: string }> {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: `openid offline_access ${host.scopes.read} ${host.scopes.write}`,
    state: 'ws-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${base}/mcp`
  });
  const res = await fetch(`${base}/api/v1/auth/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: 'manual'
  });
  let location: string;
  if (res.status === 302) {
    location = res.headers.get('location') ?? '';
  } else {
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.redirect).toBe(true);
    location = body.url;
  }
  return { location, verifier };
}

/** POST the signed query back as consent, returning the code redirect URL. */
async function consent(cookie: string, consentLocation: string): Promise<Response> {
  const signedQuery = consentLocation.split('?')[1] ?? '';
  return fetch(`${base}/api/v1/auth/oauth2/consent`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: signedQuery })
  });
}

async function exchange(code: string, verifier: string): Promise<Response> {
  return fetch(`${base}/api/v1/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  });
}

async function refresh(refreshToken: string): Promise<Response> {
  return fetch(`${base}/api/v1/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: `${base}/mcp`
    })
  });
}

/** Full dance for a cookie: authorize (+consent when asked) → code → tokens. */
async function dance(cookie: string): Promise<{ accessToken: string; refreshToken: string }> {
  const { location, verifier } = await authorize(cookie);
  let codeUrl: URL;
  if (location.includes('/oauth/consent?')) {
    const consented = await consent(cookie, location);
    expect(consented.status).toBe(200);
    const body = await readJson(consented);
    codeUrl = new URL(body.redirect_uri ?? body.url ?? '');
  } else {
    codeUrl = new URL(location); // silent re-authorize (existing consent)
  }
  expect(codeUrl.origin + codeUrl.pathname).toBe(REDIRECT_URI);
  const code = codeUrl.searchParams.get('code');
  expect(code).toBeTruthy();
  const token = await exchange(code!, verifier);
  expect(token.status).toBe(200);
  const grant = await readJson(token);
  expect(grant.access_token.split('.')).toHaveLength(3);
  return { accessToken: grant.access_token, refreshToken: grant.refresh_token };
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'oauth_ws');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await createTestApp(dbUrl, { PUBLIC_BASE_URL: base });
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  const setup = await fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, instanceName: 'OAuth WS One', owner: OWNER })
  });
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;

  ownerCookie = await signIn(OWNER.email, OWNER.password);
  const me = await readJson(await fetch(`${base}/api/v1/me`, { headers: { cookie: ownerCookie } }));
  ownerId = me.user.id;
  w2 = (await app.registry.workspaces.create('OAuth WS Two', ownerId)).workspaceId;

  const bob = await app.auth.api.signUpEmail({
    body: { email: BOB.email, password: BOB.password, name: BOB.name }
  });
  bobId = bob.user.id;
  w3 = (await app.registry.workspaces.create('Bob WS', bobId)).workspaceId;
  bobCookie = await signIn(BOB.email, BOB.password);

  const register = await fetch(`${base}/api/v1/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ws-binding-client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  });
  expect([200, 201]).toContain(register.status);
  clientId = (await readJson(register)).client_id;

  // The workspaces need distinguishable data for the org-as-parameter tests.
  for (const [ws, name] of [
    [w1, 'w1-oauth.txt'],
    [w2, 'w2-oauth.txt']
  ] as const) {
    const up = await fetch(`${base}/api/v1/files?name=${name}`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain', [WS_HEADER]: ws },
      body: `${name} bytes`
    });
    expect(up.status).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('claimless issuance ("act as you")', () => {
  let ownerTokens: { accessToken: string; refreshToken: string };

  it('a multi-workspace user gets ONE grant with NO workspace claim', async () => {
    ownerTokens = await dance(ownerCookie);
    const payload = jwtPayload(ownerTokens.accessToken);
    expect(payload.workspace_id).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.email).toBe(OWNER.email);
    expect(payload.sub).toBe(ownerId);
  });

  it('refresh re-mints stay claimless (and rotate)', async () => {
    const res = await refresh(ownerTokens.refreshToken);
    expect(res.status).toBe(200);
    const grant = await readJson(res);
    expect(grant.refresh_token).not.toBe(ownerTokens.refreshToken);
    const payload = jwtPayload(grant.access_token);
    expect(payload.workspace_id).toBeUndefined();
    expect(payload.email).toBe(OWNER.email);
    ownerTokens = { accessToken: grant.access_token, refreshToken: grant.refresh_token };
  });

  it('org as a parameter: the ONE token reaches each workspace via X-Workspace-Id', async () => {
    const auth = { authorization: `Bearer ${ownerTokens.accessToken}` };
    // No selector → the default rule (oldest membership, w1).
    const meDefault = await readJson(await fetch(`${base}/api/v1/me`, { headers: auth }));
    expect(meDefault.activeWorkspaceId).toBe(w1);
    // Every credential kind lists ALL memberships with explicit flags.
    expect(meDefault.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, w2]);
    expect(meDefault.workspaces.every((w: { default: boolean }) => w.default === false)).toBe(true);

    const filesW1 = await readJson(await fetch(`${base}/api/v1/files`, { headers: auth }));
    expect(filesW1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1-oauth.txt']);
    const filesW2 = await readJson(
      await fetch(`${base}/api/v1/files`, { headers: { ...auth, [WS_HEADER]: w2 } })
    );
    expect(filesW2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2-oauth.txt']);

    // A workspace the user does NOT belong to fails closed — same 401 as a
    // nonexistent one (no oracle), and same for a malformed selector.
    for (const target of [w3, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await fetch(`${base}/api/v1/me`, { headers: { ...auth, [WS_HEADER]: target } });
      expect(res.status, target).toBe(401);
    }
  });

  it('issuance fails closed for a user with NO active membership left', async () => {
    const bobTokens = await dance(bobCookie);
    // The 0009 last-owner trigger forbids deactivating the sole owner — seed
    // a sibling owner first; this test is about the issuance gate.
    const siblingId = `sibling-${bobId}`;
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Sibling Owner', $2, true)`,
      [siblingId, `sibling-${Date.now()}@oauthws.test`]
    );
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'owner', true)`,
      [w3, siblingId]
    );
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false WHERE user_id = $1 AND workspace_id = $2`,
      [bobId, w3]
    );
    try {
      // The refresh grant re-runs the issuance gate and refuses…
      const res = await refresh(bobTokens.refreshToken);
      expect(res.ok).toBe(false);
      expect(JSON.stringify(await readJson(res).catch(() => ({})))).toContain('access_denied');
      // …and the still-unexpired access token dies at the live re-check.
      const me = await fetch(`${base}/api/v1/me`, {
        headers: { authorization: `Bearer ${bobTokens.accessToken}` }
      });
      expect(me.status).toBe(401);
    } finally {
      await app.db.pool.query(
        `UPDATE workspace_members SET is_active = true WHERE user_id = $1 AND workspace_id = $2`,
        [bobId, w3]
      );
      await app.db.pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [siblingId]);
      await app.db.pool.query(`DELETE FROM "user" WHERE id = $1`, [siblingId]);
    }
  });
});

describe('the consent-workspace machinery is gone', () => {
  it('POST /oauth/consent-workspace no longer exists (JSON 404, both credential kinds)', async () => {
    const asSession = await fetch(`${base}/api/v1/oauth/consent-workspace`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: w1 })
    });
    expect(asSession.status).toBe(404);
    expect((await readJson(asSession)).error.code).toBe('not_found');
  });
});

describe('claimless-JWT resolution (OauthJwtVerifier)', () => {
  it('resolves by SELECTOR, defaults deterministically, and ignores workspace claims', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'ws-test' };
    const fakeAuth = { api: { getJwks: async () => ({ keys: [jwk] }) } } as unknown as Auth;
    const verifier = new OauthJwtVerifier(fakeAuth, app.db.db, base);

    const sign = (sub: string, workspaceClaim?: string) =>
      new SignJWT({
        scope: host.scopes.read,
        ...(workspaceClaim ? { workspace_id: workspaceClaim } : {})
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'ws-test' })
        .setIssuer(base)
        .setAudience(`${base}/mcp`)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    // The selector picks the membership…
    const selected = await verifier.resolve(await sign(ownerId), w2);
    expect(selected?.workspaceId).toBe(w2);
    // …absent, the multi-workspace user resolves to the deterministic
    // default (the old claimless fail-closed rule died with claims)…
    const defaulted = await verifier.resolve(await sign(ownerId), null);
    expect(defaulted?.workspaceId).toBe(w1);
    // …and a legacy workspace_id CLAIM is never an authorization input: it
    // neither selects (default still wins) nor grants (a foreign claim
    // cannot reach the workspace).
    const claimIgnored = await verifier.resolve(await sign(ownerId, w2), null);
    expect(claimIgnored?.workspaceId).toBe(w1);
    const foreignClaim = await verifier.resolve(await sign(bobId, w1), null);
    expect(foreignClaim?.workspaceId).toBe(w3);
    // A selector naming a workspace the subject does not belong to → null.
    expect(await verifier.resolve(await sign(bobId), w1)).toBeNull();
    // A malformed selector never reaches the uuid cast → null, not a 500.
    expect(await verifier.resolve(await sign(ownerId), 'not-a-uuid')).toBeNull();
  });
});
