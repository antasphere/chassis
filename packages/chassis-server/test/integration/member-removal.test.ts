import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import {
  projectMembers,
  projectTeams,
  user as userTable,
  workspaceMembers,
  workspaceTeamMembers,
  workspaceTeams
} from '@antasphere/chassis-db';
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
 * Removing a member (PRDCT-2816): `POST /members/{id}/remove`, the act between
 * the pause and the account erasure. Pinned: the membership row is switched
 * off and KEPT (is_active and is_default false), the person's project grants
 * and team seats are deleted with it (their teams and the teams' project
 * entries stay, and so do everybody else's), the account and the person's
 * memberships of other workspaces are untouched; the removed person no longer
 * reaches the workspace; invited back, they reactivate the SAME row with no
 * grant and no seat; a pause keeps both (the contrast) and a paused member can
 * still be removed; another workspace's membership reads as absent; who may
 * remove whom (anonymous, plain member, admin on an owner, oneself, owner on
 * owner, the last-owner guard under a race); machine credentials never reach
 * the route; and the `member.remove` audit record with its counts.
 */
const PASSWORD = 'a-long-removal-password-1';
const OWNER = { email: 'owner@removal.test', name: 'Olive Owner', password: PASSWORD };

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let otherWorkspaceId = '';
const actors: Record<string, Actor> = {};

let ipCounter = 0;
const nextIp = () => `10.81.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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
  const email = `${name}@removal.test`;
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  const [row] = await app.db.db
    .insert(workspaceMembers)
    .values({
      workspaceId: opts.workspace ?? workspaceId,
      userId: created.user.id,
      role: opts.role ?? 'member',
      origin: opts.origin ?? 'local'
    })
    .returning({ id: workspaceMembers.id });
  const actor = { email, cookie: await signIn(email), userId: created.user.id, memberId: row!.id };
  actors[name] = actor;
  return actor;
}

async function mintKey(cookie: string, scopes: string[]): Promise<string> {
  const res = await send('POST', '/api-keys', { cookie }, { name: `key-${scopes.join('-')}`, scopes });
  expect(res.status).toBe(201);
  return (await readJson(res)).key;
}

async function createProject(
  who: { cookie?: string },
  name: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await send('POST', '/projects', who, { name }, headers);
  expect(res.status).toBe(201);
  return (await readJson(res)).id;
}

async function createTeam(who: { cookie?: string }, name: string): Promise<string> {
  const res = await send('POST', '/teams', who, { name });
  expect(res.status).toBe(201);
  return (await readJson(res)).id;
}

async function grant(
  projectId: string,
  who: Actor,
  role: 'manager' | 'editor' | 'viewer',
  headers: Record<string, string> = {}
): Promise<void> {
  const res = await send(
    'POST',
    `/projects/${projectId}/members`,
    actors.owner!,
    { userId: who.userId, role },
    headers
  );
  expect(res.status).toBe(201);
}

async function seatIn(teamId: string, who: Actor): Promise<void> {
  const res = await send('POST', `/teams/${teamId}/members`, actors.owner!, { userId: who.userId });
  expect(res.status).toBe(201);
}

const remove = (memberId: string, who: { cookie?: string; key?: string }, headers?: Record<string, string>) =>
  send('POST', `/members/${memberId}/remove`, who, undefined, headers);

const memberRow = async (memberId: string) =>
  (await app.db.db.select().from(workspaceMembers).where(eq(workspaceMembers.id, memberId)))[0];
const grantsOf = (memberId: string) =>
  app.db.db.select().from(projectMembers).where(eq(projectMembers.memberId, memberId));
const seatsOf = (memberId: string) =>
  app.db.db.select().from(workspaceTeamMembers).where(eq(workspaceTeamMembers.memberId, memberId));
const listedProjects = async (who: Actor): Promise<string[]> => {
  const res = await send('GET', '/projects?limit=100', who);
  expect(res.status).toBe(200);
  return (await readJson(res)).projects.map((p: { id: string }) => p.id);
};

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'member_removal'));
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Removal', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const ownerCookie = await signIn(OWNER.email);
  const me = await readJson(await send('GET', '/me', { cookie: ownerCookie }));
  const [ownerRow] = await app.db.db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, me.user.id)));
  actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id, memberId: ownerRow!.id };
  otherWorkspaceId = (await app.registry.workspaces.create('Elsewhere', me.user.id)).workspaceId;

  await addActor('admin', { role: 'admin' });
  for (const name of ['leaver', 'stayer', 'member', 'paused', 'both', 'target', 'defaulted']) {
    await addActor(name);
  }
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a removal takes the grants and the seats, and keeps the account', () => {
  let p1 = '';
  let p2 = '';
  let t1 = '';

  beforeAll(async () => {
    p1 = await createProject(actors.owner!, 'Removal P1');
    p2 = await createProject(actors.owner!, 'Removal P2');
    t1 = await createTeam(actors.owner!, 'Removal T1');
    await grant(p1, actors.leaver!, 'editor');
    await grant(p1, actors.stayer!, 'viewer');
    await seatIn(t1, actors.leaver!);
    await seatIn(t1, actors.stayer!);
    const onP2 = await send('POST', `/projects/${p2}/members`, actors.owner!, { teamId: t1, role: 'viewer' });
    expect(onP2.status).toBe(201);
  });

  it('removes: 200 with the member off; the row kept, the grant and the seat gone, the rest untouched', async () => {
    const leaver = actors.leaver!;
    const stayer = actors.stayer!;
    expect(await listedProjects(leaver)).toEqual(expect.arrayContaining([p1, p2]));

    const res = await remove(leaver.memberId, actors.admin!);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({
      id: leaver.memberId,
      userId: leaver.userId,
      email: leaver.email,
      role: 'member',
      isActive: false
    });

    expect(await memberRow(leaver.memberId)).toMatchObject({
      workspaceId,
      isActive: false,
      isDefault: false
    });
    expect(await grantsOf(leaver.memberId)).toHaveLength(0);
    expect(await seatsOf(leaver.memberId)).toHaveLength(0);
    expect(await app.db.db.select().from(userTable).where(eq(userTable.id, leaver.userId))).toHaveLength(1);

    // The team and its place on P2 stay.
    expect(await app.db.db.select().from(workspaceTeams).where(eq(workspaceTeams.id, t1))).toHaveLength(1);
    expect(
      await app.db.db
        .select()
        .from(projectTeams)
        .where(and(eq(projectTeams.projectId, p2), eq(projectTeams.teamId, t1)))
    ).toHaveLength(1);

    // Everybody else's grant on P1 and seat in T1 stay.
    expect(await grantsOf(stayer.memberId)).toEqual([
      expect.objectContaining({ projectId: p1, role: 'viewer' })
    ]);
    expect(await seatsOf(stayer.memberId)).toEqual([expect.objectContaining({ teamId: t1 })]);
    expect(await listedProjects(stayer)).toEqual(expect.arrayContaining([p1, p2]));
  });

  it('the removed person no longer reaches the workspace', async () => {
    const leaver = actors.leaver!;
    // /me still answers the signed-in account, without the workspace.
    const me = await send('GET', '/me', leaver);
    expect(me.status).toBe(200);
    const workspaces = (await readJson(me)).workspaces as Array<{ id: string }>;
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.map((w) => w.id)).not.toContain(workspaceId);
    // Naming the workspace resolves no membership, so no principal: pinned as
    // observed, 401 unauthenticated.
    await expectError(
      await send('GET', '/projects', leaver, undefined, { 'x-workspace-id': workspaceId }),
      401,
      'unauthenticated'
    );
  });

  it('invited back, the person reactivates the SAME row and starts clean', async () => {
    const leaver = actors.leaver!;
    const invited = await send('POST', '/invitations', actors.owner!, {
      email: leaver.email,
      role: 'member'
    });
    expect(invited.status).toBe(201);
    const token = ((await readJson(invited)).acceptUrl as string).split('/invite/')[1]!;
    const accepted = await send('POST', '/invitations/accept', leaver, { token });
    expect(accepted.status).toBe(200);

    const rows = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, leaver.userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: leaver.memberId, isActive: true });
    const listed = await listedProjects(leaver);
    expect(listed).not.toContain(p1);
    expect(listed).not.toContain(p2);
    expect(await grantsOf(leaver.memberId)).toHaveLength(0);
    expect(await seatsOf(leaver.memberId)).toHaveLength(0);
  });
});

describe('a pause keeps the grants and the seats (the contrast)', () => {
  it('paused: both rows stay; then removed while paused: 200 and both rows gone', async () => {
    const paused = actors.paused!;
    const project = await createProject(actors.owner!, 'Pause project');
    const team = await createTeam(actors.owner!, 'Pause team');
    await grant(project, paused, 'editor');
    await seatIn(team, paused);

    const pause = await send('PATCH', `/members/${paused.memberId}`, actors.admin!, { isActive: false });
    expect(pause.status).toBe(200);
    expect(await memberRow(paused.memberId)).toMatchObject({ isActive: false });
    expect(await grantsOf(paused.memberId)).toHaveLength(1);
    expect(await seatsOf(paused.memberId)).toHaveLength(1);

    const res = await remove(paused.memberId, actors.admin!);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id: paused.memberId, isActive: false });
    expect(await grantsOf(paused.memberId)).toHaveLength(0);
    expect(await seatsOf(paused.memberId)).toHaveLength(0);
    expect(await memberRow(paused.memberId)).toMatchObject({ isActive: false });
  });
});

describe('another workspace’s member is absent', () => {
  it('a membership of another workspace is 404 not_found and stays as it was', async () => {
    const created = await app.auth.api.signUpEmail({
      body: { email: 'foreigner@removal.test', password: PASSWORD, name: 'foreigner' }
    });
    const [row] = await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspaceId, userId: created.user.id, role: 'member' })
      .returning({ id: workspaceMembers.id });
    await expectError(await remove(row!.id, actors.owner!), 404, 'not_found');
    expect(await memberRow(row!.id)).toMatchObject({ workspaceId: otherWorkspaceId, isActive: true });
  });

  it('a well-formed unknown id is 404, a non-uuid id is 400', async () => {
    await expectError(await remove('0f0f0f0f-1111-4222-8333-444455556666', actors.owner!), 404, 'not_found');
    await expectError(await remove('not-a-uuid', actors.owner!), 400, 'validation_error');
  });
});

describe('the person’s other workspace is untouched', () => {
  it('removed here, the membership and the grant there stay', async () => {
    const both = actors.both!;
    const there = { 'x-workspace-id': otherWorkspaceId };
    const [thereRow] = await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspaceId, userId: both.userId, role: 'member' })
      .returning({ id: workspaceMembers.id });
    // Both projects through the routes: the owner owns both workspaces.
    const here = await createProject(actors.owner!, 'Both: here');
    const away = await createProject(actors.owner!, 'Both: there', there);
    await grant(here, both, 'viewer');
    await grant(away, both, 'editor', there);
    expect(await grantsOf(thereRow!.id)).toHaveLength(1);

    expect((await remove(both.memberId, actors.owner!)).status).toBe(200);

    expect(await grantsOf(both.memberId)).toHaveLength(0);
    expect(await memberRow(thereRow!.id)).toMatchObject({ workspaceId: otherWorkspaceId, isActive: true });
    expect(await grantsOf(thereRow!.id)).toEqual([
      expect.objectContaining({ projectId: away, role: 'editor' })
    ]);
    const listed = await send('GET', '/projects?limit=100', both, undefined, there);
    expect(listed.status).toBe(200);
    expect((await readJson(listed)).projects.map((p: { id: string }) => p.id)).toContain(away);
  });
});

describe('who may remove whom', () => {
  it('anonymous is 401', async () => {
    await expectError(await remove(actors.target!.memberId, {}), 401, 'unauthenticated');
  });

  it('a plain member is 403', async () => {
    await expectError(await remove(actors.target!.memberId, actors.member!), 403, 'forbidden');
    expect(await memberRow(actors.target!.memberId)).toMatchObject({ isActive: true });
  });

  it('the caller removing themself is 400 cannot_remove_self', async () => {
    await expectError(await remove(actors.admin!.memberId, actors.admin!), 400, 'cannot_remove_self');
    await expectError(await remove(actors.owner!.memberId, actors.owner!), 400, 'cannot_remove_self');
    expect(await memberRow(actors.admin!.memberId)).toMatchObject({ isActive: true });
  });

  it('an owner removes a second owner (200); an admin is refused an owner (403 forbidden)', async () => {
    const ownerA = await addActor('owner-a', { role: 'owner' });
    const ownerB = await addActor('owner-b', { role: 'owner' });
    // A was not the last active owner: B removes A.
    const res = await remove(ownerA.memberId, ownerB);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id: ownerA.memberId, role: 'owner', isActive: false });
    // An admin never removes an owner, and nothing moves.
    await expectError(await remove(ownerB.memberId, actors.admin!), 403, 'forbidden');
    expect(await memberRow(ownerB.memberId)).toMatchObject({ role: 'owner', isActive: true });
  });

  // The last-owner guard (400 `last_owner`) is structurally unreachable by ONE
  // sequential request: the target must be an active owner, the caller must be
  // an owner (an admin meets 403 first) who is not the target (400
  // cannot_remove_self), and the caller's own membership is active (the
  // credential resolves only an active one) — so two active owners always
  // exist when the handler runs. The guard answers only a RACE: two owners
  // removing each other at once, the case last-owner-race.test.ts pins for the
  // account deletion and the demotion. That race, in a workspace of its own:
  it('two owners removing each other at once: exactly one wins, the loser meets last_owner, one owner stays', async () => {
    const x = await addActor('race-x', { role: 'owner' });
    const raceWs = (await app.registry.workspaces.create('Race', x.userId)).workspaceId;
    const created = await app.auth.api.signUpEmail({
      body: { email: 'race-y@removal.test', password: PASSWORD, name: 'race-y' }
    });
    const [yRow] = await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: raceWs, userId: created.user.id, role: 'owner' })
      .returning({ id: workspaceMembers.id });
    const yCookie = await signIn('race-y@removal.test');
    const [xRow] = await app.db.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, raceWs), eq(workspaceMembers.userId, x.userId)));
    const inRace = { 'x-workspace-id': raceWs };

    const results = await Promise.all([
      remove(yRow!.id, x, inRace),
      remove(xRow!.id, { cookie: yCookie }, inRace)
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const r of results) {
      if (r.status === 200) continue;
      // 400 last_owner from the guard. A loser whose credential resolved
      // after the winning removal landed never reaches the guard: its own
      // membership is off by then (401), or its role is read as gone (403).
      expect([400, 401, 403]).toContain(r.status);
      if (r.status === 400) expect((await readJson(r)).error.code).toBe('last_owner');
    }
    const owners = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, raceWs),
          eq(workspaceMembers.role, 'owner'),
          eq(workspaceMembers.isActive, true)
        )
      );
    expect(owners).toHaveLength(1);
  }, 60_000);
});

describe('machines never reach it', () => {
  it('an owner’s key with both scopes is 403, and the target is unchanged', async () => {
    const target = actors.target!;
    const project = await createProject(actors.owner!, 'Machine project');
    await grant(project, target, 'viewer');
    const key = await mintKey(actors.owner!.cookie, [host.scopes.read, host.scopes.write]);
    await expectError(await remove(target.memberId, { key }), 403, 'endpoint_not_allowed');
    expect(await memberRow(target.memberId)).toMatchObject({ isActive: true });
    expect(await grantsOf(target.memberId)).toHaveLength(1);
  });
});

describe('the default flag goes with the membership', () => {
  it('is_default is false on the removed row', async () => {
    const defaulted = actors.defaulted!;
    await app.db.db
      .update(workspaceMembers)
      .set({ isDefault: true })
      .where(eq(workspaceMembers.id, defaulted.memberId));
    expect(await memberRow(defaulted.memberId)).toMatchObject({ isDefault: true });
    expect((await remove(defaulted.memberId, actors.owner!)).status).toBe(200);
    expect(await memberRow(defaulted.memberId)).toMatchObject({ isActive: false, isDefault: false });
  });
});

describe('the record', () => {
  it('every removal wrote member.remove, with the target and the counts', async () => {
    const res = await send('GET', '/audit?action=member.remove&limit=100', actors.owner!);
    expect(res.status).toBe(200);
    const entries = (await readJson(res)).entries as Array<{
      action: string;
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    }>;
    const leaver = actors.leaver!;
    const mine = entries.filter((e) => e.resourceId === leaver.memberId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      action: 'member.remove',
      resourceType: 'member',
      metadata: { targetUserId: leaver.userId, projectGrants: 1, teamSeats: 1 }
    });
    for (const e of entries) {
      expect(typeof e.metadata.projectGrants).toBe('number');
      expect(typeof e.metadata.teamSeats).toBe('number');
    }
    const paused = entries.find((e) => e.resourceId === actors.paused!.memberId);
    expect(paused?.metadata).toMatchObject({ projectGrants: 1, teamSeats: 1 });
  });
});
