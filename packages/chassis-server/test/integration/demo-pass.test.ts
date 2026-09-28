import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import { FakeHub } from '@antasphere/chassis-server/testing';
import {
  createDatabase,
  createTestApp,
  expectBootRefusal,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * Demo sign-in (the demo pass spec): an owner mints a link that signs one
 * member in without a password. The link is sign-in-equivalent, so this suite
 * pins every boundary around it:
 *
 *   the switch      → off, every demo path is an unknown path, signed in or
 *                     not; on, only on a loopback or listed host; on cloud,
 *                     nothing at all
 *   the mint        → owner and session only, the refusals in the spec's
 *                     order, the secret stored as its sha256 and nowhere else
 *   the redeem      → the library's own session and cookie, AS THE MEMBER;
 *                     one answer for every refusal; Origin required; a wall
 *                     of 20 per address
 *   the trail       → mint, use and revoke rows with the right actor, no
 *                     secret anywhere, and a mutation made through a pass's
 *                     session marked with the pass
 */

const PASSWORD = 'a-long-demo-pass-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };
const DEMO_ON = { DEMO_SIGN_IN: 'true' };

type Actor = { email: string; cookie: string; userId: string };

let container: StartedPostgreSqlContainer;
let connectionString = '';
let app: TestApp;
let workspaceId = '';
const actors: Record<string, Actor> = {};
/** Every secret this suite minted: none may ever appear in an audit row. */
const secrets: string[] = [];

let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const send = (
  target: TestApp,
  method: string,
  path: string,
  who: { cookie?: string; key?: string } = {},
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  target.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      origin: ORIGIN,
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(who.key ? { authorization: `Bearer ${who.key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(target: TestApp, email: string): Promise<string> {
  const res = await send(target, 'POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addMember(
  name: string,
  email: string,
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest'; signIn?: boolean } = {}
): Promise<Actor> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await app.db.db.insert(workspaceMembers).values({
    workspaceId,
    userId: created.user.id,
    role: opts.role ?? 'member',
    origin: opts.origin ?? 'local'
  });
  const actor = {
    email,
    cookie: opts.signIn === false ? '' : await signIn(app, email),
    userId: created.user.id
  };
  actors[name] = actor;
  return actor;
}

async function mint(
  who: Actor,
  body: { email: string; path?: string; expiresInMinutes?: number },
  target: TestApp = app
): Promise<{ id: string; secret: string; url: string; pass: Record<string, unknown> }> {
  const res = await send(target, 'POST', '/demo/passes', who, body);
  expect(res.status).toBe(201);
  const minted = await readJson(res);
  secrets.push(minted.secret);
  return { id: minted.pass.id, secret: minted.secret, url: minted.url, pass: minted.pass };
}

const redeem = (secret: string, target: TestApp = app, headers: Record<string, string> = {}) =>
  send(target, 'POST', '/auth/demo/redeem', {}, { pass: secret }, headers);

/** True when a response sets the session cookie (any value, any attributes). */
const setsSession = (res: Response) => (res.headers.get('set-cookie') ?? '').includes('session_token');

/** Status and body of an answer, the request id apart (it is a header, never a body field). */
async function answerOf(res: Response): Promise<{ status: number; body: string }> {
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  container = await startPostgres();
  connectionString = await createDatabase(container, 'demo_pass');
  app = await createTestApp(connectionString, DEMO_ON);
  const setup = await send(
    app,
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Demo', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const ownerCookie = await signIn(app, OWNER.email);
  const me = await readJson(await send(app, 'GET', '/me', { cookie: ownerCookie }));
  actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id };

  await addMember('member', 'member@example.com');
  await addMember('admin', 'admin@example.com', { role: 'admin' });
  await addMember('otherOwner', 'other-owner@example.com', { role: 'owner' });
  await addMember('gmail', 'someone@gmail.com');
  await addMember('twoFactor', 'two-factor@example.com');
  await addMember('twoFactorGmail', 'two-factor@gmail.com');
  await addMember('guest', 'guest@example.org', { origin: 'guest' });
  await addMember('cross', 'cross@team.test');
  await app.db.pool.query(`UPDATE "user" SET two_factor_enabled = true WHERE email LIKE 'two-factor@%'`);
  // `cross` also owns a second workspace: a pass for them would carry into it.
  const second = await send(app, 'POST', '/workspaces', actors.cross!, { name: 'Elsewhere' });
  expect(second.status).toBe(201);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the switch', () => {
  it('a. off: every demo path answers what an unknown path answers, signed out and signed in; /instance has no demoSignIn', async () => {
    const off = await createTestApp(connectionString);
    try {
      const ownerCookie = await signIn(off, OWNER.email);
      for (const who of [{}, { cookie: ownerCookie }]) {
        const unknownApi = await answerOf(
          await send(off, 'POST', '/definitely-not-a-route', who, { email: 'member@example.com' })
        );
        const unknownAuth = await answerOf(
          await send(off, 'POST', '/auth/definitely-not-a-route', who, { pass: 'x' })
        );
        expect(
          await answerOf(await send(off, 'POST', '/demo/passes', who, { email: 'member@example.com' }))
        ).toEqual(unknownApi);
        expect(await answerOf(await send(off, 'GET', '/demo/passes', who))).toEqual(unknownApi);
        expect(
          await answerOf(await send(off, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111', who))
        ).toEqual(unknownApi);
        expect(await answerOf(await redeem('x', off, who.cookie ? { cookie: who.cookie } : {}))).toEqual(
          unknownAuth
        );
      }
      const instance = await readJson(await send(off, 'GET', '/instance'));
      expect('demoSignIn' in instance).toBe(false);
      // …and on, the key is there.
      expect((await readJson(await send(app, 'GET', '/instance'))).demoSignIn).toBe(true);
    } finally {
      await off.stop();
    }
  });

  it('b. the boot refuses the switch on a public host nobody listed, and accepts loopback or a listed host', async () => {
    // The env parser's refusal is a printed table and process.exit(1): both
    // are stubbed so the refusal surfaces as a rejection carrying the table.
    let printed = '';
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed += args.map(String).join(' ');
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}): ${printed}`);
    });
    await expectBootRefusal(
      createTestApp(connectionString, { ...DEMO_ON, PUBLIC_BASE_URL: 'https://tool.example.io' }),
      /DEMO_SIGN_IN\s+DEMO_SIGN_IN is refused on tool\.example\.io/
    );
    printed = '';
    await expectBootRefusal(
      createTestApp(connectionString, { ...DEMO_ON, PUBLIC_BASE_URL: 'https://localhost.evil.test' }),
      /DEMO_SIGN_IN is refused on localhost\.evil\.test/
    );
    vi.restoreAllMocks();

    const listed = await createTestApp(connectionString, {
      ...DEMO_ON,
      PUBLIC_BASE_URL: 'https://tool.example.io',
      DEMO_SIGN_IN_HOSTS: 'tool.example.io'
    });
    await listed.stop();
    const subdomain = await createTestApp(connectionString, {
      ...DEMO_ON,
      PUBLIC_BASE_URL: 'http://app.localhost:3000'
    });
    await subdomain.stop();
  });

  it('l. cloud: with the switch on, every demo path is an unknown path and /instance has no demoSignIn', async () => {
    const hub = await FakeHub.start({ clientId: host.hubClientId });
    const cloud = await createTestApp(await createDatabase(container, 'demo_pass_cloud'), {
      ...DEMO_ON,
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
    });
    try {
      const unknownApi = await answerOf(
        await send(cloud, 'POST', '/definitely-not-a-route', {}, { email: 'a' })
      );
      const unknownAuth = await answerOf(
        await send(cloud, 'POST', '/auth/definitely-not-a-route', {}, { pass: 'x' })
      );
      expect(await answerOf(await send(cloud, 'POST', '/demo/passes', {}, { email: 'a' }))).toEqual(
        unknownApi
      );
      expect(await answerOf(await send(cloud, 'GET', '/demo/passes'))).toEqual(unknownApi);
      expect(
        await answerOf(await send(cloud, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111'))
      ).toEqual(unknownApi);
      expect(await answerOf(await redeem('x', cloud))).toEqual(unknownAuth);
      expect('demoSignIn' in (await readJson(await send(cloud, 'GET', '/instance')))).toBe(false);
    } finally {
      await cloud.stop();
      await hub.stop();
    }
  });
});

