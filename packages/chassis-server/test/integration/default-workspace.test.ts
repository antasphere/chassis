import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
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
 * The person's default workspace on self-hosted (PRDCT-2815):
 * `PUT /me/default-workspace`. Pinned: the set and the clear (exactly one
 * `is_default` row of the caller, or none), the selection rule that follows
 * (`GET /me` naming no workspace resolves to the chosen one, then to the
 * oldest again after a clear), the three 404s that answer alike and write
 * nothing, the 400s, the 401, that only the caller's own rows move, that the
 * body wins over the request's workspace header, a guest-origin membership,
 * the machines (write scope, read scope, pinned key, unlisted methods), no
 * audit row, and a removed membership that can no longer be the default.
 */
const PASSWORD = 'a-long-default-password-1';
const OWNER = { email: 'owner@default.test', name: 'Olive Owner', password: PASSWORD };
const UNKNOWN_WS = '0f0f0f0f-1111-4222-8333-444455556666';

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let firstId = '';
let secondId = '';
const actors: Record<string, Actor> = {};

let ipCounter = 0;
const nextIp = () => `10.82.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (
  method: string,
  path: string,
  who: { cookie?: string; key?: string },
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
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

async function signIn(email: string): Promise<string> {
  const res = await send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addActor(
  name: string,
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest'; workspace?: string } = {}
): Promise<Actor> {
  const email = `${name}@default.test`;
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  const [row] = await app.db.db
    .insert(workspaceMembers)
    .values({
      workspaceId: opts.workspace ?? firstId,
      userId: created.user.id,
      role: opts.role ?? 'member',
      origin: opts.origin ?? 'local'
    })
    .returning({ id: workspaceMembers.id });
  const actor = { email, cookie: await signIn(email), userId: created.user.id, memberId: row!.id };
  actors[name] = actor;
  return actor;
}

async function mintKey(cookie: string, scopes: string[], workspaceId?: string): Promise<string> {
  const res = await send(
    'POST',
    '/api-keys',
    { cookie },
    {
      name: `key-${scopes.join('-')}${workspaceId ? '-pinned' : ''}`,
      scopes,
      ...(workspaceId ? { workspaceId } : {})
    }
  );
  expect(res.status).toBe(201);
  return (await readJson(res)).key;
}

const setDefault = (
  who: { cookie?: string; key?: string },
  workspaceId: string | null,
  headers?: Record<string, string>
) => send('PUT', '/me/default-workspace', who, { workspaceId }, headers);

/** The workspace ids of the user's rows with is_default = true. */
const defaultsOf = async (userId: string): Promise<string[]> =>
  (
    await app.db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.isDefault, true)))
  ).map((r) => r.workspaceId);

/** `GET /me` naming no workspace: the server's selection rule answers. */
async function meNamingNone(who: { cookie?: string; key?: string }): Promise<{
  activeWorkspaceId: string;
  workspaces: Array<{ id: string; default: boolean }>;
}> {
  const res = await send('GET', '/me', who);
  expect(res.status).toBe(200);
  return readJson(res);
}

const defaultEntries = (me: { workspaces: Array<{ id: string; default: boolean }> }) =>
  me.workspaces.filter((w) => w.default).map((w) => w.id);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'default_workspace'));
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Default', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  firstId = (await readJson(setup)).workspaceId;
  const ownerCookie = await signIn(OWNER.email);
  const me = await readJson(await send('GET', '/me', { cookie: ownerCookie }));
  const [ownerRow] = await app.db.db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, firstId), eq(workspaceMembers.userId, me.user.id)));
  actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id, memberId: ownerRow!.id };
  secondId = (await app.registry.workspaces.create('Second', me.user.id)).workspaceId;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a person in two workspaces chooses, changes and clears their default', () => {
  it('before any choice the first answers; after the set the second answers', async () => {
    const owner = actors.owner!;
    const before = await meNamingNone(owner);
    expect(before.activeWorkspaceId).toBe(firstId);
    expect(before.workspaces.map((w) => w.id).sort()).toEqual([firstId, secondId].sort());
    expect(defaultEntries(before)).toEqual([]);

    const res = await setDefault(owner, secondId);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ defaultWorkspaceId: secondId });
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);

    const after = await meNamingNone(owner);
    expect(after.activeWorkspaceId).toBe(secondId);
    expect(defaultEntries(after)).toEqual([secondId]);
  });

  it('changing it back and forth never leaves two true rows', async () => {
    const owner = actors.owner!;
    const res = await setDefault(owner, firstId);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ defaultWorkspaceId: firstId });
    expect(await defaultsOf(owner.userId)).toEqual([firstId]);

    for (const target of [secondId, firstId, secondId, firstId, secondId]) {
      const step = await setDefault(owner, target);
      expect(step.status).toBe(200);
      expect(await readJson(step)).toEqual({ defaultWorkspaceId: target });
      expect(await defaultsOf(owner.userId)).toEqual([target]);
    }
  });

  it('null clears: no true row, and the oldest membership answers again', async () => {
    const owner = actors.owner!;
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
    const res = await setDefault(owner, null);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ defaultWorkspaceId: null });
    expect(await defaultsOf(owner.userId)).toEqual([]);

    const me = await meNamingNone(owner);
    expect(me.activeWorkspaceId).toBe(firstId);
    expect(defaultEntries(me)).toEqual([]);
  });
});

describe('a workspace that is not an active membership of the caller answers 404, and nothing moves', () => {
  let strangersWs = '';
  let inactiveWs = '';

  beforeAll(async () => {
    const stranger = await addActor('stranger');
    strangersWs = (await app.registry.workspaces.create('Strangers', stranger.userId)).workspaceId;
    // The caller's own membership, switched off: a plain member's row (the
    // last-owner trigger forbids switching off a workspace's only owner).
    inactiveWs = (await app.registry.workspaces.create('Switched off', stranger.userId)).workspaceId;
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: inactiveWs, userId: actors.owner!.userId, role: 'member', isActive: false });
  });

  it('an unknown id, another person’s workspace and the caller’s own inactive membership answer alike', async () => {
    const owner = actors.owner!;
    expect((await setDefault(owner, secondId)).status).toBe(200);
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);

    const bodies: unknown[] = [];
    for (const target of [UNKNOWN_WS, strangersWs, inactiveWs]) {
      const res = await setDefault(owner, target);
      const body = await readJson(res);
      expect({ status: res.status, code: body?.error?.code }).toEqual({ status: 404, code: 'not_found' });
      bodies.push(body);
      expect(await defaultsOf(owner.userId)).toEqual([secondId]);
    }
    // The three answers are the same answer: no oracle about which it was.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // The stranger's own rows are not touched either.
    expect(await defaultsOf(actors.stranger!.userId)).toEqual([]);
  });
});

describe('a malformed body is 400', () => {
  it('a workspaceId that is not a uuid, an empty object and no body at all', async () => {
    const owner = actors.owner!;
    const before = await defaultsOf(owner.userId);
    await expectError(
      await send('PUT', '/me/default-workspace', owner, { workspaceId: 'not-a-uuid' }),
      400,
      'validation_error'
    );
    await expectError(await send('PUT', '/me/default-workspace', owner, {}), 400, 'validation_error');
    await expectError(await send('PUT', '/me/default-workspace', owner), 400, 'validation_error');
    expect(await defaultsOf(owner.userId)).toEqual(before);
  });
});

describe('anonymous', () => {
  it('is 401', async () => {
    await expectError(await setDefault({}, firstId), 401, 'unauthenticated');
  });
});

describe('it touches the caller’s rows only', () => {
  it('another member’s default on the same workspace survives the owner’s set and clear', async () => {
    const other = await addActor('other', { workspace: secondId });
    await app.db.db
      .update(workspaceMembers)
      .set({ isDefault: true })
      .where(eq(workspaceMembers.id, other.memberId));
    expect(await defaultsOf(other.userId)).toEqual([secondId]);

    const owner = actors.owner!;
    expect((await setDefault(owner, secondId)).status).toBe(200);
    expect(await defaultsOf(other.userId)).toEqual([secondId]);
    expect((await setDefault(owner, firstId)).status).toBe(200);
    expect(await defaultsOf(other.userId)).toEqual([secondId]);
    expect((await setDefault(owner, null)).status).toBe(200);
    expect(await defaultsOf(other.userId)).toEqual([secondId]);
    expect(await defaultsOf(owner.userId)).toEqual([]);
  });

  it('two other members of the workspace whose default is false stay false after the owner sets it', async () => {
    const plainA = await addActor('plain-a', { workspace: secondId });
    const plainB = await addActor('plain-b', { workspace: secondId });
    const isDefaultOf = async (memberId: string) =>
      (
        await app.db.db
          .select({ isDefault: workspaceMembers.isDefault })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.id, memberId))
      )[0]?.isDefault;
    expect(await isDefaultOf(plainA.memberId)).toBe(false);
    expect(await isDefaultOf(plainB.memberId)).toBe(false);

    const owner = actors.owner!;
    expect((await setDefault(owner, secondId)).status).toBe(200);
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
    // A set that lost its user_id clause would turn these two true.
    expect(await isDefaultOf(plainA.memberId)).toBe(false);
    expect(await isDefaultOf(plainB.memberId)).toBe(false);
    expect((await setDefault(owner, null)).status).toBe(200);
  });
});

describe('the request’s workspace header does not decide', () => {
  it('naming the first workspace in X-Workspace-Id and the second in the body sets the second', async () => {
    const owner = actors.owner!;
    const res = await setDefault(owner, secondId, { 'x-workspace-id': firstId });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ defaultWorkspaceId: secondId });
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
    expect((await setDefault(owner, null)).status).toBe(200);
  });
});

describe('a guest-origin membership', () => {
  it('the guest sets their default to the workspace where they are a guest: 200', async () => {
    const guest = await addActor('guest', { origin: 'guest' });
    const res = await setDefault(guest, firstId);
    const body = await readJson(res);
    expect({ status: res.status, body }).toEqual({ status: 200, body: { defaultWorkspaceId: firstId } });
    expect(await defaultsOf(guest.userId)).toEqual([firstId]);
  });
});

describe('machines', () => {
  it('an unpinned key with read and write sets the default', async () => {
    const owner = actors.owner!;
    expect((await setDefault(owner, null)).status).toBe(200);
    const key = await mintKey(owner.cookie, [host.scopes.read, host.scopes.write]);
    const res = await setDefault({ key }, secondId);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ defaultWorkspaceId: secondId });
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
  });

  it('a key with the read scope only is 403 insufficient_scope, and nothing moves', async () => {
    const owner = actors.owner!;
    const key = await mintKey(owner.cookie, [host.scopes.read]);
    await expectError(await setDefault({ key }, firstId), 403, 'insufficient_scope');
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
  });

  it('a key pinned to one workspace is 403 key_pinned, and nothing moves', async () => {
    const owner = actors.owner!;
    const key = await mintKey(owner.cookie, [host.scopes.read, host.scopes.write], firstId);
    await expectError(await setDefault({ key }, firstId), 403, 'key_pinned');
    await expectError(await setDefault({ key }, null), 403, 'key_pinned');
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
  });

  it('GET, POST and DELETE on the path are refused to the unpinned key (endpoint_not_allowed)', async () => {
    const owner = actors.owner!;
    const key = await mintKey(owner.cookie, [host.scopes.read, host.scopes.write]);
    await expectError(await send('GET', '/me/default-workspace', { key }), 403, 'endpoint_not_allowed');
    await expectError(
      await send('POST', '/me/default-workspace', { key }, { workspaceId: firstId }),
      403,
      'endpoint_not_allowed'
    );
    await expectError(await send('DELETE', '/me/default-workspace', { key }), 403, 'endpoint_not_allowed');
    expect(await defaultsOf(owner.userId)).toEqual([secondId]);
    expect((await setDefault(owner, null)).status).toBe(200);
  });
});

describe('no audit row', () => {
  const counts = async () => {
    const { rows } = await app.db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM audit_log WHERE action ILIKE '%default%') AS default_actions,
         (SELECT count(*)::int FROM audit_log WHERE workspace_id = $1) AS in_second,
         (SELECT count(*)::int FROM audit_log WHERE workspace_id = $2) AS in_first,
         (SELECT count(*)::int FROM audit_log) AS total`,
      [secondId, firstId]
    );
    return rows[0] as { default_actions: number; in_second: number; in_first: number; total: number };
  };

  it('a set and a clear leave the audit log as it was', async () => {
    const owner = actors.owner!;
    const before = await counts();
    expect((await setDefault(owner, secondId)).status).toBe(200);
    expect((await setDefault(owner, null)).status).toBe(200);
    expect(await counts()).toEqual(before);
  });
});

describe('a removed membership can no longer be the default', () => {
  it('the removal clears the flag, and the removed person naming that workspace is 404', async () => {
    const leaver = await addActor('leaver');
    // A second membership, so the person keeps a principal after the removal.
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: secondId, userId: leaver.userId, role: 'member' });

    expect((await setDefault(leaver, firstId)).status).toBe(200);
    expect(await defaultsOf(leaver.userId)).toEqual([firstId]);

    const removed = await send('POST', `/members/${leaver.memberId}/remove`, actors.owner!, undefined, {
      'x-workspace-id': firstId
    });
    expect(removed.status).toBe(200);
    const [row] = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, leaver.memberId));
    expect(row).toMatchObject({ isActive: false, isDefault: false });

    await expectError(await setDefault(leaver, firstId), 404, 'not_found');
    expect(await defaultsOf(leaver.userId)).toEqual([]);
  });
});
