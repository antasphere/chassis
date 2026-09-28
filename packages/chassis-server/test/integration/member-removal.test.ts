import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import {
  invitations,
  projectMembers,
  projectTeams,
  user as userTable,
  workspaceMembers,
  workspaceTeamMembers,
  workspaceTeams
} from '@antasphere/chassis-db';
import { deleteMembershipGrants, type RemovedMembership } from '../../src/members/removal.js';
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
    // The removed owner's row is left at the member role (PRDCT-2816 F1).
    expect(await readJson(res)).toMatchObject({ id: ownerA.memberId, role: 'member', isActive: false });
    expect(await memberRow(ownerA.memberId)).toMatchObject({ role: 'member', isActive: false });
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

describe('a removed admin comes back as a plain member', () => {
  it('removed: the row reads member and inactive; reactivated by an admin: a plain member', async () => {
    const exAdmin = await addActor('ex-admin', { role: 'admin' });
    const res = await remove(exAdmin.memberId, actors.owner!);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id: exAdmin.memberId, role: 'member', isActive: false });
    expect(await memberRow(exAdmin.memberId)).toMatchObject({ role: 'member', isActive: false });

    const back = await send('PATCH', `/members/${exAdmin.memberId}`, actors.admin!, { isActive: true });
    expect(back.status).toBe(200);
    expect(await readJson(back)).toMatchObject({ id: exAdmin.memberId, role: 'member', isActive: true });
    expect(await memberRow(exAdmin.memberId)).toMatchObject({ role: 'member', isActive: true });

    // A plain member reads the roster, and is refused an admin's act.
    expect((await send('GET', '/members', exAdmin)).status).toBe(200);
    const invite = await send('POST', '/invitations', exAdmin, {
      email: 'nobody-new@removal.test',
      role: 'member'
    });
    expect(invite.status).toBe(403);
  });
});

describe('deleteMembershipGrants, called directly (S06)', () => {
  it('two memberships with a grant and a seat each: both counted, both gone; the hook sees both', async () => {
    const d1 = await addActor('direct-1');
    const d2 = await addActor('direct-2');
    const project = await createProject(actors.owner!, 'Direct project');
    const team = await createTeam(actors.owner!, 'Direct team');
    for (const who of [d1, d2]) {
      await grant(project, who, 'viewer');
      await seatIn(team, who);
      expect(await grantsOf(who.memberId)).toHaveLength(1);
      expect(await seatsOf(who.memberId)).toHaveLength(1);
    }
    const removed: RemovedMembership[] = [d1, d2].map((who) => ({
      memberId: who.memberId,
      workspaceId,
      userId: who.userId
    }));

    const plain = await app.db.db.transaction((tx) => deleteMembershipGrants(tx, removed));
    expect(plain).toEqual({ projectGrants: 2, teamSeats: 2, invitations: 0, demoPasses: 0, tool: {} });
    for (const who of [d1, d2]) {
      expect(await grantsOf(who.memberId)).toHaveLength(0);
      expect(await seatsOf(who.memberId)).toHaveLength(0);
    }

    const seen: Array<readonly RemovedMembership[]> = [];
    const hooked = await app.db.db.transaction((tx) =>
      deleteMembershipGrants(tx, removed, async (_tx, rows) => {
        seen.push(rows);
        return { things: 3 };
      })
    );
    expect(hooked).toEqual({
      projectGrants: 0,
      teamSeats: 0,
      invitations: 0,
      demoPasses: 0,
      tool: { things: 3 }
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { memberId: d1.memberId, workspaceId, userId: d1.userId },
      { memberId: d2.memberId, workspaceId, userId: d2.userId }
    ]);
  });

  it('an empty list calls no hook and counts nothing', async () => {
    let calls = 0;
    const result = await app.db.db.transaction((tx) =>
      deleteMembershipGrants(tx, [], async () => {
        calls += 1;
        return { things: 3 };
      })
    );
    expect(result).toEqual({ projectGrants: 0, teamSeats: 0, invitations: 0, demoPasses: 0, tool: {} });
    expect(calls).toBe(0);
  });
});