describe('the mint', () => {
  it('c. an owner mints a pass for a member: 201, a 43-character secret stored only as its sha256, a fragment link', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com', path: '/decks/1?x=1' });
    expect(minted.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.url).toBe(`${ORIGIN}/demo#pass=${minted.secret}&to=${encodeURIComponent('/decks/1?x=1')}`);
    expect(minted.pass).toMatchObject({
      userId: actors.member!.userId,
      email: 'member@example.com',
      targetPath: '/decks/1?x=1',
      createdBy: actors.owner!.userId,
      revokedAt: null,
      useCount: 0
    });
    // Default lifetime: one day.
    const lifetime = Date.parse(String(minted.pass.expiresAt)) - Date.parse(String(minted.pass.createdAt));
    expect(Math.round(lifetime / 60_000)).toBe(1440);

    const { rows } = await app.db.pool.query(
      `SELECT *, row_to_json(p)::text AS json FROM demo_passes p WHERE id = $1`,
      [minted.id]
    );
    expect(rows[0].secret_hash).toBe(sha256(minted.secret));
    expect(rows[0].json).not.toContain(minted.secret);
    expect(rows[0].target_path).toBe('/decks/1?x=1');
  });

  it('d. the refusals, in the spec’s order', async () => {
    const owner = actors.owner!;
    // 1. nobody of this workspace holds the address
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'nobody@example.com' }),
      404,
      'no_such_member'
    );
    // 2. another owner
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'other-owner@example.com' }),
      403,
      'owner_target'
    );
    // …but the owner for themself is fine.
    await mint(owner, { email: OWNER.email });
    // 3. not a demonstration address (checked before the second factor)
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'someone@gmail.com' }),
      403,
      'demo_address_required'
    );
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'two-factor@gmail.com' }),
      403,
      'demo_address_required'
    );
    // 4. a second factor
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'two-factor@example.com' }),
      403,
      'two_factor_enrolled'
    );
    // 5. the shared credential-minting refusal
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'guest@example.org' }),
      403,
      'guest_target'
    );
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'cross@team.test' }),
      403,
      'cross_workspace_target'
    );
    // 6. the page and the lifetime
    for (const path of ['//evil', '/\\evil', 'decks', '/a#b', '/a b']) {
      await expectError(
        await send(app, 'POST', '/demo/passes', owner, { email: 'member@example.com', path }),
        400,
        'invalid_demo_path'
      );
    }
    for (const expiresInMinutes of [0, 10081]) {
      await expectError(
        await send(app, 'POST', '/demo/passes', owner, { email: 'member@example.com', expiresInMinutes }),
        400,
        'validation_error'
      );
    }
    await mint(owner, { email: 'member@example.com', expiresInMinutes: 10080 });

    // The operator names gmail.com: the same member is now a demonstration address.
    const widened = await createTestApp(connectionString, {
      ...DEMO_ON,
      DEMO_SIGN_IN_EMAIL_DOMAINS: 'gmail.com'
    });
    try {
      await mint(owner, { email: 'someone@gmail.com' }, widened);
    } finally {
      await widened.stop();
    }
  });

  it('e. an admin and a member are refused; an API key held by the owner reaches none of the three routes', async () => {
    for (const who of [actors.admin!, actors.member!]) {
      await expectError(
        await send(app, 'POST', '/demo/passes', who, { email: 'member@example.com' }),
        403,
        'forbidden'
      );
      await expectError(await send(app, 'GET', '/demo/passes', who), 403, 'forbidden');
    }
    const keyRes = await send(app, 'POST', '/api-keys', actors.owner!, {
      name: 'demo-key',
      scopes: [host.scopes.read, host.scopes.write]
    });
    expect(keyRes.status).toBe(201);
    const key = (await readJson(keyRes)).key as string;
    const byKey = [
      await send(app, 'POST', '/demo/passes', { key }, { email: 'member@example.com' }),
      await send(app, 'GET', '/demo/passes', { key }),
      await send(app, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111', { key })
    ];
    for (const res of byKey) expect(res.status).toBe(403);
  });
});

