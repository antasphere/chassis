import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { defineChassisContract } from '@antasphere/chassis-contract';
import * as chassisRoutes from '@antasphere/chassis-contract/routes';
import { workspaceMembers } from '@antasphere/chassis-db';
import { DEMO_SESSION_REFUSED_API_ROUTES } from '@antasphere/chassis-server/identity';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  host,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * A session a demo link opened is a visit: it mints no credential for anyone
 * and owns nothing that outlives the pass. The API half of that rule is ONE
 * list, `DEMO_SESSION_REFUSED_API_ROUTES`, mounted once in `create-api.ts`.
 * This file pins the list at work on the routes that mint a credential for
 * someone else (an invitation, a reset link, an email change link), walks the
 * contract so a new route that answers a credential cannot be added without
 * joining the list, and pins two ends of a pass the suite did not cover: a
 * pause refuses its redeem until the person is back, and a removal ends the
 * sessions it opened in its own transaction.
 */

const PASSWORD = 'a-long-demo-pass-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };
const DEMO_ON = { DEMO_SIGN_IN: 'true' };

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let owner: Actor;
let demoAdmin: Actor;
let real: Actor;

let ipCounter = 0;
const nextIp = () => `10.89.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, who: { cookie?: string } = {}, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      origin: ORIGIN,
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(email: string): Promise<string> {
  const res = await send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function memberIdOf(userId: string): Promise<string> {
  const { rows } = await app.db.pool.query<{ id: string }>(
    `SELECT id FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId]
  );
  return rows[0]!.id;
}

async function addMember(email: string, role: 'admin' | 'member'): Promise<Actor> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: created.user.id, role, origin: 'local' });
  return {
    email,
    cookie: await signIn(email),
    userId: created.user.id,
    memberId: await memberIdOf(created.user.id)
  };
}

async function mint(email: string): Promise<{ id: string; secret: string }> {
  const res = await send('POST', '/demo/passes', owner, { email });
  const minted = await readJson(res);
  expect(res.status, JSON.stringify(minted)).toBe(201);
  return { id: minted.pass.id, secret: minted.secret };
}

const redeem = (secret: string) => send('POST', '/auth/demo/redeem', {}, { pass: secret });

/** Mint a pass for `email`, redeem it, and answer the session cookie it set. */
async function passCookieFor(email: string): Promise<string> {
  const res = await redeem((await mint(email)).secret);
  expect(res.status).toBe(200);
  const cookie = extractCookie(res);
  expect(cookie).toBeTruthy();
  return cookie;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'demo_pass_rules'), DEMO_ON);
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Demo', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  const setupBody = await readJson(setup);
  workspaceId = setupBody.workspaceId;
  owner = {
    email: OWNER.email,
    cookie: await signIn(OWNER.email),
    userId: setupBody.ownerUserId,
    memberId: await memberIdOf(setupBody.ownerUserId)
  };
  demoAdmin = await addMember('demo-admin@example.com', 'admin');
  real = await addMember('real-member@antasphere-customer.io', 'member');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a demo link’s session mints no credential for anyone', () => {
  it('1. sends no invitation, even as an admin; the owner’s own session does', async () => {
    const cookie = await passCookieFor(demoAdmin.email);
    const body = { email: 'real-outside@x.test', role: 'admin' };
    await expectError(await send('POST', '/invitations', { cookie }, body), 403, 'demo_session');
    const { rows } = await app.db.pool.query(`SELECT id FROM invitations WHERE lower(email) = $1`, [
      'real-outside@x.test'
    ]);
    expect(rows).toHaveLength(0);
    expect((await send('POST', '/invitations', owner, body)).status).toBe(201);
  });

  it('2. makes no password reset link, even the owner’s own self-pass; the owner’s own session does', async () => {
    const cookie = await passCookieFor(OWNER.email);
    await expectError(
      await send('POST', `/members/${real.memberId}/reset-link`, { cookie }),
      403,
      'demo_session'
    );
    expect((await send('POST', `/members/${real.memberId}/reset-link`, owner)).status).toBe(200);
  });

  it('3. makes no email change link from the owner’s self-pass; the owner’s own session does', async () => {
    const cookie = await passCookieFor(OWNER.email);
    const body = { newEmail: 'moved-real-member@antasphere-customer.io' };
    await expectError(
      await send('POST', `/members/${real.memberId}/change-email-link`, { cookie }, body),
      403,
      'demo_session'
    );
    expect((await send('POST', `/members/${real.memberId}/change-email-link`, owner, body)).status).toBe(200);
  });

  it('4. creates no API key', async () => {
    const cookie = await passCookieFor(demoAdmin.email);
    await expectError(
      await send('POST', '/api-keys', { cookie }, { name: 'from-a-pass', scopes: [host.scopes.read] }),
      403,
      'demo_session'
    );
  });

  it('6. registers no OAuth client under the person (F3); an anonymous registration still answers', async () => {
    const cookie = await passCookieFor(demoAdmin.email);
    const client = {
      client_name: 'from-a-pass',
      redirect_uris: ['http://localhost:9999/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    };
    await expectError(await send('POST', '/auth/oauth2/register', { cookie }, client), 403, 'demo_session');
    const { rows } = await app.db.pool.query(`SELECT client_id FROM oauth_client WHERE name = $1`, [
      'from-a-pass'
    ]);
    expect(rows).toHaveLength(0);
    expect([200, 201]).toContain((await send('POST', '/auth/oauth2/register', {}, client)).status);
  });
});

