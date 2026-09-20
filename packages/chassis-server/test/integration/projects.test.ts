import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, projectMembers, projects, workspaceMembers } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import { projectGrantPredicate, projectRole } from '@antasphere/chassis-server/projects';
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
 * Projects: a subgroup of a workspace with members and three roles. This
 * suite pins every tier of every route for every kind of caller:
 *
 *   owner, admin     → act as a manager on every project (the operator view)
 *   manager, editor, viewer → the three project roles
 *   outsider         → a plain workspace member with no grant: 404 everywhere
 *   guest            → 403 `guest_forbidden` on the whole subtree, and the
 *                      predicate refuses a guest even with a row forced in
 *   API keys         → the read scope reads, the write scope writes, an
 *                      unlisted shape stays closed
 *
 * and the rules that hold between the routes: 404 before 403 before 409, an
 * archived project is read-only, a grant dies with the workspace membership
 * it rides on, a project is never deleted.
 */
const PASSWORD = 'a-long-projects-password-1';
const OWNER = { email: 'owner@projects.test', name: 'Olive Owner', password: PASSWORD };

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let otherWorkspaceId = '';
const actors: Record<string, Actor> = {};
/** The project every tier test reads: created by `manager`, with `editor` and `viewer` on it. */
let projectId = '';

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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
  const email = `${name}@projects.test`;
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

async function createProject(who: Actor, name: string): Promise<string> {
  const res = await send('POST', '/projects', who, { name });
  expect(res.status).toBe(201);
  return (await readJson(res)).id;
}