describe('the redeem', () => {
  it('f. signs the MEMBER in with the library’s own session cookie; two redeems, two sessions, use_count 2', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com', path: '/decks' });
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await redeem(minted.secret);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/better-auth\.session_token=/);
      const body = await readJson(res);
      expect(body).toEqual({
        user: { id: actors.member!.userId, email: 'member@example.com', name: 'member' },
        path: '/decks',
        expiresAt: minted.pass.expiresAt
      });
      cookies.push(extractCookie(res));
    }
    expect(cookies[0]).not.toBe(cookies[1]);
    for (const cookie of cookies) {
      const me = await readJson(await send(app, 'GET', '/me', { cookie }));
      expect(me.user.id).toBe(actors.member!.userId);
      expect(me.role).toBe('member');
      // An owner-only route stays closed to the member's session.
      await expectError(await send(app, 'GET', '/demo/passes', { cookie }), 403, 'forbidden');
    }
    const { rows } = await app.db.pool.query(
      `SELECT use_count, last_used_at FROM demo_passes WHERE id = $1`,
      [minted.id]
    );
    expect(rows[0].use_count).toBe(2);
    expect(rows[0].last_used_at).not.toBeNull();
    const sessions = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM demo_pass_sessions WHERE pass_id = $1`,
      [minted.id]
    );
    expect(sessions.rows[0].n).toBe(2);
  });

  it('g. every refusal of a pass is the same 401 and sets no session', async () => {
    const owner = actors.owner!;
    const refusals: Array<{ status: number; body: string; sets: boolean }> = [];
    const collect = async (res: Response) =>
      refusals.push({ ...(await answerOf(res)), sets: setsSession(res) });

    // unknown
    await collect(await redeem('A'.repeat(43)));
    // expired
    const expired = await mint(owner, { email: 'member@example.com' });
    await app.db.pool.query(`UPDATE demo_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      expired.id
    ]);
    await collect(await redeem(expired.secret));
    // revoked
    const revoked = await mint(owner, { email: 'member@example.com' });
    expect((await send(app, 'DELETE', `/demo/passes/${revoked.id}`, owner)).status).toBe(200);
    await collect(await redeem(revoked.secret));
    // the member removed from the workspace
    const gone = await addMember('gone', 'gone@example.com', { signIn: false });
    const goneMint = await mint(owner, { email: gone.email });
    await app.db.pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [gone.userId]);
    await collect(await redeem(goneMint.secret));
    // a second factor enrolled after the mint
    const late = await addMember('late', 'late-two-factor@example.com', { signIn: false });
    const lateMint = await mint(owner, { email: late.email });
    await app.db.pool.query(`UPDATE "user" SET two_factor_enabled = true WHERE id = $1`, [late.userId]);
    await collect(await redeem(lateMint.secret));
    // the domain taken off the operator's list: minted where gmail.com was
    // listed, redeemed where it no longer is (the same database)
    const widened = await createTestApp(connectionString, {
      ...DEMO_ON,
      DEMO_SIGN_IN_EMAIL_DOMAINS: 'gmail.com'
    });
    let gmailSecret = '';
    try {
      gmailSecret = (await mint(owner, { email: 'someone@gmail.com' }, widened)).secret;
    } finally {
      await widened.stop();
    }
    await collect(await redeem(gmailSecret));

    expect(refusals).toHaveLength(6);
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        status: 401,
        body: JSON.stringify({
          error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' }
        }),
        sets: false
      });
    }
  });

  /** The one answer every refused redeem gives (test g), with no session set. */
  async function expectRefusedRedeem(secret: string): Promise<void> {
    const res = await redeem(secret);
    expect({ ...(await answerOf(res)), sets: setsSession(res) }).toEqual({
      status: 401,
      body: JSON.stringify({ error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' } }),
      sets: false
    });
  }

  it('g3. a member made an owner after the mint is refused at the redeem', async () => {
    const promoted = await addMember('promoted', 'promoted@example.com', { signIn: false });
    const minted = await mint(actors.owner!, { email: promoted.email });
    await app.db.pool.query(`UPDATE workspace_members SET role = 'owner' WHERE user_id = $1`, [
      promoted.userId
    ]);
    await expectRefusedRedeem(minted.secret);
  });

  it('g4. a member who joined another workspace after the mint is refused at the redeem', async () => {
    const joined = await addMember('joined', 'joined@example.com', { signIn: false });
    const minted = await mint(actors.owner!, { email: joined.email });
    // `cross`'s other workspace, the one created in beforeAll.
    const { rows } = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2`,
      [actors.cross!.userId, workspaceId]
    );
    expect(rows).toHaveLength(1);
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: rows[0].workspace_id, userId: joined.userId, role: 'member', origin: 'local' });
    await expectRefusedRedeem(minted.secret);
  });

  it('g5. a member whose membership turned guest after the mint is refused at the redeem', async () => {
    const turned = await addMember('turned', 'turned@example.com', { signIn: false });
    const minted = await mint(actors.owner!, { email: turned.email });
    await app.db.pool.query(`UPDATE workspace_members SET origin = 'guest' WHERE user_id = $1`, [
      turned.userId
    ]);
    await expectRefusedRedeem(minted.secret);
  });

  it('h. no Origin: 403 and no cookie; a foreign Origin: refused and no cookie', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com' });
    const noOrigin = await app.app.request('/api/v1/auth/demo/redeem', {
      method: 'POST',
      headers: { 'x-forwarded-for': nextIp(), 'content-type': 'application/json' },
      body: JSON.stringify({ pass: minted.secret })
    });
    await expectError(noOrigin, 403, 'cross_site_forbidden');
    expect(setsSession(noOrigin)).toBe(false);

    const foreign = await redeem(minted.secret, app, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(setsSession(foreign)).toBe(false);

    // Neither spent the pass.
    const { rows } = await app.db.pool.query(`SELECT use_count FROM demo_passes WHERE id = $1`, [minted.id]);
    expect(rows[0].use_count).toBe(0);
  });

  it('i2. valid redeems never cost: thirty in a row from one address all sign in', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com' });
    const address = { 'x-forwarded-for': '10.99.1.1' };
    for (let i = 0; i < 30; i++) {
      expect((await redeem(minted.secret, app, address)).status).toBe(200);
    }
  });

  it('i. the wall: after twenty refused redeems from one address the next answers 429, a valid pass included', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com' });
    const address = { 'x-forwarded-for': '10.99.0.1' };
    for (let i = 0; i < 20; i++) {
      expect((await redeem('B'.repeat(43), app, address)).status).toBe(401);
    }
    await expectError(await redeem('B'.repeat(43), app, address), 429, 'rate_limited');
    // A drained wall refuses a valid pass too: no work is done for that address.
    await expectError(await redeem(minted.secret, app, address), 429, 'rate_limited');
    // Another address is untouched.
    expect((await redeem('B'.repeat(43), app, { 'x-forwarded-for': '10.99.0.2' })).status).toBe(401);
  });
});

describe('the trail and the owner’s list', () => {
  it('j. mint, use and revoke rows with the right actor, no secret or hash anywhere, and a pass session’s mutation marked', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const redeemed = await redeem(minted.secret);
    expect(redeemed.status).toBe(200);
    const passCookie = extractCookie(redeemed);

    const rowsOf = async (action: string) =>
      (
        await app.db.pool.query(
          `SELECT actor_user_id, actor_via, workspace_id, resource_type, metadata FROM audit_log
            WHERE action = $1 AND resource_id = $2`,
          [action, minted.id]
        )
      ).rows;
    const [mintRow] = await rowsOf('demo_pass.mint');
    expect(mintRow).toMatchObject({
      actor_user_id: owner.userId,
      actor_via: 'session',
      workspace_id: workspaceId,
      resource_type: 'demo_pass',
      metadata: { targetUserId: actors.member!.userId, targetPath: '/', expiresAt: minted.pass.expiresAt }
    });
    const [useRow] = await rowsOf('demo_pass.use');
    expect(useRow).toMatchObject({
      actor_user_id: actors.member!.userId,
      actor_via: 'session',
      workspace_id: workspaceId,
      metadata: { passId: minted.id }
    });
    // A mutation a member may make, once through the pass's session, once
    // through the member's own password session.
    const viaPass = await send(
      app,
      'POST',
      '/projects',
      { cookie: passCookie },
      { name: 'Through the demo link' }
    );
    expect(viaPass.status).toBe(201);
    const viaPassId = (await readJson(viaPass)).id;
    const viaPassword = await send(app, 'POST', '/projects', actors.member!, { name: 'By hand' });
    expect(viaPassword.status).toBe(201);
    const viaPasswordId = (await readJson(viaPassword)).id;
    const metadataOf = async (projectId: string) =>
      (
        await app.db.pool.query(
          `SELECT metadata, actor_user_id FROM audit_log WHERE action = 'project.create' AND resource_id = $1`,
          [projectId]
        )
      ).rows[0];
    const marked = await metadataOf(viaPassId);
    expect(marked.actor_user_id).toBe(actors.member!.userId);
    expect(marked.metadata.demoPassId).toBe(minted.id);
    const unmarked = await metadataOf(viaPasswordId);
    expect(unmarked.actor_user_id).toBe(actors.member!.userId);
    expect(unmarked.metadata?.demoPassId).toBeUndefined();

    expect((await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner)).status).toBe(200);
    const [revokeRow] = await rowsOf('demo_pass.revoke');
    expect(revokeRow).toMatchObject({ actor_user_id: owner.userId, resource_type: 'demo_pass' });

    // No audit row anywhere carries a secret this suite minted, or its hash.
    const { rows: all } = await app.db.pool.query(`SELECT row_to_json(a)::text AS json FROM audit_log a`);
    const trail = all.map((r: { json: string }) => r.json).join('\n');
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) {
      expect(trail).not.toContain(secret);
      expect(trail).not.toContain(sha256(secret));
    }
  });

  it('k. revoke is idempotent, another workspace’s pass is 404, and the list never carries a secret', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const first = await readJson(await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner));
    expect(first.revokedAt).not.toBeNull();
    const again = await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner);
    expect(again.status).toBe(200);
    expect((await readJson(again)).revokedAt).toBe(first.revokedAt);

    // A pass of `cross`'s other workspace, written in place.
    const { rows: elsewhere } = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2`,
      [actors.cross!.userId, workspaceId]
    );
    const { rows: foreign } = await app.db.pool.query(
      `INSERT INTO demo_passes (workspace_id, user_id, secret_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
      [elsewhere[0].workspace_id, actors.cross!.userId, sha256('elsewhere')]
    );
    await expectError(await send(app, 'DELETE', `/demo/passes/${foreign[0].id}`, owner), 404, 'not_found');
    await expectError(await send(app, 'DELETE', '/demo/passes/not-a-uuid', owner), 400, 'validation_error');

    const listRes = await send(app, 'GET', '/demo/passes', owner);
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    const list = JSON.parse(text) as { passes: Array<{ id: string; createdAt: string }> };
    expect(list.passes.length).toBeGreaterThan(5);
    expect(list.passes.map((p) => p.id)).not.toContain(foreign[0].id);
    const created = list.passes.map((p) => Date.parse(p.createdAt));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    expect(text).not.toMatch(/secret/i);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(sha256(secret));
    }
  });
});

describe('a session a pass opened lives only while its pass does', () => {
  const sessionRowsOf = async (passId: string) =>
    (
      await app.db.pool.query(
        `SELECT s.id FROM session s JOIN demo_pass_sessions d ON d.session_id = s.id WHERE d.pass_id = $1`,
        [passId]
      )
    ).rows.length;
  /** The pass's session links, whether or not their session is still there. */
  const linksOf = async (passId: string) =>
    (await app.db.pool.query(`SELECT session_id FROM demo_pass_sessions WHERE pass_id = $1`, [passId])).rows
      .length;

  it('m. a revoke ends the sessions the pass opened, and leaves the person’s own session alone', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const first = extractCookie(await redeem(minted.secret));
    const second = extractCookie(await redeem(minted.secret));
    expect((await send(app, 'GET', '/me', { cookie: first })).status).toBe(200);
    expect(await sessionRowsOf(minted.id)).toBe(2);

    expect((await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner)).status).toBe(200);

    expect(await sessionRowsOf(minted.id)).toBe(0);
    expect(await linksOf(minted.id)).toBe(0);
    expect((await send(app, 'GET', '/me', { cookie: first })).status).toBe(401);
    expect((await send(app, 'GET', '/me', { cookie: second })).status).toBe(401);
    const session = await app.app.request('/api/v1/auth/get-session', { headers: { cookie: first } });
    expect(await session.json()).toBeNull();
    // The member's password session is theirs: the revoke does not touch it.
    expect((await send(app, 'GET', '/me', actors.member!)).status).toBe(200);
  });

  it('n. once the pass has expired its session is refused and deleted, on the first request that presents it', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const cookie = extractCookie(await redeem(minted.secret));
    expect((await send(app, 'GET', '/me', { cookie })).status).toBe(200);
    expect(await sessionRowsOf(minted.id)).toBe(1);

    await app.db.pool.query(`UPDATE demo_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      minted.id
    ]);

    expect((await send(app, 'GET', '/me', { cookie })).status).toBe(401);
    expect(await sessionRowsOf(minted.id)).toBe(0);
    expect(await linksOf(minted.id)).toBe(0);
    const made = await send(app, 'POST', '/projects', { cookie }, { name: 'After the pass died' });
    expect(made.status).toBe(401);
  });

  it('o. an ordinary session is never judged against a pass: the member’s own sign-in works whatever their passes do', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    await redeem(minted.secret);
    await app.db.pool.query(`UPDATE demo_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      minted.id
    ]);
    expect((await send(app, 'GET', '/me', actors.member!)).status).toBe(200);
  });

  it('p. the sign-in library’s own door: get-session on an expired pass’s session answers null and deletes the row, with no API request in between', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const cookie = extractCookie(await redeem(minted.secret));
    const live = await app.app.request('/api/v1/auth/get-session', { headers: { cookie } });
    expect(((await live.json()) as { user: { email: string } }).user.email).toBe('member@example.com');

    await app.db.pool.query(`UPDATE demo_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      minted.id
    ]);

    const dead = await app.app.request('/api/v1/auth/get-session', { headers: { cookie } });
    expect(await dead.json()).toBeNull();
    expect(await sessionRowsOf(minted.id)).toBe(0);
  });

  it('q. a session a demo link opened manages no demo link, even the owner’s own', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: OWNER.email });
    const cookie = extractCookie(await redeem(minted.secret));
    const me = (await readJson(await send(app, 'GET', '/me', { cookie }))) as { role: string };
    expect(me.role).toBe('owner');

    await expectError(await send(app, 'GET', '/demo/passes', { cookie }), 403, 'demo_session');
    await expectError(
      await send(app, 'POST', '/demo/passes', { cookie }, { email: 'member@example.com' }),
      403,
      'demo_session'
    );
    await expectError(
      await send(app, 'DELETE', `/demo/passes/${minted.id}`, { cookie }),
      403,
      'demo_session'
    );
    // The owner's password session still does all three.
    expect((await send(app, 'GET', '/demo/passes', owner)).status).toBe(200);
  });
});