describe('the invitations open at the removal', () => {
  type Invited = { id: string; token: string };

  const invite = async (
    who: { cookie?: string },
    email: string,
    role: 'owner' | 'admin' | 'member',
    headers: Record<string, string> = {}
  ): Promise<Invited> => {
    const res = await send('POST', '/invitations', who, { email, role }, headers);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.invitation.id, token: (body.acceptUrl as string).split('/invite/')[1]! };
  };
  const invitationRow = async (id: string) =>
    (await app.db.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
  const pause = async (who: Actor): Promise<void> => {
    const res = await send('PATCH', `/members/${who.memberId}`, actors.admin!, { isActive: false });
    expect(res.status).toBe(200);
  };
  const removalEntry = async (memberId: string) => {
    const res = await send('GET', '/audit?action=member.remove&limit=100', actors.owner!);
    expect(res.status).toBe(200);
    const entries = (await readJson(res)).entries as Array<{
      resourceId: string;
      metadata: Record<string, unknown>;
    }>;
    const mine = entries.filter((e) => e.resourceId === memberId);
    expect(mine).toHaveLength(1);
    return mine[0]!;
  };

  it('N1: an invitation for a paused person, open at the removal, is revoked and brings nobody back', async () => {
    const n1 = await addActor('n1-paused');
    await pause(n1);
    const open = await invite(actors.admin!, n1.email, 'admin');
    expect(await invitationRow(open.id)).toMatchObject({ revokedAt: null, acceptedAt: null });

    expect((await remove(n1.memberId, actors.owner!)).status).toBe(200);
    expect((await invitationRow(open.id)).revokedAt).toBeInstanceOf(Date);

    // Pinned as observed: a revoked invitation is not live, so the accept
    // answers the lookup's 404 not_found.
    await expectError(await send('POST', '/invitations/accept', n1, { token: open.token }), 404, 'not_found');
    expect(await memberRow(n1.memberId)).toMatchObject({ isActive: false, role: 'member' });
  });

  it('an invitation made after the removal is the workspace’s own act: accepted, at the role it names', async () => {
    const n1 = actors['n1-paused']!;
    const after = await invite(actors.owner!, n1.email, 'admin');
    const res = await send('POST', '/invitations/accept', n1, { token: after.token });
    expect(res.status).toBe(200);
    expect(await memberRow(n1.memberId)).toMatchObject({ isActive: true, role: 'admin' });
  });

  it('N2: an invitation a removed admin issued is revoked, and accepting it creates no member', async () => {
    const issuer = await addActor('n2-issuer', { role: 'admin' });
    const address = 'n2-other-address@removal.test';
    const issued = await invite(issuer, address, 'admin');

    expect((await remove(issuer.memberId, actors.owner!)).status).toBe(200);
    expect((await invitationRow(issued.id)).revokedAt).toBeInstanceOf(Date);

    // Clean context (no cookie), the account-creating shape. Pinned as observed.
    await expectError(
      await send(
        'POST',
        '/invitations/accept',
        {},
        { token: issued.token, name: 'Other', password: PASSWORD }
      ),
      404,
      'not_found'
    );
    const members = await app.db.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(userTable.email, address));
    expect(members).toHaveLength(0);
    expect(await app.db.db.select().from(userTable).where(eq(userTable.email, address))).toHaveLength(0);
  });

  it('boundaries: another workspace, accepted, already revoked and other people’s rows are untouched; case is ignored', async () => {
    const bound = await addActor('bound-case');
    const elsewhere = { 'x-workspace-id': otherWorkspaceId };
    const inOther = await invite(actors.owner!, bound.email, 'member', elsewhere);

    // An ACCEPTED invitation for the person: paused, invited, accepted back.
    await pause(bound);
    const accepted = await invite(actors.owner!, bound.email, 'member');
    expect((await send('POST', '/invitations/accept', bound, { token: accepted.token })).status).toBe(200);
    const acceptedAt = (await invitationRow(accepted.id)).acceptedAt;
    expect(acceptedAt).toBeInstanceOf(Date);

    // An already REVOKED one, its revoked_at moved to a fixed old time.
    await pause(bound);
    const revoked = await invite(actors.owner!, bound.email, 'member');
    expect((await send('DELETE', `/invitations/${revoked.id}`, actors.owner!)).status).toBe(200);
    const oldRevokedAt = new Date('2020-01-01T00:00:00.000Z');
    await app.db.db
      .update(invitations)
      .set({ revokedAt: oldRevokedAt })
      .where(eq(invitations.id, revoked.id));

    // An OPEN one whose stored address is in mixed case.
    const mixed = await invite(actors.owner!, bound.email, 'member');
    await app.db.db
      .update(invitations)
      .set({ email: 'Bound-Case@Removal.TEST' })
      .where(eq(invitations.id, mixed.id));

    // Someone else's invitation, issued by someone else.
    const bystander = await invite(actors.admin!, 'bystander@removal.test', 'member');

    const res = await remove(bound.memberId, actors.owner!);
    expect(res.status).toBe(200);

    expect(await invitationRow(inOther.id)).toMatchObject({ revokedAt: null, acceptedAt: null });
    expect(await invitationRow(accepted.id)).toMatchObject({ acceptedAt, revokedAt: null });
    expect((await invitationRow(revoked.id)).revokedAt).toEqual(oldRevokedAt);
    expect(await invitationRow(bystander.id)).toMatchObject({ revokedAt: null, acceptedAt: null });
    const mixedRow = await invitationRow(mixed.id);
    expect(mixedRow.revokedAt).toBeInstanceOf(Date);
    expect(mixedRow.acceptedAt).toBeNull();

    // Only the mixed-case open row was this removal's to revoke.
    expect((await removalEntry(bound.memberId)).metadata).toMatchObject({ invitations: 1 });
  });

  it('the member.remove entries count the invitations revoked', async () => {
    expect((await removalEntry(actors['n1-paused']!.memberId)).metadata).toMatchObject({ invitations: 1 });
    expect((await removalEntry(actors['n2-issuer']!.memberId)).metadata).toMatchObject({ invitations: 1 });
  });

  it('a direct call with two memberships, each with one invitation for them: invitations 2, both revoked', async () => {
    const e1 = await addActor('direct-inv-1');
    const e2 = await addActor('direct-inv-2');
    const opened: Invited[] = [];
    for (const who of [e1, e2]) {
      await pause(who);
      opened.push(await invite(actors.owner!, who.email, 'member'));
    }
    const removed: RemovedMembership[] = [e1, e2].map((who) => ({
      memberId: who.memberId,
      workspaceId,
      userId: who.userId
    }));
    const result = await app.db.db.transaction((tx) => deleteMembershipGrants(tx, removed));
    expect(result).toEqual({ projectGrants: 0, teamSeats: 0, invitations: 2, demoPasses: 0, tool: {} });
    for (const row of opened) {
      expect((await invitationRow(row.id)).revokedAt).toBeInstanceOf(Date);
    }
  });
});