describe('the contract walk: every route that answers a credential is on the list', () => {
  /** Top-level keys of a 2xx JSON answer that carry a credential for someone. */
  const CREDENTIAL_KEYS = new Set(['resetUrl', 'verifyUrl', 'acceptUrl', 'secret', 'apiKey', 'key']);
  /** Routes no session reaches, so no demo link's session either. */
  const EXCLUDED: Record<string, string> = {
    'POST /cli/auth/complete': 'no session: the CLI completes an emailed code, signed out',
    'POST /sso/cli-connect':
      'no session: a hub exchange token, and cloud only, where demo sign-in never runs',
    'POST /setup': 'no session: the first boot’s setup token'
  };
  const EXCLUDED_PREFIXES: Record<string, string> = {
    '/auth/': 'the sign-in library’s own mount: DEMO_SESSION_REFUSED_AUTH_PATHS judges it'
  };

  type RouteLike = { method: string; path: string; responses: Record<string, unknown> };
  const isRoute = (value: unknown): value is RouteLike =>
    !!value && typeof value === 'object' && 'method' in value && 'path' in value && 'responses' in value;

  /** Unwrap optional, nullable, default and readonly to the schema underneath. */
  function unwrap(schema: unknown): unknown {
    let current = schema as { _zod?: { def?: { type?: string; innerType?: unknown } } } | undefined;
    for (let i = 0; i < 10; i++) {
      const def = current?._zod?.def;
      if (!def || !['optional', 'nullable', 'default', 'readonly'].includes(def.type ?? '')) break;
      current = def.innerType as typeof current;
    }
    return current;
  }

  function credentialKeys(route: RouteLike): string[] {
    const found = new Set<string>();
    for (const [status, response] of Object.entries(route.responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      const schema = unwrap(
        (response as { content?: Record<string, { schema?: unknown }> })?.content?.['application/json']
          ?.schema
      ) as { shape?: Record<string, unknown> } | undefined;
      const keys = Object.keys(schema?.shape ?? {});
      for (const key of keys) if (CREDENTIAL_KEYS.has(key)) found.add(key);
      if (keys.includes('url') && keys.includes('secret')) found.add('url');
    }
    return [...found];
  }

  /** OpenAPI `{id}` → the router's `:id`, every parameter name normalized so `:id` matches `:userId`. */
  const routerPath = (path: string) => path.replace(/\{[^}]+\}/g, ':p');

  function onTheList(method: string, path: string): boolean {
    const target = routerPath(path);
    return DEMO_SESSION_REFUSED_API_ROUTES.some((rule) => {
      if (rule.method !== 'ALL' && rule.method !== method) return false;
      const rulePath = rule.path.replace(/:[A-Za-z]+/g, ':p');
      if (rulePath.endsWith('/*')) return target.startsWith(rulePath.slice(0, -1));
      return target === rulePath;
    });
  }

  it('5. finds the credential routes in the contract and every one is refused a demo link’s session', () => {
    const contract = defineChassisContract({
      scopes: [host.scopes.read, host.scopes.write, host.scopes.dataExport]
    });
    const scoped = chassisRoutes.defineChassisRoutes(contract, host.identity, {
      fileInUseOpenApi: 'file_in_use'
    });
    const exported: unknown[] = [...Object.values(chassisRoutes), ...Object.values(scoped)];
    const routes = exported.filter(isRoute);
    expect(routes.length).toBeGreaterThan(40);

    const covered: string[] = [];
    const excluded: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const name = `${method} ${route.path}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const keys = credentialKeys(route);
      if (keys.length === 0) continue;
      const prefix = Object.keys(EXCLUDED_PREFIXES).find((p) => route.path.startsWith(p));
      if (EXCLUDED[name] || prefix) {
        excluded.push(`${name} (${EXCLUDED[name] ?? EXCLUDED_PREFIXES[prefix!]})`);
      } else if (onTheList(method, route.path)) {
        covered.push(`${name} [${keys.join(', ')}]`);
      } else {
        missing.push(`${name} [${keys.join(', ')}]`);
      }
    }
    console.log(`demo session refusals, covered:\n  ${covered.join('\n  ')}`);
    console.log(`demo session refusals, excluded:\n  ${excluded.join('\n  ')}`);
    expect(covered.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

describe('two ends of a pass', () => {
  it('S-M7. a paused person’s pass does not redeem; back from the pause, the same secret does', async () => {
    const paused = await addMember('paused@example.com', 'member');
    const { secret } = await mint(paused.email);

    const pause = await send('PATCH', `/members/${paused.memberId}`, owner, { isActive: false });
    expect(pause.status).toBe(200);
    await expectError(await redeem(secret), 401, 'invalid_demo_pass');

    const back = await send('PATCH', `/members/${paused.memberId}`, owner, { isActive: true });
    expect(back.status).toBe(200);
    expect((await redeem(secret)).status).toBe(200);
  });

  it('S-M4. a removal ends the session a pass opened in its own transaction, with no request in between', async () => {
    const removed = await addMember('removed@example.com', 'member');
    const pass = await mint(removed.email);
    expect((await redeem(pass.secret)).status).toBe(200);
    const { rows: before } = await app.db.pool.query<{ session_id: string }>(
      `SELECT session_id FROM demo_pass_sessions WHERE pass_id = $1`,
      [pass.id]
    );
    expect(before).toHaveLength(1);
    const sessionId = before[0]!.session_id;
    expect((await app.db.pool.query(`SELECT id FROM session WHERE id = $1`, [sessionId])).rows).toHaveLength(
      1
    );

    const removal = await send('POST', `/members/${removed.memberId}/remove`, owner);
    expect(removal.status).toBe(200);

    expect((await app.db.pool.query(`SELECT id FROM session WHERE id = $1`, [sessionId])).rows).toHaveLength(
      0
    );
    expect(
      (
        await app.db.pool.query(`SELECT session_id FROM demo_pass_sessions WHERE session_id = $1`, [
          sessionId
        ])
      ).rows
    ).toHaveLength(0);
  });
});