describe('a demo link’s session leaves nothing behind', () => {
  /** A fresh member and a session a pass opened for them. */
  async function passSessionFor(name: string, email: string): Promise<{ actor: Actor; cookie: string }> {
    const actor = await addMember(name, email);
    const minted = await mint(actors.owner!, { email });
    const res = await redeem(minted.secret);
    expect(res.status).toBe(200);
    return { actor, cookie: extractCookie(res) };
  }

  it('t. a pass’s session creates no API key; the person’s own password session does', async () => {
    const { actor, cookie } = await passSessionFor('keyless', 'keyless@example.com');
    const body = { name: 'from-a-demo', scopes: [host.scopes.read] };
    await expectError(await send(app, 'POST', '/api-keys', { cookie }, body), 403, 'demo_session');
    const keysOf = async () =>
      (await app.db.pool.query(`SELECT id FROM api_keys WHERE created_by = $1`, [actor.userId])).rows.length;
    expect(await keysOf()).toBe(0);

    expect((await send(app, 'POST', '/api-keys', actor, body)).status).toBe(201);
    expect(await keysOf()).toBe(1);
  });

  it('t2. a pass’s session changes no password, address, name or second factor, and deletes no account', async () => {
    const { actor, cookie } = await passSessionFor('unchanged', 'unchanged@example.com');
    const snapshot = async () => ({
      user: (
        await app.db.pool.query(`SELECT name, email, two_factor_enabled FROM "user" WHERE id = $1`, [
          actor.userId
        ])
      ).rows,
      password: (
        await app.db.pool.query(`SELECT password FROM account WHERE user_id = $1 ORDER BY id`, [actor.userId])
      ).rows
    });
    const before = await snapshot();
    expect(before.user).toHaveLength(1);

    const attempts: Array<[string, unknown]> = [
      ['/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-password-2' }],
      ['/auth/change-email', { newEmail: 'moved@example.com' }],
      ['/auth/update-user', { name: 'Renamed by a demo' }],
      ['/auth/two-factor/enable', { password: PASSWORD }],
      ['/auth/delete-user', {}]
    ];
    for (const [path, body] of attempts) {
      await expectError(await send(app, 'POST', path, { cookie }, body), 403, 'demo_session');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('t3. a pass’s session authorizes no OAuth client', async () => {
    const { cookie } = await passSessionFor('noGrant', 'no-grant@example.com');
    const redirectUri = 'http://127.0.0.1:9999/callback';
    const register = await send(
      app,
      'POST',
      '/auth/oauth2/register',
      {},
      {
        client_name: 'demo-pass-client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      }
    );
    expect([200, 201]).toContain(register.status);
    const clientId = (await readJson(register)).client_id as string;
    expect(clientId).toBeTruthy();

    const verifier = 'v'.repeat(64);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: `openid offline_access ${host.scopes.read}`,
      state: 'demo-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    });
    await expectError(
      await send(app, 'GET', `/auth/oauth2/authorize?${params}`, { cookie }),
      403,
      'demo_session'
    );
    const { rows } = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM oauth_consent WHERE client_id = $1`,
      [clientId]
    );
    expect(rows[0].n).toBe(0);
  });

  it('v. a pass’s session creates no workspace and is not offered one; the person’s own password session is', async () => {
    const { actor, cookie } = await passSessionFor('founder', 'founder@example.com');
    const ownedBy = async () =>
      (
        await app.db.pool.query(
          `SELECT id FROM workspace_members WHERE user_id = $1 AND role = 'owner' AND is_active`,
          [actor.userId]
        )
      ).rows.length;
    expect(await ownedBy()).toBe(0);

    const me = (await readJson(await send(app, 'GET', '/me', { cookie }))) as { canCreateWorkspace: boolean };
    expect(me.canCreateWorkspace).toBe(false);
    await expectError(
      await send(app, 'POST', '/workspaces', { cookie }, { name: 'Made by a demo' }),
      403,
      'demo_session'
    );
    expect(await ownedBy()).toBe(0);

    const own = (await readJson(await send(app, 'GET', '/me', actor))) as { canCreateWorkspace: boolean };
    expect(own.canCreateWorkspace).toBe(true);
    expect((await send(app, 'POST', '/workspaces', actor, { name: 'Made by the person' })).status).toBe(201);
    expect(await ownedBy()).toBe(1);
  });

  it('v2. a pass’s session accepts no invitation into another workspace; the person’s own password session does', async () => {
    const { actor, cookie } = await passSessionFor('invitee', 'invitee@example.com');
    // `cross`'s other workspace, the one created in beforeAll.
    const { rows } = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2`,
      [actors.cross!.userId, workspaceId]
    );
    expect(rows).toHaveLength(1);
    const elsewhere = rows[0].workspace_id as string;
    const invite = await send(
      app,
      'POST',
      '/invitations',
      actors.cross!,
      { email: actor.email, role: 'member' },
      { 'x-workspace-id': elsewhere }
    );
    expect(invite.status).toBe(201);
    const token = ((await readJson(invite)).acceptUrl as string).split('/invite/')[1]!;
    const membershipsElsewhere = async () =>
      (
        await app.db.pool.query(`SELECT id FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`, [
          actor.userId,
          elsewhere
        ])
      ).rows.length;

    await expectError(
      await send(app, 'POST', '/invitations/accept', { cookie }, { token }),
      403,
      'demo_session'
    );
    expect(await membershipsElsewhere()).toBe(0);

    expect((await send(app, 'POST', '/invitations/accept', actor, { token })).status).toBe(200);
    expect(await membershipsElsewhere()).toBe(1);
  });

  it('v3. a pass’s session changes no default workspace; the person’s own password session does (PRDCT-2815)', async () => {
    const { actor, cookie } = await passSessionFor('settled', 'settled@example.com');
    const defaults = async () =>
      (
        await app.db.pool.query(
          `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND is_default`,
          [actor.userId]
        )
      ).rows.map((row) => row.workspace_id as string);
    expect(await defaults()).toEqual([]);

    for (const body of [{ workspaceId }, { workspaceId: null }]) {
      await expectError(
        await send(app, 'PUT', '/me/default-workspace', { cookie }, body),
        403,
        'demo_session'
      );
    }
    expect(await defaults()).toEqual([]);

    expect((await send(app, 'PUT', '/me/default-workspace', actor, { workspaceId })).status).toBe(200);
    expect(await defaults()).toEqual([workspaceId]);
    // The pass's session refuses the clear too, once a default exists.
    await expectError(
      await send(app, 'PUT', '/me/default-workspace', { cookie }, { workspaceId: null }),
      403,
      'demo_session'
    );
    expect(await defaults()).toEqual([workspaceId]);
  });

  it('t4. a pass’s session still reads itself and signs out', async () => {
    const { cookie } = await passSessionFor('visitor', 'visitor@example.com');
    const session = await send(app, 'GET', '/auth/get-session', { cookie });
    expect(session.status).toBe(200);
    expect(((await readJson(session)) as { user: { email: string } }).user.email).toBe('visitor@example.com');

    const out = await send(app, 'POST', '/auth/sign-out', { cookie }, {});
    expect(out.status).toBe(200);
    expect((await send(app, 'GET', '/me', { cookie })).status).toBe(401);
  });

  /** The session rows and the link rows a pass opened. */
  const leftOf = async (passId: string) => ({
    links: (await app.db.pool.query(`SELECT session_id FROM demo_pass_sessions WHERE pass_id = $1`, [passId]))
      .rows.length,
    sessions: (
      await app.db.pool.query(
        `SELECT s.id FROM session s JOIN demo_pass_sessions d ON d.session_id = s.id WHERE d.pass_id = $1`,
        [passId]
      )
    ).rows.length
  });

  it('w. a pass’s session that signs itself out ends the pass’s way: no link row and no session left', async () => {
    await addMember('leaver', 'leaver@example.com', { signIn: false });
    const minted = await mint(actors.owner!, { email: 'leaver@example.com' });
    const cookie = extractCookie(await redeem(minted.secret));
    expect(await leftOf(minted.id)).toEqual({ links: 1, sessions: 1 });

    expect((await send(app, 'POST', '/auth/sign-out', { cookie }, {})).status).toBe(200);

    expect(await leftOf(minted.id)).toEqual({ links: 0, sessions: 0 });
  });

  it('w2. the person’s own session revoking a pass’s session ends it the pass’s way: no link row left', async () => {
    const actor = await addMember('revoker', 'revoker@example.com');
    const minted = await mint(actors.owner!, { email: actor.email });
    const cookie = extractCookie(await redeem(minted.secret));
    const { rows } = await app.db.pool.query(
      `SELECT s.token FROM session s JOIN demo_pass_sessions d ON d.session_id = s.id WHERE d.pass_id = $1`,
      [minted.id]
    );
    expect(rows).toHaveLength(1);

    const revoked = await send(app, 'POST', '/auth/revoke-session', actor, { token: rows[0].token });
    expect(revoked.status).toBe(200);

    expect(await leftOf(minted.id)).toEqual({ links: 0, sessions: 0 });
    expect((await send(app, 'GET', '/me', { cookie })).status).toBe(401);
    expect((await send(app, 'GET', '/me', actor)).status).toBe(200);
  });

  /** The session rows (id and token) a pass opened. */
  const passSessionsOf = async (passId: string) =>
    (
      await app.db.pool.query(
        `SELECT s.id, s.token FROM session s JOIN demo_pass_sessions d ON d.session_id = s.id WHERE d.pass_id = $1`,
        [passId]
      )
    ).rows as Array<{ id: string; token: string }>;

  it('w3. a forged signature on the person’s own session cookie ends none of their pass’s sessions', async () => {
    const actor = await addMember('forger', 'forger@example.com');
    const minted = await mint(actors.owner!, { email: actor.email });
    const first = extractCookie(await redeem(minted.secret));
    const second = extractCookie(await redeem(minted.secret));
    expect(await leftOf(minted.id)).toEqual({ links: 2, sessions: 2 });
    // The token part kept, the signature replaced: the library refuses the caller.
    const forged = actor.cookie.replace(/(session_token=[^.;]+)\.[^;]*/, '$1.forged');
    expect(forged).not.toBe(actor.cookie);

    const revoked = await send(app, 'POST', '/auth/revoke-sessions', { cookie: forged }, {});
    expect(revoked.status).toBe(401);

    expect(await leftOf(minted.id)).toEqual({ links: 2, sessions: 2 });
    expect((await send(app, 'GET', '/me', { cookie: first })).status).toBe(200);
    expect((await send(app, 'GET', '/me', { cookie: second })).status).toBe(200);
  });

  it('w4. another person’s session naming a pass’s session token ends nothing of it', async () => {
    const actor = await addMember('named', 'named@example.com');
    const other = await addMember('namer', 'namer@example.com');
    const minted = await mint(actors.owner!, { email: actor.email });
    const cookie = extractCookie(await redeem(minted.secret));
    const [passSession] = await passSessionsOf(minted.id);
    expect(passSession).toBeTruthy();

    const revoked = await send(app, 'POST', '/auth/revoke-session', other, { token: passSession!.token });
    expect(revoked.status).toBe(200);

    expect(await leftOf(minted.id)).toEqual({ links: 1, sessions: 1 });
    expect((await send(app, 'GET', '/me', { cookie })).status).toBe(200);
  });

  it('w5. the person revokes ONE of their pass’s sessions by token: the other and its link remain', async () => {
    const actor = await addMember('selective', 'selective@example.com');
    const minted = await mint(actors.owner!, { email: actor.email });
    const first = extractCookie(await redeem(minted.secret));
    const second = extractCookie(await redeem(minted.secret));
    const sessions = await passSessionsOf(minted.id);
    expect(sessions).toHaveLength(2);
    // Which row is the first cookie's: its token part.
    const firstToken = decodeURIComponent(first).match(/session_token=([^.;]+)/)![1]!;
    const target = sessions.find((row) => row.token === firstToken)!;
    expect(target).toBeTruthy();

    const revoked = await send(app, 'POST', '/auth/revoke-session', actor, { token: target.token });
    expect(revoked.status).toBe(200);

    expect(await leftOf(minted.id)).toEqual({ links: 1, sessions: 1 });
    expect((await passSessionsOf(minted.id)).map((row) => row.id)).toEqual(
      sessions.filter((row) => row.id !== target.id).map((row) => row.id)
    );
    expect((await send(app, 'GET', '/me', { cookie: second })).status).toBe(200);
    expect((await send(app, 'GET', '/me', { cookie: first })).status).toBe(401);
  });
});

describe('a removal ends the demo passes (PRDCT-2816)', () => {
  const INVALID = JSON.stringify({
    error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' }
  });

  const memberIdOf = async (userId: string, inWorkspace = workspaceId) =>
    (
      await app.db.pool.query(`SELECT id FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`, [
        userId,
        inWorkspace
      ])
    ).rows[0].id as string;
  const revokedAtOf = async (passId: string) =>
    (await app.db.pool.query(`SELECT revoked_at FROM demo_passes WHERE id = $1`, [passId])).rows[0]
      .revoked_at as Date | null;
  const removeMember = (memberId: string) =>
    send(app, 'POST', `/members/${memberId}/remove`, actors.owner!, undefined);
  const removalMetadata = async (memberId: string) => {
    const { rows } = await app.db.pool.query(
      `SELECT metadata FROM audit_log WHERE action = 'member.remove' AND resource_id = $1`,
      [memberId]
    );
    expect(rows).toHaveLength(1);
    return rows[0].metadata as Record<string, unknown>;
  };
  async function expectRedeemRefused(secret: string): Promise<void> {
    const res = await redeem(secret);
    expect({ status: res.status, body: await res.text(), sets: setsSession(res) }).toEqual({
      status: 401,
      body: INVALID,
      sets: false
    });
  }

  it('F1: a removed owner’s passes are revoked, their redeem refused, and the sessions they opened signed out', async () => {
    const o2 = await addMember('o2', 'o2@example.com', { role: 'owner' });
    const o2MemberId = await memberIdOf(o2.userId);
    // o2 owns a workspace of their own too, with a demo person in it.
    const made = await send(app, 'POST', '/workspaces', o2, { name: 'O2 elsewhere' });
    expect(made.status).toBe(201);
    const { rows: o2Rows } = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2`,
      [o2.userId, workspaceId]
    );
    expect(o2Rows).toHaveLength(1);
    const o2Elsewhere = o2Rows[0].workspace_id as string;
    const far = await app.auth.api.signUpEmail({
      body: { email: 'far-demo@example.com', password: PASSWORD, name: 'far' }
    });
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: o2Elsewhere, userId: far.user.id, role: 'member', origin: 'local' });

    await addMember('f1Target', 'f1-target@example.com', { signIn: false });
    await addMember('f1Other', 'f1-other@example.com', { signIn: false });
    await addMember('f1Bystander', 'f1-bystander@example.com', { signIn: false });

    // Two passes o2 minted here, one of them redeemed before the removal.
    const opened = await mint(o2, { email: 'f1-target@example.com' });
    const idle = await mint(o2, { email: 'f1-other@example.com' });
    const redeemed = await redeem(opened.secret);
    expect(redeemed.status).toBe(200);
    const passCookie = extractCookie(redeemed);
    expect((await send(app, 'GET', '/me', { cookie: passCookie })).status).toBe(200);
    const { rows: links } = await app.db.pool.query(
      `SELECT session_id FROM demo_pass_sessions WHERE pass_id = $1`,
      [opened.id]
    );
    expect(links).toHaveLength(1);
    const sessionId = links[0].session_id as string;

    // Boundaries: another owner's pass for another person here, and o2's pass
    // in o2's other workspace.
    const bystanderPass = await mint(actors.owner!, { email: 'f1-bystander@example.com' });
    const awayRes = await send(
      app,
      'POST',
      '/demo/passes',
      o2,
      { email: 'far-demo@example.com' },
      { 'x-workspace-id': o2Elsewhere }
    );
    expect(awayRes.status).toBe(201);
    const away = await readJson(awayRes);
    secrets.push(away.secret);

    expect((await removeMember(o2MemberId)).status).toBe(200);

    expect(await revokedAtOf(opened.id)).toBeInstanceOf(Date);
    expect(await revokedAtOf(idle.id)).toBeInstanceOf(Date);
    await expectRedeemRefused(opened.secret);
    await expectRedeemRefused(idle.secret);

    // The session the pass opened before the removal is signed out, its rows gone.
    expect((await send(app, 'GET', '/me', { cookie: passCookie })).status).toBe(401);
    expect(
      (await app.db.pool.query(`SELECT 1 FROM demo_pass_sessions WHERE session_id = $1`, [sessionId])).rows
    ).toHaveLength(0);
    expect((await app.db.pool.query(`SELECT 1 FROM session WHERE id = $1`, [sessionId])).rows).toHaveLength(
      0
    );

    // Untouched: another owner's pass here, and o2's pass in another workspace.
    expect(await revokedAtOf(bystanderPass.id)).toBeNull();
    expect((await redeem(bystanderPass.secret)).status).toBe(200);
    expect(await revokedAtOf(away.pass.id)).toBeNull();
    expect((await redeem(away.secret)).status).toBe(200);

    // The count: the two passes o2 minted here.
    expect(await removalMetadata(o2MemberId)).toMatchObject({ demoPasses: 2 });
  });

  it('a pass minted FOR a removed person is revoked, and stays revoked once they are invited back', async () => {
    const person = await addMember('forPerson', 'for-person@example.com');
    const personMemberId = await memberIdOf(person.userId);
    const minted = await mint(actors.owner!, { email: person.email });

    expect((await removeMember(personMemberId)).status).toBe(200);
    expect(await revokedAtOf(minted.id)).toBeInstanceOf(Date);
    await expectRedeemRefused(minted.secret);
    expect(await removalMetadata(personMemberId)).toMatchObject({ demoPasses: 1 });

    // Invited back and accepted with the person's own session.
    const invited = await send(app, 'POST', '/invitations', actors.owner!, {
      email: person.email,
      role: 'member'
    });
    expect(invited.status).toBe(201);
    const token = ((await readJson(invited)).acceptUrl as string).split('/invite/')[1]!;
    expect((await send(app, 'POST', '/invitations/accept', person, { token })).status).toBe(200);
    const { rows } = await app.db.pool.query(`SELECT is_active FROM workspace_members WHERE id = $1`, [
      personMemberId
    ]);
    expect(rows[0].is_active).toBe(true);

    expect(await revokedAtOf(minted.id)).toBeInstanceOf(Date);
    await expectRedeemRefused(minted.secret);
  });
});
