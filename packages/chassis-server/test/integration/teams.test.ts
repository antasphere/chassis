import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers, workspaceTeamMembers, workspaceTeams } from '@antasphere/chassis-db';
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
 * Teams on the self-hosted edition (PRDCT-2813): the tool's own, made and
 * shaped here by owners and admins, read by every non-guest member. Pinned:
 * the slug (derived, explicit, taken), the read/write split, the guest and
 * anonymous refusals, a team of another workspace reading as absent, seating
 * among the workspace's own active non-guest members, the members list's
 * cursor surviving a removal, the cascades (a deleted team takes its seats, a
 * deleted account takes its seats, a deactivation keeps them), the machine
 * principals, and one audit action per change.
 */
const PASSWORD = 'a-long-teams-password-1';
const OWNER = { email: 'owner@teams.test', name: 'Olive Owner', password: PASSWORD };

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let otherWorkspaceId = '';
const actors: Record<string, Actor> = {};

let ipCounter = 0;
const nextIp = () => `10.79.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest' } = {}
): Promise<Actor> {
  const email = `${name}@teams.test`;
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  const [row] = await app.db.db
    .insert(workspaceMembers)
    .values({
      workspaceId,
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

async function createTeam(who: { cookie?: string; key?: string }, name: string, slug?: string) {
  const res = await send('POST', '/teams', who, { name, ...(slug ? { slug } : {}) });
  expect(res.status).toBe(201);
  return readJson(res) as Promise<{ id: string; slug: string }>;
}

const seatsOfTeam = (teamId: string) =>
  app.db.db.select().from(workspaceTeamMembers).where(eq(workspaceTeamMembers.teamId, teamId));
const seatsOfMember = (memberId: string) =>
  app.db.db.select().from(workspaceTeamMembers).where(eq(workspaceTeamMembers.memberId, memberId));

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'teams'));
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Teams', owner: OWNER }
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
  for (const name of ['member', 'alice', 'bob', 'carol', 'dave', 'sleeper', 'erased', 'paused']) {
    await addActor(name);
  }
  await addActor('guest', { origin: 'guest' });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('creating and shaping a team', () => {
  it('an owner creates one: the slug is derived from the name, accents folded', async () => {
    const res = await send('POST', '/teams', actors.owner!, { name: 'Équipe Créative' });
    expect(res.status).toBe(201);
    expect(await readJson(res)).toMatchObject({
      name: 'Équipe Créative',
      slug: 'equipe-creative',
      hubTeamId: null,
      membersCount: 0,
      isMember: false
    });
    const [row] = await app.db.db
      .select()
      .from(workspaceTeams)
      .where(eq(workspaceTeams.slug, 'equipe-creative'));
    expect(row).toMatchObject({ workspaceId, hubTeamId: null, createdBy: actors.owner!.userId });
  });

  it('an admin creates one with an explicit slug', async () => {
    const res = await send('POST', '/teams', actors.admin!, { name: 'Sales', slug: 'sales-emea' });
    expect(res.status).toBe(201);
    expect(await readJson(res)).toMatchObject({ name: 'Sales', slug: 'sales-emea', hubTeamId: null });
  });

  it('a taken slug is 409 slug_taken on create AND on rename', async () => {
    await expectError(
      await send('POST', '/teams', actors.owner!, { name: 'Other', slug: 'sales-emea' }),
      409,
      'slug_taken'
    );
    // Derived to the same slug: the same refusal.
    await expectError(
      await send('POST', '/teams', actors.owner!, { name: 'equipe creative' }),
      409,
      'slug_taken'
    );
    const { id } = await createTeam(actors.owner!, 'Renamable');
    await expectError(
      await send('PATCH', `/teams/${id}`, actors.owner!, { slug: 'sales-emea' }),
      409,
      'slug_taken'
    );
  });

  it('a name of symbols is 400, and so are a bad slug and an empty patch', async () => {
    await expectError(
      await send('POST', '/teams', actors.owner!, { name: '!!! ???' }),
      400,
      'validation_error'
    );
    await expectError(
      await send('POST', '/teams', actors.owner!, { name: 'Fine', slug: 'Not A Slug' }),
      400,
      'validation_error'
    );
    const { id } = await createTeam(actors.owner!, 'Patchable');
    await expectError(await send('PATCH', `/teams/${id}`, actors.owner!, {}), 400, 'validation_error');
  });

  it('renames by name only, then by slug only', async () => {
    const { id } = await createTeam(actors.owner!, 'Ops');
    const byName = await send('PATCH', `/teams/${id}`, actors.admin!, { name: 'Operations' });
    expect(byName.status).toBe(200);
    expect(await readJson(byName)).toMatchObject({ id, name: 'Operations', slug: 'ops' });
    const bySlug = await send('PATCH', `/teams/${id}`, actors.owner!, { slug: 'operations' });
    expect(bySlug.status).toBe(200);
    expect(await readJson(bySlug)).toMatchObject({ id, name: 'Operations', slug: 'operations' });
  });

  it('a non-uuid id is a clean 400', async () => {
    await expectError(await send('GET', '/teams/not-a-uuid', actors.owner!), 400, 'validation_error');
    await expectError(
      await send('DELETE', '/teams/not-a-uuid/members/x', actors.owner!),
      400,
      'validation_error'
    );
  });
});

describe('who reads and who writes', () => {
  let teamId = '';

  beforeAll(async () => {
    teamId = (await createTeam(actors.owner!, 'Readers')).id;
    expect(
      (await send('POST', `/teams/${teamId}/members`, actors.owner!, { userId: actors.alice!.userId })).status
    ).toBe(201);
  });

  it('a plain member reads the list, one team and its members', async () => {
    const m = actors.member!;
    const list = await send('GET', '/teams?limit=100', m);
    expect(list.status).toBe(200);
    expect((await readJson(list)).teams.map((t: { id: string }) => t.id)).toContain(teamId);
    const one = await send('GET', `/teams/${teamId}`, m);
    expect(one.status).toBe(200);
    expect(await readJson(one)).toMatchObject({ id: teamId, membersCount: 1, isMember: false });
    const members = await send('GET', `/teams/${teamId}/members`, m);
    expect(members.status).toBe(200);
    expect((await readJson(members)).members).toEqual([
      expect.objectContaining({
        userId: actors.alice!.userId,
        email: 'alice@teams.test',
        role: 'member',
        isActive: true
      })
    ]);
  });

  it('a plain member is refused every write (403 forbidden)', async () => {
    const m = actors.member!;
    await expectError(await send('POST', '/teams', m, { name: 'Mine' }), 403, 'forbidden');
    await expectError(await send('PATCH', `/teams/${teamId}`, m, { name: 'x' }), 403, 'forbidden');
    await expectError(await send('DELETE', `/teams/${teamId}`, m), 403, 'forbidden');
    await expectError(
      await send('POST', `/teams/${teamId}/members`, m, { userId: m.userId }),
      403,
      'forbidden'
    );
    await expectError(
      await send('DELETE', `/teams/${teamId}/members/${actors.alice!.userId}`, m),
      403,
      'forbidden'
    );
  });

  it('a guest is refused the whole subtree (403 guest_forbidden); an anonymous caller is 401', async () => {
    const g = actors.guest!;
    await expectError(await send('GET', '/teams', g), 403, 'guest_forbidden');
    await expectError(await send('GET', `/teams/${teamId}`, g), 403, 'guest_forbidden');
    await expectError(await send('GET', `/teams/${teamId}/members`, g), 403, 'guest_forbidden');
    await expectError(await send('POST', '/teams', g, { name: 'x' }), 403, 'guest_forbidden');
    await expectError(await send('GET', '/teams', {}), 401, 'unauthenticated');
    await expectError(await send('GET', `/teams/${teamId}`, {}), 401, 'unauthenticated');
  });

  it('a team of another workspace is 404 from this one, for its own owner too', async () => {
    const there = { 'x-workspace-id': otherWorkspaceId };
    const created = await send('POST', '/teams', actors.owner!, { name: 'Elsewhere team' }, there);
    expect(created.status).toBe(201);
    const { id } = await readJson(created);
    const o = actors.owner!;
    await expectError(await send('GET', `/teams/${id}`, o), 404, 'not_found');
    await expectError(await send('GET', `/teams/${id}/members`, o), 404, 'not_found');
    await expectError(await send('PATCH', `/teams/${id}`, o, { name: 'x' }), 404, 'not_found');
    await expectError(await send('DELETE', `/teams/${id}`, o), 404, 'not_found');
    await expectError(await send('POST', `/teams/${id}/members`, o, { userId: o.userId }), 404, 'not_found');
    const list = (await readJson(await send('GET', '/teams?limit=100', o))).teams.map(
      (t: { id: string }) => t.id
    );
    expect(list).not.toContain(id);
    expect((await send('GET', `/teams/${id}`, o, undefined, there)).status).toBe(200);
  });
});

describe('seats: the workspace’s own active non-guest members', () => {
  let teamId = '';

  beforeAll(async () => {
    teamId = (await createTeam(actors.owner!, 'Seating')).id;
  });

  it('seats by email and by user id; a repeat is 409 already_member', async () => {
    const path = `/teams/${teamId}/members`;
    const byEmail = await send('POST', path, actors.owner!, { email: 'BOB@teams.test' });
    expect(byEmail.status).toBe(201);
    const body = await readJson(byEmail);
    expect(body).toMatchObject({
      userId: actors.bob!.userId,
      email: 'bob@teams.test',
      role: 'member',
      isActive: true
    });
    expect(typeof body.addedAt).toBe('string');
    const byId = await send('POST', path, actors.admin!, { userId: actors.owner!.userId });
    expect(byId.status).toBe(201);
    expect(await readJson(byId)).toMatchObject({ userId: actors.owner!.userId, role: 'owner' });
    await expectError(
      await send('POST', path, actors.owner!, { userId: actors.bob!.userId }),
      409,
      'already_member'
    );
    const [seat] = await app.db.db
      .select()
      .from(workspaceTeamMembers)
      .where(
        and(eq(workspaceTeamMembers.teamId, teamId), eq(workspaceTeamMembers.memberId, actors.bob!.memberId))
      );
    expect(seat).toMatchObject({ addedBy: actors.owner!.userId });
  });

  it('refuses a stranger and a deactivated member (404), a guest (403 guest_target), and a bad body (400)', async () => {
    const path = `/teams/${teamId}/members`;
    const o = actors.owner!;
    await expectError(await send('POST', path, o, { email: 'nobody@teams.test' }), 404, 'member_not_found');
    await app.db.db
      .update(workspaceMembers)
      .set({ isActive: false })
      .where(eq(workspaceMembers.id, actors.sleeper!.memberId));
    await expectError(
      await send('POST', path, o, { userId: actors.sleeper!.userId }),
      404,
      'member_not_found'
    );
    await expectError(await send('POST', path, o, { userId: actors.guest!.userId }), 403, 'guest_target');
    await expectError(await send('POST', path, o, {}), 400, 'validation_error');
    await expectError(
      await send('POST', path, o, { userId: actors.bob!.userId, email: 'bob@teams.test' }),
      400,
      'validation_error'
    );
  });

  it('isMember is true for a seated caller, and membersCount counts', async () => {
    const asOwner = await readJson(await send('GET', `/teams/${teamId}`, actors.owner!));
    expect(asOwner).toMatchObject({ membersCount: 2, isMember: true });
    const asBob = await readJson(await send('GET', `/teams/${teamId}`, actors.bob!));
    expect(asBob).toMatchObject({ membersCount: 2, isMember: true });
    const asCarol = await readJson(await send('GET', `/teams/${teamId}`, actors.carol!));
    expect(asCarol).toMatchObject({ membersCount: 2, isMember: false });
    const listed = (await readJson(await send('GET', '/teams?limit=100', actors.bob!))).teams.find(
      (t: { id: string }) => t.id === teamId
    );
    expect(listed).toMatchObject({ membersCount: 2, isMember: true });
  });

  it('unseats (200 with the member), then 404 member_not_found', async () => {
    const path = `/teams/${teamId}/members/${actors.bob!.userId}`;
    const res = await send('DELETE', path, actors.admin!);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ userId: actors.bob!.userId, email: 'bob@teams.test' });
    await expectError(await send('DELETE', path, actors.admin!), 404, 'member_not_found');
    expect((await readJson(await send('GET', `/teams/${teamId}`, actors.bob!))).isMember).toBe(false);
  });

  it('the members list pages on a cursor that survives the removal of the row it names', async () => {
    const { id: paged } = await createTeam(actors.owner!, 'Paged');
    for (const name of ['alice', 'bob', 'carol', 'dave', 'member'] as const) {
      const res = await send('POST', `/teams/${paged}/members`, actors.owner!, {
        userId: actors[name]!.userId
      });
      expect(res.status).toBe(201);
    }
    const first = await readJson(await send('GET', `/teams/${paged}/members?limit=2`, actors.member!));
    expect(first.members).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // The row the cursor names is removed before the next page is asked for.
    const lastOnPage = first.members[1].userId;
    expect((await send('DELETE', `/teams/${paged}/members/${lastOnPage}`, actors.owner!)).status).toBe(200);
    const second = await readJson(
      await send('GET', `/teams/${paged}/members?limit=2&cursor=${first.nextCursor}`, actors.member!)
    );
    expect(second.members).toHaveLength(2);
    const third = await readJson(
      await send('GET', `/teams/${paged}/members?limit=2&cursor=${second.nextCursor}`, actors.member!)
    );
    expect(third.members).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const seen = [...first.members, ...second.members, ...third.members].map(
      (m: { userId: string }) => m.userId
    );
    expect(new Set(seen).size).toBe(5);
    // A cursor that is not one of ours reads as no cursor, never as a 500.
    const res = await send('GET', `/teams/${paged}/members?limit=10&cursor=garbage`, actors.member!);
    expect(res.status).toBe(200);
    expect((await readJson(res)).members).toHaveLength(4);
  });
});

describe('the cascades', () => {
  it('deleting a team deletes its seats, and the team is 404 after', async () => {
    const { id } = await createTeam(actors.owner!, 'Doomed');
    for (const name of ['alice', 'carol']) {
      expect(
        (await send('POST', `/teams/${id}/members`, actors.owner!, { userId: actors[name]!.userId })).status
      ).toBe(201);
    }
    expect(await seatsOfTeam(id)).toHaveLength(2);
    const res = await send('DELETE', `/teams/${id}`, actors.admin!);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id, slug: 'doomed', membersCount: 2 });
    expect(await seatsOfTeam(id)).toHaveLength(0);
    await expectError(await send('GET', `/teams/${id}`, actors.owner!), 404, 'not_found');
    await expectError(await send('DELETE', `/teams/${id}`, actors.owner!), 404, 'not_found');
  });

  it('deleting a member’s account removes their seats', async () => {
    const { id } = await createTeam(actors.owner!, 'Erasure');
    const erased = actors.erased!;
    expect(
      (await send('POST', `/teams/${id}/members`, actors.owner!, { userId: erased.userId })).status
    ).toBe(201);
    expect(await seatsOfMember(erased.memberId)).toHaveLength(1);
    const res = await send('DELETE', `/members/${erased.memberId}`, actors.owner!);
    expect(res.status).toBe(200);
    expect(await seatsOfMember(erased.memberId)).toHaveLength(0);
    expect((await readJson(await send('GET', `/teams/${id}`, actors.owner!))).membersCount).toBe(0);
  });

  it('deactivating a member KEEPS the seat row', async () => {
    const { id } = await createTeam(actors.owner!, 'Pause');
    const paused = actors.paused!;
    expect(
      (await send('POST', `/teams/${id}/members`, actors.owner!, { userId: paused.userId })).status
    ).toBe(201);
    const res = await send('PATCH', `/members/${paused.memberId}`, actors.owner!, { isActive: false });
    expect(res.status).toBe(200);
    expect(await seatsOfMember(paused.memberId)).toHaveLength(1);
    const members = (await readJson(await send('GET', `/teams/${id}/members`, actors.owner!))).members;
    expect(members).toEqual([expect.objectContaining({ userId: paused.userId, isActive: false })]);
  });
});

describe('the team list’s cursor', () => {
  it('survives the deletion of the team it names: none skipped, none repeated (verifier round 1, F3)', async () => {
    // A workspace of its own, so the count is exactly the four made here
    // (and the audit read below stays on the first workspace's own rows).
    const pagingId = (await app.registry.workspaces.create('Paging', actors.owner!.userId)).workspaceId;
    const there = { 'x-workspace-id': pagingId };
    const o = actors.owner!;
    const made: string[] = [];
    for (const name of ['Page one', 'Page two', 'Page three', 'Page four']) {
      const res = await send('POST', '/teams', o, { name }, there);
      expect(res.status).toBe(201);
      made.push((await readJson(res)).id as string);
    }

    const first = await readJson(await send('GET', '/teams?limit=1', o, undefined, there));
    expect(first.teams).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const cursorTeam = first.teams[0].id as string;
    // Newest first: the page names the last one made.
    expect(cursorTeam).toBe(made[3]);
    expect((await send('DELETE', `/teams/${cursorTeam}`, o, undefined, there)).status).toBe(200);

    const seen: string[] = [];
    let cursor: string | null = first.nextCursor;
    for (let i = 0; cursor !== null && i < 10; i++) {
      const page = await readJson(await send('GET', `/teams?limit=1&cursor=${cursor}`, o, undefined, there));
      if (i === 0) expect(page.teams.map((t: { id: string }) => t.id)).toEqual([made[2]]);
      seen.push(...page.teams.map((t: { id: string }) => t.id));
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual([made[2], made[1], made[0]]);
  });
});

describe('machine principals', () => {
  it('the read scope reads the list and cannot create', async () => {
    const readKey = await mintKey(actors.owner!.cookie, [host.scopes.read]);
    expect((await send('GET', '/teams', { key: readKey })).status).toBe(200);
    // The route is allowlisted under the write scope, so the gate's answer is
    // the missing scope (`endpoint_not_allowed` is for unlisted shapes, below).
    await expectError(
      await send('POST', '/teams', { key: readKey }, { name: 'By a read key' }),
      403,
      'insufficient_scope'
    );
  });

  it('the write scope (its holder an owner) creates and seats, and cannot read the list', async () => {
    const writeKey = await mintKey(actors.owner!.cookie, [host.scopes.write]);
    const { id } = await createTeam({ key: writeKey }, 'By a key');
    const seated = await send(
      'POST',
      `/teams/${id}/members`,
      { key: writeKey },
      { userId: actors.dave!.userId }
    );
    expect(seated.status).toBe(201);
    await expectError(await send('GET', '/teams', { key: writeKey }), 403, 'insufficient_scope');
  });

  it('a plain member’s write key is 403 forbidden', async () => {
    const memberKey = await mintKey(actors.member!.cookie, [host.scopes.read, host.scopes.write]);
    await expectError(await send('POST', '/teams', { key: memberKey }, { name: 'Nope' }), 403, 'forbidden');
  });

  it('a shape that is not one of the eight routes stays closed to a key', async () => {
    const both = await mintKey(actors.owner!.cookie, [host.scopes.read, host.scopes.write]);
    const { id } = await createTeam({ key: both }, 'Closed shapes');
    const code = 'endpoint_not_allowed';
    await expectError(await send('PUT', `/teams/${id}`, { key: both }, {}), 403, code);
    await expectError(await send('DELETE', '/teams', { key: both }), 403, code);
    await expectError(await send('GET', `/teams/${id}/members/x`, { key: both }), 403, code);
    await expectError(await send('GET', `/teams/${id}/anything`, { key: both }), 403, code);
  });
});

describe('the record', () => {
  it('every mutation wrote its audit action, readable at /audit by the owner', async () => {
    for (const action of [
      'team.create',
      'team.update',
      'team.delete',
      'team.member_add',
      'team.member_remove'
    ]) {
      const res = await send('GET', `/audit?action=${action}&limit=5`, actors.owner!);
      expect(res.status).toBe(200);
      const entries = (await readJson(res)).entries as Array<{ action: string; resourceType: string }>;
      expect(entries.length, action).toBeGreaterThan(0);
      expect(entries[0]).toMatchObject({ action, resourceType: 'team' });
    }
    const added = (
      await readJson(await send('GET', '/audit?action=team.member_add&limit=100', actors.owner!))
    ).entries as Array<{ metadata: { targetUserId?: string } }>;
    expect(added.map((e) => e.metadata.targetUserId)).toContain(actors.bob!.userId);
    const deleted = (await readJson(await send('GET', '/audit?action=team.delete&limit=5', actors.owner!)))
      .entries as Array<{ metadata: Record<string, unknown> }>;
    expect(deleted[0]!.metadata).toMatchObject({ slug: 'doomed', name: 'Doomed', membersCount: 2 });
  });
});
