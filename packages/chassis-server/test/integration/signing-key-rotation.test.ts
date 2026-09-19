import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createHash, randomBytes } from 'node:crypto';
import { createDb as createChassisDb, schema } from '@antasphere/chassis-db';
import { preflightSigningKey, retireSigningKey, runSigningKeyCli } from '@antasphere/chassis-server/identity';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

// The signing-key tooling reads the chassis `jwks` table only: the chassis schema is enough.
const createDb = (url: string) => createChassisDb(url, schema);

/**
 * Signing-key durability across AUTH_SECRET rotation (ADR 023). The failure
 * this pins: the jwt plugin's RS256 private key is stored encrypted under
 * AUTH_SECRET with no expiry, so the plugin never replaces it — after the
 * runbook's old rotation procedure the instance BOOTED but answered 500 on
 * every POST /oauth2/token, forever.
 *
 * The contract now: boot on a database whose newest signing key does not
 * decrypt under the current secret must REFUSE (fail-fast preflight with the
 * actionable diagnostic) — never serve an authorize it cannot follow with a
 * token mint. The remedy is the rotate-signing-key operator command: a new
 * key minted under the new secret signs from then on, while the retired
 * key's PUBLIC half stays published on /jwks, so tokens signed before the
 * rotation still verify (the publish-overlap window) until the old key is
 * explicitly retired.
 */

const OWNER = { email: 'owner@skr.test', name: 'Skr Owner', password: 'skr-owner-password-123' };
const SECRET_A = 'signing-key-secret-A-0123456789abcdef0123456789abcdef';
const SECRET_B = 'signing-key-secret-B-0123456789abcdef0123456789abcdef';
// Loopback redirect target; never listened on — we only parse the redirect.
const REDIRECT_URI = 'http://127.0.0.1:39240/callback';
/** The instance's own audience — tokens with this aud authorize /api/v1 requests. */
const RESOURCE = 'http://localhost:3000/mcp';

let container: StartedPostgreSqlContainer;
let dbUrl: string;
let app: TestApp;
/** DCR public client, registered once in boot A; the row persists across boots. */
let clientId: string;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Follow one better-auth redirect answer: a browser-shaped request gets a
 * 302 Location; a fetch-shaped one gets `{ redirect: true, url }` as JSON.
 * app.request() sends no sec-fetch-mode, but pin neither shape — handle both.
 */
async function redirectTarget(res: Response): Promise<string> {
  if (res.status === 302) return res.headers.get('location') ?? '';
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.redirect).toBe(true);
  return body.url as string;
}

/**
 * Full PKCE dance for the instance's own audience; returns the token
 * response. First pass walks the consent page; later passes may silently
 * re-authorize on the stored consent — both paths end in a code.
 */
async function danceForToken(instance: TestApp, cookie: string): Promise<Record<string, string>> {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: `openid profile email offline_access ${host.scopes.read}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE
  });
  const authz = await instance.app.request(`/api/v1/auth/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: 'manual'
  });
  let location = await redirectTarget(authz);

  if (location.includes('/oauth/consent?')) {
    // The consent page posts the SIGNED query back verbatim as oauth_query.
    const signedQuery = location.split('?')[1] ?? '';
    const consent = await instance.app.request('/api/v1/auth/oauth2/consent', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: signedQuery })
    });
    if (consent.status === 302) {
      location = consent.headers.get('location') ?? '';
    } else {
      expect(consent.status).toBe(200);
      const body = await readJson(consent);
      location = (body.redirect_uri ?? body.url ?? '') as string;
    }
  }
  const code = new URL(location).searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await instance.app.request('/api/v1/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE
    }).toString()
  });
  return { status: String(token.status), ...((await readJson(token).catch(() => ({}))) as object) };
}

