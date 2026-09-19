import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
 * The scripted OAuth 2.1 + MCP dance (M6 exit): everything a real MCP client
 * (claude.ai, inspector) does against a fresh instance, via fetch against a
 * REAL listening server — the MCP SDK client needs a URL, and Better Auth's
 * redirects must carry the true origin.
 *
 * DCR register → authorize (session + consent accept) → PKCE code exchange →
 * JWT works on /api/v1/me AND on /mcp via the SDK client → refresh rotation →
 * deactivating the membership kills refresh AND live verification.
 */
const OWNER = {
  email: 'oauth-owner@example.com',
  name: 'OAuth Owner',
  password: 'a-long-owner-password-123'
};
// Loopback redirect target; never actually listened on — we only parse the
// redirect URL the AS hands back.
const REDIRECT_URI = 'http://127.0.0.1:39217/callback';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base: string;
let cookie: string;
let clientId: string;
let verifier: string;
let accessToken: string;
let refreshToken: string;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
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

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'oauth_dance');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // PUBLIC_BASE_URL must equal the real serving origin: it is the OAuth
  // issuer, the discovery root, and the /mcp audience all at once.
  app = await createTestApp(dbUrl, { PUBLIC_BASE_URL: base });
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  const setup = await fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, instanceName: 'Dance Instance', owner: OWNER })
  });
  expect(setup.status).toBe(201);

  const signIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  expect(signIn.status).toBe(200);
  cookie = extractCookie(signIn);
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('discovery surface', () => {
  it('serves RFC 8414 AS metadata at the origin root, matching PUBLIC_BASE_URL', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const doc = await readJson(res);
    expect(doc.issuer).toBe(base);
    expect(doc.authorization_endpoint).toBe(`${base}/api/v1/auth/oauth2/authorize`);
    expect(doc.token_endpoint).toBe(`${base}/api/v1/auth/oauth2/token`);
    expect(doc.registration_endpoint).toBe(`${base}/api/v1/auth/oauth2/register`);
    expect(doc.jwks_uri).toBe(`${base}/api/v1/auth/jwks`);
    expect(doc.code_challenge_methods_supported).toContain('S256');
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });

  it('serves openid-configuration at the origin root', async () => {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = await readJson(res);
    expect(doc.issuer).toBe(base);
  });

  it('serves RFC 9728 protected-resource metadata (origin + path-aware)', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp'
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const doc = await readJson(res);
      expect(doc.resource).toBe(`${base}/mcp`);
      expect(doc.authorization_servers).toEqual([base]);
      expect(doc.bearer_methods_supported).toEqual(['header']);
      expect(doc.scopes_supported).toContain(host.scopes.read);
    }
  });

  it('advertises mcp + oauth in instance discovery', async () => {
    const res = await fetch(`${base}/api/v1/instance`);
    const body = await readJson(res);
    expect(body.features.mcp).toBe(true);
    expect(body.features.oauth).toBe(true);
    expect(body.auth.methods).toContain('oauth');
  });

  it('answers CORS preflight on the token endpoint without consuming anything', async () => {
    const res = await fetch(`${base}/api/v1/auth/oauth2/token`, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('401 challenge on /mcp', () => {
  it('carries the RFC 9728 resource_metadata pointer', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('rejects a garbage JWT with the same challenge', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer aaa.bbb.ccc' }
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });
});

describe('the full dance', () => {
  it('registers a client dynamically (RFC 7591, unauthenticated)', async () => {
    const res = await fetch(`${base}/api/v1/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'dance-test-client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    // Better Auth 1.6.15 answers 200 (not RFC 7591's 201) — both fine here.
    expect([200, 201]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await readJson(res);
    expect(body.client_id).toBeTruthy();
    clientId = body.client_id;
  });

  it('rejects a client whose client_uri is not an http(s) URL (consent XSS boundary)', async () => {
    const res = await fetch(`${base}/api/v1/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'evil-client',
        client_uri: 'javascript:alert(document.domain)',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code']
      })
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    // RFC 7591 error shape; the exact key nesting is Better Auth's.
    expect(JSON.stringify(body)).toContain('invalid_client_metadata');
  });

  it('rejects a javascript: logo_uri too', async () => {
    const res = await fetch(`${base}/api/v1/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'evil-logo',
        logo_uri: 'javascript:alert(1)',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code']
      })
    });
    expect(res.status).toBe(400);
  });

  it('authorize with a session but no consent redirects to the consent page', async () => {
    verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: `openid profile email offline_access ${host.scopes.read} ${host.scopes.write}`,
      state: 'dance-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${base}/mcp`
    });
    const res = await fetch(`${base}/api/v1/auth/oauth2/authorize?${params}`, {
      headers: { cookie },
      redirect: 'manual'
    });
    // Browser navigations get a 302; fetch-flavored requests (sec-fetch-mode)
    // get { redirect: true, url } as JSON — accept either, like the SPA does.
    let location: string;
    if (res.status === 302) {
      location = res.headers.get('location') ?? '';
    } else {
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.redirect).toBe(true);
      location = body.url;
    }
    expect(location).toContain('/oauth/consent?');
    // The consent page hands the SIGNED query back verbatim as oauth_query.
    const signedQuery = location.split('?')[1] ?? '';
    expect(new URLSearchParams(signedQuery).get('sig')).toBeTruthy();

    const consent = await fetch(`${base}/api/v1/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: signedQuery })
    });
    expect(consent.status).toBe(200);
    const consentBody = await readJson(consent);
    const redirectUrl = new URL(consentBody.redirect_uri ?? consentBody.url ?? '');
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(REDIRECT_URI);
    expect(redirectUrl.searchParams.get('state')).toBe('dance-state');
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    // Token exchange: cookie-less, cross-site form POST (RFC 6749) — the
    // foreign Origin header proves the origin check exempts this endpoint.
    const token = await fetch(`${base}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://claude.ai'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${base}/mcp`
      })
    });
    expect(token.status).toBe(200);
    expect(token.headers.get('cache-control')).toBe('no-store');
    expect(token.headers.get('access-control-allow-origin')).toBe('*');
    const grant = await readJson(token);
    expect(grant.token_type?.toLowerCase()).toBe('bearer');
    expect(grant.access_token.split('.')).toHaveLength(3); // an RS256 JWT, not opaque
    expect(grant.refresh_token).toBeTruthy();
    // User-scoped grant ("act as you"): the token identifies the USER and
    // carries no workspace authority — the org is a per-request parameter.
    const payload = JSON.parse(Buffer.from(grant.access_token.split('.')[1]!, 'base64url').toString());
    expect(payload.workspace_id).toBeUndefined();
    expect(payload.email).toBe(OWNER.email);
    accessToken = grant.access_token;
    refreshToken = grant.refresh_token;
  });

  it('the access token works on /api/v1/me as an oauth principal', async () => {
    const res = await fetch(`${base}/api/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.user.email).toBe(OWNER.email);
    expect(body.via).toBe('oauth');
    expect(body.scopes).toContain(host.scopes.read);
    expect(body.scopes).toContain(host.scopes.write);
  });

  it('the token reaches allowlisted endpoints only (fail-closed scope gate)', async () => {
    const files = await fetch(`${base}/api/v1/files`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(files.status).toBe(200);

    const members = await fetch(`${base}/api/v1/members`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(members.status).toBe(403);
    const body = await readJson(members);
    expect(body.error.code).toBe('endpoint_not_allowed');
  });

  it('drives /mcp end-to-end with the official SDK client (initialize + get_me)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    const client = new Client({ name: 'dance-test', version: '0.0.1' });
    // The SDK's own client transport type clashes with its Transport
    // interface under exactOptionalPropertyTypes — runtime-identical.
    await client.connect(transport as Transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('get_me');
    expect(names).toContain('list_files');

    const result = await client.callTool({ name: 'get_me', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    const me = JSON.parse(content[0]?.text ?? '{}');
    expect(me.user.email).toBe(OWNER.email);
    expect(me.via).toBe('oauth');

    const files = await client.callTool({ name: 'list_files', arguments: {} });
    const filesContent = files.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(filesContent[0]?.text ?? '{}')).toHaveProperty('files');

    await client.close();
  });

  it('rotates the refresh token', async () => {
    const res = await fetch(`${base}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: `${base}/mcp`
      })
    });
    expect(res.status).toBe(200);
    const grant = await readJson(res);
    expect(grant.access_token).toBeTruthy();
    expect(grant.refresh_token).toBeTruthy();
    expect(grant.refresh_token).not.toBe(refreshToken); // rotation
    accessToken = grant.access_token;
    refreshToken = grant.refresh_token;
  });

  it('mints an OPAQUE token when the RFC 8707 resource param is omitted — rejected cleanly', async () => {
    // Consent already stored: authorize answers with a code straight away.
    const verifier2 = b64url(randomBytes(48));
    const challenge2 = b64url(createHash('sha256').update(verifier2).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: host.scopes.read,
      code_challenge: challenge2,
      code_challenge_method: 'S256'
      // no `resource`
    });
    const res = await fetch(`${base}/api/v1/auth/oauth2/authorize?${params}`, {
      headers: { cookie },
      redirect: 'manual'
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const code = new URL(body.url).searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await fetch(`${base}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier2
      })
    });
    expect(token.status).toBe(200);
    const grant = await readJson(token);
    // Not aud-bound to /mcp → not a JWT this instance's gates accept.
    expect(grant.access_token.split('.')).not.toHaveLength(3);
    const me = await fetch(`${base}/api/v1/me`, {
      headers: { authorization: `Bearer ${grant.access_token}` }
    });
    expect(me.status).toBe(401);
  });

  it('deactivating the membership kills refresh AND live verification', async () => {
    // The last-owner trigger (migration 0009) forbids deactivating the sole
    // owner, so seed a throwaway sibling owner first — this test is about the
    // issuance gate + live re-check, not the last-owner rule. Then deactivate
    // ONLY the token-holding owner (the sibling keeps the workspace legal).
    const { rows } = await app.db.pool.query<{ workspace_id: string; user_id: string }>(
      `SELECT workspace_id, user_id FROM workspace_members WHERE role = 'owner' AND is_active LIMIT 1`
    );
    const owner = rows[0]!;
    const siblingUserId = `sibling-${owner.user_id}`;
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Sibling Owner', $2, true)`,
      [siblingUserId, `sibling-${Date.now()}@dance.test`]
    );
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'owner', true)`,
      [owner.workspace_id, siblingUserId]
    );
    await app.db.db
      .update(workspaceMembers)
      .set({ isActive: false })
      .where(eq(workspaceMembers.userId, owner.user_id));

    // Refresh grant: the issuance gate re-runs and refuses.
    const refresh = await fetch(`${base}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: `${base}/mcp`
      })
    });
    expect(refresh.status).toBeGreaterThanOrEqual(400);

    // Still-valid (unexpired) access token: the LIVE membership re-check 401s.
    const me = await fetch(`${base}/api/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(me.status).toBe(401);

    // And /mcp challenges again.
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(mcp.status).toBe(401);
  });
});