// Round 3, F2: the removal locked the membership row and then the invitation,
// an accept locks the invitation and then the membership row; racing, one of
// the two died of a deadlock and answered 500. The removal now takes what the
// person held first and the row second, the accept's order.
describe('a removal racing an acceptance', () => {
  it('eight rounds: never a 500, and the row always matches whoever won', async () => {
    const observed: Record<string, number> = {};
    for (let round = 1; round <= 8; round++) {
      const racer = await addActor(`racer-${round}`);
      const pause = await send('PATCH', `/members/${racer.memberId}`, actors.admin!, { isActive: false });
      expect(pause.status).toBe(200);
      const invited = await send('POST', '/invitations', actors.admin!, {
        email: racer.email,
        role: 'admin'
      });
      expect(invited.status).toBe(201);
      const invitedBody = await readJson(invited);
      const invitationId = invitedBody.invitation.id as string;
      const token = (invitedBody.acceptUrl as string).split('/invite/')[1]!;

      const [removed, accepted] = await Promise.all([
        remove(racer.memberId, actors.owner!),
        send('POST', '/invitations/accept', racer, { token })
      ]);
      const acceptCode = accepted.status === 200 ? '' : ` ${(await readJson(accepted))?.error?.code}`;
      const row = await memberRow(racer.memberId);
      const [invitation] = await app.db.db.select().from(invitations).where(eq(invitations.id, invitationId));
      const state = {
        isActive: row!.isActive,
        role: row!.role,
        revoked: invitation!.revokedAt !== null,
        accepted: invitation!.acceptedAt !== null
      };
      const pair = `remove ${removed.status} / accept ${accepted.status}${acceptCode} → ${JSON.stringify(state)}`;
      observed[pair] = (observed[pair] ?? 0) + 1;
      console.log(`race round ${round}: ${pair}`);

      expect(removed.status).not.toBe(500);
      expect(accepted.status).not.toBe(500);
      expect(removed.status).toBe(200);
      expect([200, 404, 410]).toContain(accepted.status);
      expect([
        // The removal won: the invitation went with it.
        { isActive: false, role: 'member', revoked: true, accepted: false },
        // The acceptance committed first and the removal came after it, the
        // later act: the person is out, and the invitation reads as used.
        { isActive: false, role: 'member', revoked: false, accepted: true }
      ]).toContainEqual(state);
    }
    console.log('removal vs accept race outcomes:', JSON.stringify(observed));
  }, 120_000);
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
      metadata: { targetUserId: leaver.userId, roleBefore: 'member', projectGrants: 1, teamSeats: 1 }
    });
    for (const e of entries) {
      expect(typeof e.metadata.projectGrants).toBe('number');
      expect(typeof e.metadata.teamSeats).toBe('number');
    }
    const paused = entries.find((e) => e.resourceId === actors.paused!.memberId);
    expect(paused?.metadata).toMatchObject({ projectGrants: 1, teamSeats: 1 });
    // The role the person held before the removal is on the record.
    const exAdmin = entries.find((e) => e.resourceId === actors['ex-admin']!.memberId);
    expect(exAdmin?.metadata).toMatchObject({
      targetUserId: actors['ex-admin']!.userId,
      roleBefore: 'admin'
    });
    const ownerA = entries.find((e) => e.resourceId === actors['owner-a']!.memberId);
    expect(ownerA?.metadata).toMatchObject({ roleBefore: 'owner' });
  });
});