async function signIn(instance: TestApp): Promise<string> {
  const res = await instance.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function jwksKids(): Promise<string[]> {
  const client = createDb(dbUrl);
  try {
    const { rows } = await client.pool.query(`SELECT id FROM jwks ORDER BY created_at ASC, id ASC`);
    return rows.map((r: { id: string }) => r.id);
  } finally {
    await client.pool.end();
  }
}

beforeAll(async () => {
  container = await startPostgres();
  dbUrl = await createDatabase(container, 'signing_key');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('AUTH_SECRET rotation vs OAuth token signing (ADR 023)', () => {
  let oldToken = '';
  /**
   * Every kid minted under SECRET_A. Usually one; the pinned plugin's FIRST
   * issuance can race the id_token and access-token signs into TWO createJwk
   * calls (both under the same secret — harmless, newest wins), so the test
   * carries the list rather than assuming a count.
   */
  let bootAKids: string[] = [];

  it('boot A signs tokens; the access JWT authorizes API requests', async () => {
    app = await createTestApp(dbUrl, { AUTH_SECRET: SECRET_A });
    const setup = await app.app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: 'integration-test-setup-token',
        instanceName: 'SkrInstance',
        owner: OWNER
      })
    });
    expect(setup.status).toBe(201);

    const register = await app.app.request('/api/v1/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'skr-client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    expect([200, 201]).toContain(register.status);
    clientId = (await readJson(register)).client_id;
    expect(clientId).toBeTruthy();

    const grant = await danceForToken(app, await signIn(app));
    expect(grant.status).toBe('200');
    oldToken = grant.access_token!;
    expect(oldToken.split('.')).toHaveLength(3); // an RS256 JWT, not opaque

    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${oldToken}` }
    });
    expect(me.status).toBe(200);

    bootAKids = await jwksKids();
    expect(bootAKids.length).toBeGreaterThanOrEqual(1);
    await app.stop();
  });

  it('booting the SAME database under a rotated AUTH_SECRET fails FAST with the diagnostic — never a booted 500', async () => {
    // Exactly the old runbook's steps: pin the version-1 pepper, change the
    // secret, redeploy. Pre-fix this booted fine and then 500'd on every
    // POST /oauth2/token; the contract now is a refused boot. Deliberately
    // NOT expect(...).rejects: on a wrongly-successful boot that shape would
    // serialize the entire BootResult into the assertion error (and leak the
    // running app) — collect the outcome, stop any leak, assert the message.
    let failure: unknown = null;
    let booted: TestApp | null = null;
    try {
      booted = await createTestApp(dbUrl, {
        AUTH_SECRET: SECRET_B,
        API_KEY_PEPPERS: `1:${SECRET_A}`
      });
    } catch (cause) {
      failure = cause;
    }
    if (booted) await booted.stop();
    expect(booted === null, 'the mis-rotated boot must be REFUSED').toBe(true);
    expect(String(failure)).toMatch(/signing-key preflight failed/);
  });

  it('the preflight module reports precisely: wrong secret fails, right secret passes', async () => {
    const client = createDb(dbUrl);
    try {
      const bad = await preflightSigningKey(client.db, SECRET_B);
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bootAKids).toContain(bad.kid);
        expect(bad.reason).toContain('cannot be decrypted with the current AUTH_SECRET');
        expect(bad.reason).toContain('rotate-signing-key');
      }
      const good = await preflightSigningKey(client.db, SECRET_A);
      expect(good.ok).toBe(true);
    } finally {
      await client.pool.end();
    }
  });

  it('the remedy: rotate-signing-key under the NEW secret, then boot mints again and OLD tokens still verify (overlap)', async () => {
    // The operator command the diagnostic names, run exactly as the runbook
    // says: against the same database, holding the NEW secret.
    const client = createDb(dbUrl);
    const lines: string[] = [];
    try {
      const code = await runSigningKeyCli(client.db, SECRET_B, [], (l) => lines.push(l));
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('overlap');
    } finally {
      await client.pool.end();
    }
    const kids = await jwksKids();
    expect(kids).toHaveLength(bootAKids.length + 1); // retired + active — the publish overlap

    app = await createTestApp(dbUrl, {
      AUTH_SECRET: SECRET_B,
      API_KEY_PEPPERS: `1:${SECRET_A}`
    });

    // Token issuance works again — the durable half of the contract.
    const grant = await danceForToken(app, await signIn(app));
    expect(grant.status).toBe('200');
    expect(grant.access_token).toBeTruthy();

    // Both keys are published…
    const jwksRes = await app.app.request('/api/v1/auth/jwks');
    expect(jwksRes.status).toBe(200);
    const jwksBody = await readJson(jwksRes);
    expect(jwksBody.keys.map((k: { kid: string }) => k.kid).sort()).toEqual([...kids].sort());

    // …so the token signed BEFORE the rotation still authorizes requests.
    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${oldToken}` }
    });
    expect(me.status).toBe(200);
  });

  it('a LIVE rotation is picked up mid-cache: tokens signed by a just-minted key verify immediately', async () => {
    // Warm the verifier's JWKS cache with the current key set…
    const cookie = await signIn(app);
    const warm = await danceForToken(app, cookie);
    expect(warm.status).toBe('200');
    const warmed = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${warm.access_token}` }
    });
    expect(warmed.status).toBe(200);

    // …mint a NEW signing key while the process runs (the compromise-drill
    // path — no restart)…
    const client = createDb(dbUrl);
    try {
      expect(await runSigningKeyCli(client.db, SECRET_B, [], () => {})).toBe(0);
    } finally {
      await client.pool.end();
    }

    // …and a token the plugin now signs with the fresh key must authorize
    // IMMEDIATELY: the verifier refetches once on the unknown kid instead of
    // answering 401 until its 10-minute cache expires.
    const fresh = await danceForToken(app, cookie);
    expect(fresh.status).toBe('200');
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${fresh.access_token}` }
    });
    expect(res.status).toBe(200);
  });

  it('retiring the old key removes it from /jwks and its tokens stop verifying; the ACTIVE key is refused', async () => {
    const client = createDb(dbUrl);
    try {
      const kids = await jwksKids(); // createdAt ASC — the last one signs
      const activeKid = kids.at(-1)!;
      await expect(retireSigningKey(client.db, activeKid)).rejects.toThrow(/ACTIVE signing key/);
      for (const kid of kids.filter((k) => k !== activeKid)) {
        const code = await runSigningKeyCli(client.db, SECRET_B, ['--retire', kid], () => {});
        expect(code).toBe(0);
      }
    } finally {
      await client.pool.end();
    }
    expect(await jwksKids()).toHaveLength(1);

    const jwksRes = await app.app.request('/api/v1/auth/jwks');
    const jwksBody = await readJson(jwksRes);
    for (const kid of bootAKids) {
      expect(jwksBody.keys.map((k: { kid: string }) => k.kid)).not.toContain(kid);
    }

    // End of the overlap window: once verifier caches roll over (modelled
    // here as a fresh boot — the in-process cache holds 10 min), the retired
    // key's tokens are refused. Same-process acceptance inside the cache TTL
    // is the documented cache behavior, not a regression.
    await app.stop();
    app = await createTestApp(dbUrl, {
      AUTH_SECRET: SECRET_B,
      API_KEY_PEPPERS: `1:${SECRET_A}`
    });
    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${oldToken}` }
    });
    expect(me.status).toBe(401);
  });
});
