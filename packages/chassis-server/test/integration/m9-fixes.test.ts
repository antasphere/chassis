import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * M9 adversarial-campaign regression battery:
 *  - /mcp method handling: non-POST → 405 + Allow: POST, malformed or
 *    non-JSON-RPC POST → 400 JSON-RPC error (never 500), valid POST works;
 *  - every {id} path param validates as a UUID → clean 400/404, never a
 *    Postgres uuid-cast 500 (incl. the DELETE /invitations/lookup residue);
 *  - audit cursor past bigint precision is ignored like a malformed one;
 *  - unmatched /api/v1 paths answer a JSON 404, not the SPA HTML, while the
 *    machine-principal 403 endpoint_not_allowed still fires first;
 *  - sign-in rejects a foreign Origin header (login-CSRF hardening) while
 *    same-origin and origin-less (CLI-style) logins keep working.
 */

const OWNER = { email: 'owner@m9.test', name: 'M9 Owner', password: 'm9-owner-password-1234' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let apiKey: string;

const json = (body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'm9'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'M9', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '10.7.0.1' })
  );
  ownerCookie = extractCookie(signIn);
  const minted = await readJson(
    await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'm9-key', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    })
  );
  apiKey = minted.key as string;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('/mcp method handling (ADR 002)', () => {
  const mcp = (init: RequestInit & { headers?: Record<string, string> }) =>
    app.app.request('/mcp', {
      ...init,
      headers: { 'x-forwarded-for': '10.7.1.1', ...init.headers }
    });

  it('GET is 405 + Allow: POST (no long-lived SSE stream)', async () => {
    const res = await mcp({ method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await readJson(res);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
  });

  it('GET with Accept: application/json is 405, not 500', async () => {
    const res = await mcp({ method: 'GET', headers: { accept: 'application/json' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('DELETE is 405', async () => {
    const res = await mcp({ method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('a malformed (non-JSON) POST body is a 400 JSON-RPC parse error, not a 500', async () => {
    const res = await mcp({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${apiKey}`
      },
      body: 'this is not json {'
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
  });

  it('a non-JSON-RPC JSON POST body is a 400 JSON-RPC error, not a 500', async () => {
    const res = await mcp({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ hello: 'world' })
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.jsonrpc).toBe('2.0');
    expect([-32700, -32600]).toContain(body.error.code);
  });

  it('a valid initialize POST still works (stateless one-server-per-POST)', async () => {
    const res = await mcp({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'm9-test', version: '0.0.0' }
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.result.serverInfo.name).toBeTruthy();
  });

  it('an unauthenticated POST still answers the RFC 9728 challenge', async () => {
    const res = await mcp({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });
});

describe('non-UUID {id} path params answer clean 4xx, never a PG-cast 500', () => {
  const cases: Array<{ name: string; method: string; path: string; body?: unknown }> = [
    {
      name: 'PATCH /members/{id}',
      method: 'PATCH',
      path: '/api/v1/members/not-a-uuid',
      body: { role: 'member' }
    },
    { name: 'DELETE /members/{id}', method: 'DELETE', path: '/api/v1/members/not-a-uuid' },
    { name: 'POST /members/{id}/reset-link', method: 'POST', path: '/api/v1/members/not-a-uuid/reset-link' },
    {
      name: 'POST /members/{id}/change-email-link',
      method: 'POST',
      path: '/api/v1/members/not-a-uuid/change-email-link',
      body: { newEmail: 'x@m9.test' }
    },
    { name: 'DELETE /api-keys/{id}', method: 'DELETE', path: '/api/v1/api-keys/not-a-uuid' },
    { name: 'DELETE /invitations/{id}', method: 'DELETE', path: '/api/v1/invitations/not-a-uuid' },
    { name: 'GET /files/{id}', method: 'GET', path: '/api/v1/files/not-a-uuid' },
    { name: 'DELETE /files/{id}', method: 'DELETE', path: '/api/v1/files/not-a-uuid' }
  ];

  for (const { name, method, path, body } of cases) {
    it(`${name} → 400 validation_error`, async () => {
      const res = await app.app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('validation_error');
    });
  }

  it('the literal-segment residue: DELETE /invitations/lookup → 400, not 500', async () => {
    const res = await app.app.request('/api/v1/invitations/lookup', {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('validation_error');
  });

  it('the plain-Hono content routes 404 a non-UUID id (GET and HEAD)', async () => {
    const get = await app.app.request('/api/v1/files/not-a-uuid/content', {
      headers: { cookie: ownerCookie }
    });
    expect(get.status).toBe(404);
    const head = await app.app.request('/api/v1/files/not-a-uuid/content', {
      method: 'HEAD',
      headers: { cookie: ownerCookie }
    });
    expect(head.status).toBe(404);
  });
});

describe('audit cursor range guard', () => {
  it('ignores a cursor past bigint precision (page 1, not 500)', async () => {
    const res = await app.app.request('/api/v1/audit?cursor=99999999999999999999', {
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0); // setup + key mint are audited
  });

  it('still ignores a NaN cursor', async () => {
    const res = await app.app.request('/api/v1/audit?cursor=banana', {
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
  });
});

describe('JSON 404 terminator on /api/v1', () => {
  it('an unmatched path answers the JSON wire shape for a browser session, not the SPA', async () => {
    const res = await app.app.request('/api/v1/definitely-not-a-route', {
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await readJson(res)).error.code).toBe('not_found');
  });

  it('an unmatched path is a JSON 404 for anonymous callers too', async () => {
    const res = await app.app.request('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('not_found');
  });

  it('an unmatched method on /auth/* is a JSON 404, not the SPA', async () => {
    const res = await app.app.request('/api/v1/auth/get-session', { method: 'PUT' });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('not_found');
  });

  it('machine principals still get 403 endpoint_not_allowed first', async () => {
    const res = await app.app.request('/api/v1/definitely-not-a-route', {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
  });

  it('the SPA fallback still serves non-API paths', async () => {
    const res = await app.app.request('/dashboard-route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('sign-in Origin hardening (login CSRF)', () => {
  const signIn = (extraHeaders: Record<string, string>, ip: string) =>
    app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': ip, ...extraHeaders })
    );

  it('rejects a foreign Origin on sign-in', async () => {
    const res = await signIn({ origin: 'https://evil.com' }, '10.7.2.1');
    expect(res.status).toBe(403);
  });

  it('accepts the configured public origin', async () => {
    const res = await signIn({ origin: 'http://localhost:3000' }, '10.7.2.2');
    expect(res.status).toBe(200);
  });

  it('accepts an origin-less (CLI-style) sign-in', async () => {
    const res = await signIn({}, '10.7.2.3');
    expect(res.status).toBe(200);
  });
});