const principalOf = (actor: Actor, over: Partial<Principal> = {}): Principal => ({
  userId: actor.userId,
  email: actor.email,
  name: 'x',
  workspaceId,
  role: 'member',
  origin: 'local',
  via: 'session',
  scopes: null,
  ...over
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'projects'));
  const setup = await send(
    'POST',
    '/setup',
    {},
    {
      setupToken: 'integration-test-setup-token',
      instanceName: 'Projects',
      owner: OWNER
    }
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
  for (const name of ['manager', 'editor', 'viewer', 'outsider', 'leaver', 'erased', 'sleeper']) {
    await addActor(name);
  }
  await addActor('guest', { origin: 'guest' });

  projectId = await createProject(actors.manager!, 'Spring campaign');
  for (const [name, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer']
  ] as const) {
    const res = await send('POST', `/projects/${projectId}/members`, actors.manager!, {
      userId: actors[name]!.userId,
      role
    });
    expect(res.status).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('creating a project', () => {
  it('any non-guest member creates one and becomes its first manager, in one transaction', async () => {
    const res = await send('POST', '/projects', actors.outsider!, {
      name: 'Outsider’s own',
      description: 'A project of my own',
      metadata: { client: 'acme' }
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body).toMatchObject({
      name: 'Outsider’s own',
      description: 'A project of my own',
      metadata: { client: 'acme' },
      archivedAt: null,
      createdBy: actors.outsider!.userId,
      myRole: 'manager',
      memberCount: 1
    });
    const rows = await app.db.db.select().from(projectMembers).where(eq(projectMembers.projectId, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: actors.outsider!.memberId, role: 'manager' });
  });

  it('refuses a guest, flat (403 guest_forbidden), on every route of the subtree', async () => {
    const guest = actors.guest!;
    await expectError(await send('POST', '/projects', guest, { name: 'nope' }), 403, 'guest_forbidden');
    await expectError(await send('GET', '/projects', guest), 403, 'guest_forbidden');
    await expectError(await send('GET', `/projects/${projectId}`, guest), 403, 'guest_forbidden');
    await expectError(await send('GET', `/projects/${projectId}/members`, guest), 403, 'guest_forbidden');
    await expectError(await send('POST', `/projects/${projectId}/archive`, guest), 403, 'guest_forbidden');
  });

  it('refuses an anonymous caller (401) and a body without a name (400)', async () => {
    await expectError(await send('GET', '/projects', {}), 401, 'unauthenticated');
    await expectError(await send('POST', '/projects', actors.manager!, {}), 400, 'validation_error');
  });

  it('an Idempotency-Key replays the first create instead of minting a second project', async () => {
    const headers = { 'idempotency-key': 'projects-create-once' };
    const first = await readJson(await send('POST', '/projects', actors.manager!, { name: 'Once' }, headers));
    const second = await readJson(
      await send('POST', '/projects', actors.manager!, { name: 'Once' }, headers)
    );
    expect(second.id).toBe(first.id);
    const rows = await app.db.db.select().from(projects).where(eq(projects.name, 'Once'));
    expect(rows).toHaveLength(1);
  });
});

describe('reading: 404 to whoever holds no grant, the role to whoever does', () => {
  it.each([
    ['owner', 'manager'],
    ['admin', 'manager'],
    ['manager', 'manager'],
    ['editor', 'editor'],
    ['viewer', 'viewer']
  ])('%s reads the project, myRole = %s', async (name, myRole) => {
    const res = await send('GET', `/projects/${projectId}`, actors[name]!);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id: projectId, myRole, memberCount: 3 });
    const members = await send('GET', `/projects/${projectId}/members`, actors[name]!);
    expect(members.status).toBe(200);
    const roles = (await readJson(members)).members.map((m: { email: string; role: string }) => [
      m.email,
      m.role
    ]);
    expect(roles).toEqual([
      ['viewer@projects.test', 'viewer'],
      ['editor@projects.test', 'editor'],
      ['manager@projects.test', 'manager']
    ]);
  });

  it('a plain member with no grant gets 404 on every route, never 403', async () => {
    const o = actors.outsider!;
    const target = actors.viewer!.userId;
    await expectError(await send('GET', `/projects/${projectId}`, o), 404, 'not_found');
    await expectError(await send('GET', `/projects/${projectId}/members`, o), 404, 'not_found');
    await expectError(await send('PATCH', `/projects/${projectId}`, o, { name: 'x' }), 404, 'not_found');
    await expectError(await send('POST', `/projects/${projectId}/archive`, o), 404, 'not_found');
    await expectError(await send('POST', `/projects/${projectId}/unarchive`, o), 404, 'not_found');
    await expectError(
      await send('POST', `/projects/${projectId}/members`, o, { userId: target, role: 'viewer' }),
      404,
      'not_found'
    );
    await expectError(
      await send('PATCH', `/projects/${projectId}/members/${target}`, o, { role: 'editor' }),
      404,
      'not_found'
    );
    await expectError(await send('DELETE', `/projects/${projectId}/members/${target}`, o), 404, 'not_found');
    // Removing THEMSELVES from a project they are not in is the same 404.
    await expectError(
      await send('DELETE', `/projects/${projectId}/members/${o.userId}`, o),
      404,
      'not_found'
    );
    // The same answer as an id that names nothing.
    await expectError(
      await send('GET', '/projects/00000000-0000-4000-8000-000000000000', o),
      404,
      'not_found'
    );
  });

  it('the list is the caller’s projects: a member’s own, every project for an owner or admin', async () => {
    const names = async (name: string) =>
      (await readJson(await send('GET', '/projects?limit=100', actors[name]!))).projects.map(
        (p: { name: string }) => p.name
      );
    expect(await names('viewer')).toEqual(['Spring campaign']);
    expect(await names('outsider')).toEqual(['Outsider’s own']);
    expect(await names('owner')).toEqual(
      expect.arrayContaining(['Spring campaign', 'Outsider’s own', 'Once'])
    );
    expect(await names('admin')).toEqual(await names('owner'));
  });

  it('a project of another workspace is 404 from this one, for its own owner too', async () => {
    const inOther = await send(
      'POST',
      '/projects',
      actors.owner!,
      { name: 'Elsewhere’s' },
      {
        'x-workspace-id': otherWorkspaceId
      }
    );
    expect(inOther.status).toBe(201);
    const { id } = await readJson(inOther);
    await expectError(await send('GET', `/projects/${id}`, actors.owner!), 404, 'not_found');
    const there = await send('GET', `/projects/${id}`, actors.owner!, undefined, {
      'x-workspace-id': otherWorkspaceId
    });
    expect(there.status).toBe(200);
  });

  it('a non-uuid id is a clean 400, never a Postgres cast error', async () => {
    await expectError(await send('GET', '/projects/not-a-uuid', actors.owner!), 400, 'validation_error');
  });
});

describe('changing a project: a manager’s act, 403 to a proven reader below it', () => {
  it.each(['editor', 'viewer'])(
    '%s gets 403 insufficient_project_role on every manager act',
    async (name) => {
      const a = actors[name]!;
      const other = name === 'editor' ? actors.viewer! : actors.editor!;
      const code = 'insufficient_project_role';
      await expectError(await send('PATCH', `/projects/${projectId}`, a, { name: 'x' }), 403, code);
      await expectError(await send('POST', `/projects/${projectId}/archive`, a), 403, code);
      await expectError(await send('POST', `/projects/${projectId}/unarchive`, a), 403, code);
      await expectError(
        await send('POST', `/projects/${projectId}/members`, a, {
          userId: actors.outsider!.userId,
          role: 'viewer'
        }),
        403,
        code
      );
      await expectError(
        await send('PATCH', `/projects/${projectId}/members/${other.userId}`, a, { role: 'manager' }),
        403,
        code
      );
      await expectError(await send('DELETE', `/projects/${projectId}/members/${other.userId}`, a), 403, code);
      // Promoting THEMSELVES is the same refusal.
      await expectError(
        await send('PATCH', `/projects/${projectId}/members/${a.userId}`, a, { role: 'manager' }),
        403,
        code
      );
    }
  );

  it.each(['manager', 'admin', 'owner'])(
    '%s renames it, and the description clears on null',
    async (name) => {
      const res = await send('PATCH', `/projects/${projectId}`, actors[name]!, {
        name: `Spring campaign (${name})`,
        description: 'set'
      });
      expect(res.status).toBe(200);
      expect(await readJson(res)).toMatchObject({ name: `Spring campaign (${name})`, description: 'set' });
      const cleared = await send('PATCH', `/projects/${projectId}`, actors[name]!, {
        name: 'Spring campaign',
        description: null
      });
      expect(await readJson(cleared)).toMatchObject({ name: 'Spring campaign', description: null });
    }
  );

  it('an empty patch and an oversized metadata are 400', async () => {
    await expectError(
      await send('PATCH', `/projects/${projectId}`, actors.manager!, {}),
      400,
      'validation_error'
    );
    await expectError(
      await send('PATCH', `/projects/${projectId}`, actors.manager!, {
        metadata: { big: 'x'.repeat(17_000) }
      }),
      400,
      'validation_error'
    );
  });
});

describe('members: picked among the workspace’s own active non-guest members', () => {
  it('adds by email, refuses a second add (409), a guest (403), a stranger and an inactive member (404)', async () => {
    const m = actors.manager!;
    const path = `/projects/${projectId}/members`;
    const added = await send('POST', path, m, { email: 'LEAVER@projects.test', role: 'viewer' });
    expect(added.status).toBe(201);
    expect(await readJson(added)).toMatchObject({
      userId: actors.leaver!.userId,
      email: 'leaver@projects.test',
      role: 'viewer',
      addedBy: m.userId
    });
    await expectError(
      await send('POST', path, m, { userId: actors.leaver!.userId, role: 'editor' }),
      409,
      'already_member'
    );
    await expectError(
      await send('POST', path, m, { userId: actors.guest!.userId, role: 'viewer' }),
      403,
      'guest_target'
    );
    await expectError(
      await send('POST', path, m, { email: 'nobody@projects.test', role: 'viewer' }),
      404,
      'member_not_found'
    );
    await app.db.db
      .update(workspaceMembers)
      .set({ isActive: false })
      .where(eq(workspaceMembers.id, actors.sleeper!.memberId));
    await expectError(
      await send('POST', path, m, { userId: actors.sleeper!.userId, role: 'viewer' }),
      404,
      'member_not_found'
    );
    // Exactly one of userId and email; a role outside the three is refused.
    await expectError(
      await send('POST', path, m, { userId: 'a', email: 'a@b.test', role: 'viewer' }),
      400,
      'validation_error'
    );
    await expectError(await send('POST', path, m, { role: 'viewer' }), 400, 'validation_error');
    await expectError(
      await send('POST', path, m, { userId: actors.outsider!.userId, role: 'owner' }),
      400,
      'validation_error'
    );
  });

  it('the database itself refuses a role outside the three', async () => {
    await expect(
      app.db.pool.query(
        `INSERT INTO project_members (project_id, member_id, role) VALUES ($1, $2, 'owner')`,
        [projectId, actors.outsider!.memberId]
      )
    ).rejects.toThrow(/project_members_role_check/);
  });

  it('a manager changes a role; a member of the project removes THEMSELVES, whatever their role', async () => {
    const m = actors.manager!;
    const leaver = actors.leaver!;
    const changed = await send('PATCH', `/projects/${projectId}/members/${leaver.userId}`, m, {
      role: 'editor'
    });
    expect(changed.status).toBe(200);
    expect(await readJson(changed)).toMatchObject({ userId: leaver.userId, role: 'editor' });
    expect((await readJson(await send('GET', `/projects/${projectId}`, leaver))).myRole).toBe('editor');
    await expectError(
      await send('PATCH', `/projects/${projectId}/members/${actors.outsider!.userId}`, m, { role: 'editor' }),
      404,
      'member_not_found'
    );

    const left = await send('DELETE', `/projects/${projectId}/members/${leaver.userId}`, leaver);
    expect(left.status).toBe(200);
    // Gone on the very next request.
    await expectError(await send('GET', `/projects/${projectId}`, leaver), 404, 'not_found');
  });

  it('the members list pages on a cursor that survives the removal of the row it names', async () => {
    const paged = await createProject(actors.manager!, 'Paged');
    for (const name of ['editor', 'viewer', 'outsider', 'leaver'] as const) {
      await send('POST', `/projects/${paged}/members`, actors.manager!, {
        userId: actors[name]!.userId,
        role: 'viewer'
      });
    }
    const first = await readJson(await send('GET', `/projects/${paged}/members?limit=2`, actors.manager!));
    expect(first.members).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // The row the cursor names is removed before the next page is asked for.
    const lastOnPage = first.members[1].userId;
    expect((await send('DELETE', `/projects/${paged}/members/${lastOnPage}`, actors.manager!)).status).toBe(
      200
    );
    const second = await readJson(
      await send('GET', `/projects/${paged}/members?limit=2&cursor=${first.nextCursor}`, actors.manager!)
    );
    expect(second.members).toHaveLength(2);
    const third = await readJson(
      await send('GET', `/projects/${paged}/members?limit=2&cursor=${second.nextCursor}`, actors.manager!)
    );
    expect(third.members).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const seen = [...first.members, ...second.members, ...third.members].map(
      (m: { userId: string }) => m.userId
    );
    expect(new Set(seen).size).toBe(5);
    // A cursor that is not one of ours reads as no cursor, never as a 500:
    // plain garbage, a well-formed pair whose halves the casts would refuse,
    // and a huge one.
    const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64url');
    for (const bad of [
      'garbage',
      b64('2026-09-20 20:00:00.5+00|not-a-uuid'),
      b64('99999999-99-99 99:99:99+00|aaaaaaaa-0000-4000-8000-000000000003'),
      b64('1e+14|aaaaaaaa-0000-4000-8000-000000000003'),
      b64('x'.repeat(300))
    ]) {
      const res = await send(
        'GET',
        `/projects/${paged}/members?limit=10&cursor=${encodeURIComponent(bad)}`,
        actors.manager!
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).members).toHaveLength(4);
    }
  });

  it('members added in the same instant are all paged, none skipped, none repeated', async () => {
    const same = await createProject(actors.manager!, 'Same instant');
    // One INSERT statement: every row gets the SAME created_at, to the microsecond.
    await app.db.pool.query(
      `INSERT INTO project_members (project_id, member_id, role)
       SELECT $1, id, 'viewer' FROM workspace_members WHERE id = ANY($2::uuid[])`,
      [same, [actors.editor!, actors.viewer!, actors.outsider!, actors.leaver!].map((a) => a.memberId)]
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const res = await readJson(
        await send(
          'GET',
          `/projects/${same}/members?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          actors.manager!
        )
      );
      seen.push(...res.members.map((m: { userId: string }) => m.userId));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // The manager's own row plus the four: five distinct people, in three pages.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('a manager removes someone else, and there is no last-manager guard', async () => {
    const solo = await createProject(actors.leaver!, 'Solo');
    const gone = await send('DELETE', `/projects/${solo}/members/${actors.leaver!.userId}`, actors.leaver!);
    expect(gone.status).toBe(200);
    // Nobody is left on it, and the workspace's admins still manage it.
    const res = await send('GET', `/projects/${solo}`, actors.admin!);
    expect(await readJson(res)).toMatchObject({ myRole: 'manager', memberCount: 0 });
    const back = await send('POST', `/projects/${solo}/members`, actors.admin!, {
      userId: actors.leaver!.userId,
      role: 'viewer'
    });
    expect(back.status).toBe(201);
    const removed = await send('DELETE', `/projects/${solo}/members/${actors.leaver!.userId}`, actors.admin!);
    expect(removed.status).toBe(200);
  });
});

describe('archive, never delete', () => {
  let archivedId = '';

  it('there is no delete route: 404 for a session, closed for a key', async () => {
    await expectError(await send('DELETE', `/projects/${projectId}`, actors.owner!), 404, 'not_found');
    expect((await app.db.db.select().from(projects).where(eq(projects.id, projectId))).length).toBe(1);
  });

  it('an archived project leaves the default list, stays readable, and refuses every change but unarchive', async () => {
    const m = actors.manager!;
    archivedId = await createProject(m, 'To archive');
    for (const [name, role] of [
      ['editor', 'editor'],
      ['viewer', 'viewer']
    ] as const) {
      await send('POST', `/projects/${archivedId}/members`, m, { userId: actors[name]!.userId, role });
    }
    const res = await send('POST', `/projects/${archivedId}/archive`, m);
    expect(res.status).toBe(200);
    expect((await readJson(res)).archivedAt).not.toBeNull();

    const listed = async (query: string) =>
      (await readJson(await send('GET', `/projects?limit=100${query}`, m))).projects.map(
        (p: { id: string }) => p.id
      );
    expect(await listed('')).not.toContain(archivedId);
    expect(await listed('&archived=false')).not.toContain(archivedId);
    expect(await listed('&archived=true')).toEqual([archivedId]);
    expect(await listed('&archived=all')).toEqual(expect.arrayContaining([archivedId, projectId]));

    // Reads stay, for every role.
    expect((await send('GET', `/projects/${archivedId}`, actors.viewer!)).status).toBe(200);
    expect((await send('GET', `/projects/${archivedId}/members`, actors.viewer!)).status).toBe(200);

    const code = 'project_archived';
    await expectError(await send('PATCH', `/projects/${archivedId}`, m, { name: 'x' }), 409, code);
    await expectError(await send('POST', `/projects/${archivedId}/archive`, m), 409, code);
    await expectError(
      await send('POST', `/projects/${archivedId}/members`, m, {
        userId: actors.outsider!.userId,
        role: 'viewer'
      }),
      409,
      code
    );
    await expectError(
      await send('PATCH', `/projects/${archivedId}/members/${actors.viewer!.userId}`, m, { role: 'editor' }),
      409,
      code
    );
    await expectError(
      await send('DELETE', `/projects/${archivedId}/members/${actors.viewer!.userId}`, m),
      409,
      code
    );
    // Leaving is a change too.
    await expectError(
      await send('DELETE', `/projects/${archivedId}/members/${actors.viewer!.userId}`, actors.viewer!),
      409,
      code
    );
    // The owner is bound by it like anyone.
    await expectError(
      await send('PATCH', `/projects/${archivedId}`, actors.owner!, { name: 'x' }),
      409,
      code
    );
  });

  it('the order is 404, then 403, then 409', async () => {
    await expectError(
      await send('PATCH', `/projects/${archivedId}`, actors.outsider!, { name: 'x' }),
      404,
      'not_found'
    );
    await expectError(
      await send('PATCH', `/projects/${archivedId}`, actors.viewer!, { name: 'x' }),
      403,
      'insufficient_project_role'
    );
  });

  it('a manager unarchives it, and it takes changes again', async () => {
    const m = actors.manager!;
    const res = await send('POST', `/projects/${archivedId}/unarchive`, m);
    expect(res.status).toBe(200);
    expect((await readJson(res)).archivedAt).toBeNull();
    await expectError(
      await send('POST', `/projects/${archivedId}/unarchive`, m),
      409,
      'project_not_archived'
    );
    expect((await send('PATCH', `/projects/${archivedId}`, m, { name: 'Back' })).status).toBe(200);
  });
});

describe('the seam a tool plugs in', () => {
  const holds = async (
    principal: Principal,
    id: string,
    atLeast: 'viewer' | 'editor' | 'manager',
    access: 'read' | 'write'
  ) => {
    const predicate = projectGrantPredicate(principal, sql`${id}::uuid`, { atLeast, access });
    const { rows } = await app.db.db.execute(sql`SELECT ${predicate} AS ok`);
    return (rows[0] as { ok: boolean }).ok;
  };

  it('projectRole answers the effective role, and null for no read', async () => {
    const db = app.db.db;
    expect(await projectRole(db, principalOf(actors.manager!), projectId)).toBe('manager');
    expect(await projectRole(db, principalOf(actors.editor!), projectId)).toBe('editor');
    expect(await projectRole(db, principalOf(actors.viewer!), projectId)).toBe('viewer');
    expect(await projectRole(db, principalOf(actors.outsider!), projectId)).toBeNull();
    expect(await projectRole(db, principalOf(actors.admin!, { role: 'admin' }), projectId)).toBe('manager');
    // The request's workspace is part of the question.
    expect(
      await projectRole(
        db,
        principalOf(actors.owner!, { role: 'owner', workspaceId: otherWorkspaceId }),
        projectId
      )
    ).toBeNull();
    expect(
      await projectRole(db, principalOf(actors.editor!, { workspaceId: otherWorkspaceId }), projectId)
    ).toBeNull();
  });

  it('the ladder: a role holds what it contains and nothing above it', async () => {
    const editor = principalOf(actors.editor!);
    expect(await holds(editor, projectId, 'viewer', 'read')).toBe(true);
    expect(await holds(editor, projectId, 'editor', 'write')).toBe(true);
    expect(await holds(editor, projectId, 'manager', 'read')).toBe(false);
    expect(await holds(principalOf(actors.viewer!), projectId, 'editor', 'write')).toBe(false);
    expect(await holds(principalOf(actors.outsider!), projectId, 'viewer', 'read')).toBe(false);
  });

  it('a WRITE through a grant is off while the project is archived, for the operator too; a READ stays', async () => {
    const id = await createProject(actors.manager!, 'Archived for the seam');
    await send('POST', `/projects/${id}/members`, actors.manager!, {
      userId: actors.editor!.userId,
      role: 'editor'
    });
    const editor = principalOf(actors.editor!);
    const owner = principalOf(actors.owner!, { role: 'owner' });
    expect(await holds(editor, id, 'editor', 'write')).toBe(true);
    expect(await holds(owner, id, 'editor', 'write')).toBe(true);
    expect((await send('POST', `/projects/${id}/archive`, actors.manager!)).status).toBe(200);
    expect(await holds(editor, id, 'editor', 'write')).toBe(false);
    expect(await holds(owner, id, 'editor', 'write')).toBe(false);
    expect(await holds(editor, id, 'viewer', 'read')).toBe(true);
    expect(await holds(owner, id, 'viewer', 'read')).toBe(true);
  });

  it('a guest never holds a grant: refused on the principal AND on the row the grant rides on', async () => {
    const guest = actors.guest!;
    // A row no route would ever write, forced in.
    await app.db.db.insert(projectMembers).values({ projectId, memberId: guest.memberId, role: 'manager' });
    expect(await holds(principalOf(guest, { origin: 'guest' }), projectId, 'viewer', 'read')).toBe(false);
    expect(await projectRole(app.db.db, principalOf(guest, { origin: 'guest' }), projectId)).toBeNull();
    // Even a principal that wrongly says `local`: the membership row says guest.
    expect(await holds(principalOf(guest), projectId, 'viewer', 'read')).toBe(false);
    // A guest who is somehow an admin is still a guest.
    expect(
      await holds(principalOf(guest, { origin: 'guest', role: 'admin' }), projectId, 'viewer', 'read')
    ).toBe(false);
    await app.db.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.memberId, guest.memberId)));
  });

  it('a deactivated membership holds nothing', async () => {
    const sleeper = actors.sleeper!;
    await app.db.db.insert(projectMembers).values({ projectId, memberId: sleeper.memberId, role: 'editor' });
    expect(await holds(principalOf(sleeper), projectId, 'viewer', 'read')).toBe(false);
    await app.db.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.memberId, sleeper.memberId)));
  });
});

describe('a grant dies with the workspace membership it rides on', () => {
  it('a swept membership loses every grant, and a re-invite starts with none', async () => {
    const leaver = actors.leaver!;
    const added = await send('POST', `/projects/${projectId}/members`, actors.manager!, {
      userId: leaver.userId,
      role: 'editor'
    });
    expect(added.status).toBe(201);
    // What the hub reconcile does when it sweeps a membership.
    await app.db.db.delete(workspaceMembers).where(eq(workspaceMembers.id, leaver.memberId));
    const grants = await app.db.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.memberId, leaver.memberId));
    expect(grants).toHaveLength(0);

    await app.db.db.insert(workspaceMembers).values({ workspaceId, userId: leaver.userId, role: 'member' });
    await expectError(await send('GET', `/projects/${projectId}`, leaver), 404, 'not_found');
    expect((await readJson(await send('GET', '/projects', leaver))).projects).toEqual([]);
  });

  it('an admin deleting the member’s account takes the grants with it', async () => {
    const erased = actors.erased!;
    await send('POST', `/projects/${projectId}/members`, actors.manager!, {
      userId: erased.userId,
      role: 'viewer'
    });
    const res = await send('DELETE', `/members/${erased.memberId}`, actors.owner!);
    expect(res.status).toBe(200);
    const grants = await app.db.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.memberId, erased.memberId));
    expect(grants).toHaveLength(0);
    const members = (await readJson(await send('GET', `/projects/${projectId}/members`, actors.manager!)))
      .members;
    expect(members.map((m: { userId: string }) => m.userId)).not.toContain(erased.userId);
  });
});

describe('machine principals: each route consciously opened, and nothing else', () => {
  let readKey = '';
  let writeKey = '';
  let exportKey = '';

  beforeAll(async () => {
    const cookie = actors.manager!.cookie;
    readKey = await mintKey(cookie, [host.scopes.read]);
    writeKey = await mintKey(cookie, [host.scopes.write]);
    exportKey = await mintKey(cookie, [host.scopes.dataExport]);
  });

  it('the read scope reads and does not write', async () => {
    expect((await send('GET', '/projects', { key: readKey })).status).toBe(200);
    expect((await send('GET', `/projects/${projectId}`, { key: readKey })).status).toBe(200);
    expect((await send('GET', `/projects/${projectId}/members`, { key: readKey })).status).toBe(200);
    const code = 'insufficient_scope';
    await expectError(await send('POST', '/projects', { key: readKey }, { name: 'k' }), 403, code);
    await expectError(
      await send('PATCH', `/projects/${projectId}`, { key: readKey }, { name: 'k' }),
      403,
      code
    );
    await expectError(await send('POST', `/projects/${projectId}/archive`, { key: readKey }), 403, code);
    await expectError(await send('POST', `/projects/${projectId}/unarchive`, { key: readKey }), 403, code);
    await expectError(
      await send('POST', `/projects/${projectId}/members`, { key: readKey }, { userId: 'x', role: 'viewer' }),
      403,
      code
    );
    await expectError(
      await send('PATCH', `/projects/${projectId}/members/x`, { key: readKey }, { role: 'viewer' }),
      403,
      code
    );
    await expectError(await send('DELETE', `/projects/${projectId}/members/x`, { key: readKey }), 403, code);
  });

  it('the write scope writes and does not read; a key with neither reaches nothing', async () => {
    const created = await send('POST', '/projects', { key: writeKey }, { name: 'By a key' });
    expect(created.status).toBe(201);
    const { id } = await readJson(created);
    expect(
      (await send('PATCH', `/projects/${id}`, { key: writeKey }, { name: 'By a key, renamed' })).status
    ).toBe(200);
    const added = await send(
      'POST',
      `/projects/${id}/members`,
      { key: writeKey },
      {
        userId: actors.viewer!.userId,
        role: 'viewer'
      }
    );
    expect(added.status).toBe(201);
    expect(
      (
        await send(
          'PATCH',
          `/projects/${id}/members/${actors.viewer!.userId}`,
          { key: writeKey },
          { role: 'editor' }
        )
      ).status
    ).toBe(200);
    expect(
      (await send('DELETE', `/projects/${id}/members/${actors.viewer!.userId}`, { key: writeKey })).status
    ).toBe(200);
    expect((await send('POST', `/projects/${id}/archive`, { key: writeKey })).status).toBe(200);
    expect((await send('POST', `/projects/${id}/unarchive`, { key: writeKey })).status).toBe(200);
    await expectError(await send('GET', '/projects', { key: writeKey }), 403, 'insufficient_scope');
    await expectError(await send('GET', `/projects/${id}`, { key: exportKey }), 403, 'insufficient_scope');
    await expectError(
      await send('POST', '/projects', { key: exportKey }, { name: 'k' }),
      403,
      'insufficient_scope'
    );
  });

  it('a key acts as its user: it reads what they read and nothing more', async () => {
    const outsiderKey = await mintKey(actors.outsider!.cookie, [host.scopes.read, host.scopes.write]);
    await expectError(await send('GET', `/projects/${projectId}`, { key: outsiderKey }), 404, 'not_found');
    await expectError(
      await send('PATCH', `/projects/${projectId}`, { key: outsiderKey }, { name: 'x' }),
      404,
      'not_found'
    );
    const viewerKey = await mintKey(actors.viewer!.cookie, [host.scopes.read, host.scopes.write]);
    await expectError(
      await send('PATCH', `/projects/${projectId}`, { key: viewerKey }, { name: 'x' }),
      403,
      'insufficient_project_role'
    );
  });

  it('a shape that is not one of the ten routes stays closed to a key', async () => {
    const both = await mintKey(actors.manager!.cookie, [host.scopes.read, host.scopes.write]);
    const code = 'endpoint_not_allowed';
    await expectError(await send('DELETE', `/projects/${projectId}`, { key: both }), 403, code);
    await expectError(await send('PUT', `/projects/${projectId}`, { key: both }, {}), 403, code);
    await expectError(await send('DELETE', '/projects', { key: both }), 403, code);
    await expectError(await send('GET', `/projects/${projectId}/archive`, { key: both }), 403, code);
    await expectError(await send('POST', `/projects/${projectId}/members/x`, { key: both }, {}), 403, code);
    await expectError(await send('GET', `/projects/${projectId}/members/x/more`, { key: both }), 403, code);
    await expectError(await send('GET', `/projects/${projectId}/anything`, { key: both }), 403, code);
  });
});

describe('the record: one audit action per change, and the export', () => {
  it('every mutation wrote its audit action', async () => {
    const rows = await app.db.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.action} LIKE 'project.%'`);
    const actions = new Set(rows.map((r) => r.action));
    expect([...actions].sort()).toEqual([
      'project.archive',
      'project.create',
      'project.member_add',
      'project.member_remove',
      'project.member_role',
      'project.unarchive',
      'project.update'
    ]);
  });

  it('the workspace export carries projects.json and project_members.json, archived projects included', async () => {
    const res = await send('GET', '/workspace/export', actors.owner!);
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toEqual(expect.arrayContaining(['projects.json', 'project_members.json']));
    const exported = JSON.parse(zip.readAsText('projects.json')) as Array<{ id: string; name: string }>;
    expect(exported.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Spring campaign', 'Archived for the seam'])
    );
    // This workspace's only: the other workspace's project is not in it.
    expect(exported.map((p) => p.name)).not.toContain('Elsewhere’s');
    const members = JSON.parse(zip.readAsText('project_members.json')) as Array<{
      projectId: string;
      userId: string;
      role: string;
    }>;
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, userId: actors.manager!.userId, role: 'manager' }),
        expect.objectContaining({ projectId, userId: actors.viewer!.userId, role: 'viewer' })
      ])
    );
  });
});
