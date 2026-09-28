import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * A removal against a concurrent add (the end-to-end verification, finding 5).
 *
 * An add (a project grant, a team seat, a demo pass) read the membership
 * active outside any transaction, then waited on another lock; a removal
 * committed meanwhile; the add then wrote its right on the now inactive row,
 * and the right came back with the person at their re-invitation. Two changes
 * close it: every add re-reads the membership inside its transaction FOR
 * SHARE (`holdLiveMembership`), and the removal runs `deleteMembershipGrants`
 * a second time after the row is off.
 *
 * Each arm is made deterministic by a dedicated pg client holding a lock, and
 * by waiting until the expected number of backends is blocked on a lock
 * (`waitForWaiters`) rather than on a timer. Whatever the add answers, the end
 * state is the same: nothing of what it added survives the removal, and the
 * re-invitation brings the person back with nothing.
 */

const PASSWORD = 'a-long-demo-pass-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let ownerCookie = '';
let adminCookie = '';

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

const signIn = async (email: string) => {
  const res = await send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
};

async function addMember(
  email: string,
  role: 'admin' | 'member'
): Promise<{ userId: string; memberId: string; cookie: string }> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  const [m] = await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: created.user.id, role, origin: 'local' })
    .returning({ id: workspaceMembers.id });
  return { userId: created.user.id, memberId: m!.id, cookie: await signIn(email) };
}

/** Resolves once at least `n` backends of this database wait on a lock (10 s at most). */
async function waitForWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (rows[0]!.n >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} backends waiting on a lock, saw ${rows[0]!.n}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Resolves once a backend of this database waits on a lock while running a
 * statement that starts with `prefix` (10 s at most): a wait on one named
 * statement, not on whichever lock happens to be queued.
 */
async function waitForStatementWaiting(prefix: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`${prefix}%`]
    );
    if (rows[0]!.n >= 1) return;
    if (Date.now() > deadline) throw new Error(`expected a backend waiting on a lock in "${prefix}…"`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The database's deadlock counter, read after the statistics had time to flush. */
async function deadlockCount(): Promise<number> {
  const { rows } = await app.db.pool.query<{ deadlocks: string }>(
    `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`
  );
  return Number(rows[0]!.deadlocks);
}

/** Resolves with the promise's value once settled, or with `pending` after `ms`. */
const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);

async function withLockClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.db.pool.connect();
  try {
    return await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** The owner re-invites the person, who accepts: the way back a removal leaves open. */
async function reinvite(email: string, cookie: string): Promise<void> {
  const invited = await send('POST', '/invitations', { cookie: ownerCookie }, { email, role: 'member' });
  expect(invited.status).toBe(201);
  const token = ((await readJson(invited)).acceptUrl as string).split('/invite/')[1]!;
  const accept = await send('POST', '/invitations/accept', { cookie }, { token });
  expect(accept.status).toBe(200);
}

const grantRows = async (memberId: string, projectId: string) =>
  (
    await app.db.pool.query(`SELECT role FROM project_members WHERE member_id = $1 AND project_id = $2`, [
      memberId,
      projectId
    ])
  ).rows;

const seatRows = async (memberId: string, teamId: string) =>
  (
    await app.db.pool.query(`SELECT 1 FROM workspace_team_members WHERE member_id = $1 AND team_id = $2`, [
      memberId,
      teamId
    ])
  ).rows;

async function newProject(name: string): Promise<string> {
  const res = await send('POST', '/projects', { cookie: ownerCookie }, { name });
  expect(res.status).toBe(201);
  return (await readJson(res)).id as string;
}

async function expectAddOutcome(res: Response, code: string): Promise<number> {
  if (res.status !== 201) {
    const body = await readJson(res);
    expect({ status: res.status, code: body?.error?.code }).toEqual({ status: 404, code });
  }
  return res.status;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'member_removal_race'), { DEMO_SIGN_IN: 'true' });
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Demo', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER.email);
  adminCookie = (await addMember('admin@example.com', 'admin')).cookie;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a removal against a concurrent add', () => {
  it('a project grant added while the project row is held: the add sees the removal, no grant survives the re-invitation', async () => {
    const x = await addMember('grant-late@example.com', 'member');
    const projectId = await newProject('Race A');

    const addRes = await withLockClient(async (lock) => {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      // The add passes its first read and waits on the project row (`whileLive`).
      const add = send(
        'POST',
        `/projects/${projectId}/members`,
        { cookie: adminCookie },
        {
          userId: x.userId,
          role: 'editor'
        }
      );
      await waitForWaiters(1);
      // The removal does not need the project row: it commits meanwhile.
      const removed = await send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie });
      expect(removed.status).toBe(200);
      await lock.query('COMMIT');
      return add;
    });
    const status = await expectAddOutcome(addRes, 'member_not_found');
    console.log('arm A (project row held): add answered', status);
    expect(await grantRows(x.memberId, projectId)).toEqual([]);

    await reinvite('grant-late@example.com', x.cookie);
    expect(await grantRows(x.memberId, projectId)).toEqual([]);
  });

  it('a project grant that holds the membership before the removal switches it off: the second pass takes it', async () => {
    const x = await addMember('grant-early@example.com', 'member');
    const projectId = await newProject('Race B');

    const [addRes, removed] = await withLockClient(async (lock) => {
      // An uncommitted grant for (X, P) holds the unique slot: the add takes
      // the project and membership rows FOR SHARE, then waits on the slot.
      await lock.query('BEGIN');
      await lock.query(
        `INSERT INTO project_members (project_id, member_id, role, added_by) VALUES ($1, $2, 'viewer', NULL)`,
        [projectId, x.memberId]
      );
      const add = send(
        'POST',
        `/projects/${projectId}/members`,
        { cookie: adminCookie },
        {
          userId: x.userId,
          role: 'editor'
        }
      );
      await waitForWaiters(1);
      // The removal's first pass sees no grant; its update then waits for the
      // add's share lock on the membership row.
      const remove = Promise.resolve(send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie }));
      // Settled by then only when nothing made the removal wait (the red run).
      await settledWithin(remove, 1500);
      await lock.query('ROLLBACK');
      return Promise.all([add, remove]);
    });
    expect(removed.status).toBe(200);
    const status = await expectAddOutcome(addRes, 'member_not_found');
    console.log('arm B (membership held by the add): add answered', status);
    expect(await grantRows(x.memberId, projectId)).toEqual([]);

    await reinvite('grant-early@example.com', x.cookie);
    expect(await grantRows(x.memberId, projectId)).toEqual([]);
  });

  it('a team seat added while the team row is held: the add sees the removal, no seat survives the re-invitation', async () => {
    const x = await addMember('seat@example.com', 'member');
    const team = await send('POST', '/teams', { cookie: ownerCookie }, { name: 'Race team' });
    expect(team.status).toBe(201);
    const teamId = (await readJson(team)).id as string;

    const addRes = await withLockClient(async (lock) => {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM workspace_teams WHERE id = $1 FOR UPDATE', [teamId]);
      const add = send('POST', `/teams/${teamId}/members`, { cookie: adminCookie }, { userId: x.userId });
      await waitForWaiters(1);
      const removed = await send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie });
      expect(removed.status).toBe(200);
      await lock.query('COMMIT');
      return add;
    });
    const status = await expectAddOutcome(addRes, 'member_not_found');
    console.log('arm C (team row held): add answered', status);
    expect(await seatRows(x.memberId, teamId)).toEqual([]);

    await reinvite('seat@example.com', x.cookie);
    expect(await seatRows(x.memberId, teamId)).toEqual([]);
  });

  it('a demo pass minted while the membership row is held: no live pass survives the removal or the re-invitation', async () => {
    const x = await addMember('pass@example.com', 'member');
    const livePasses = async () =>
      (
        await app.db.pool.query(
          `SELECT id FROM demo_passes WHERE user_id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
          [x.userId, workspaceId]
        )
      ).rows;

    const [mintRes, removed] = await withLockClient(async (lock) => {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM workspace_members WHERE id = $1 FOR UPDATE', [x.memberId]);
      // The mint queues first on the membership row (its FOR SHARE), the
      // removal's update second; the lock goes to them in that order.
      const mint = send('POST', '/demo/passes', { cookie: ownerCookie }, { email: 'pass@example.com' });
      await waitForWaiters(1);
      const remove = send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie });
      await waitForWaiters(2);
      await lock.query('COMMIT');
      return Promise.all([mint, remove]);
    });
    expect(removed.status).toBe(200);
    const status = await expectAddOutcome(mintRes, 'no_such_member');
    console.log('arm D (membership row held): mint answered', status);
    expect(await livePasses()).toEqual([]);

    await reinvite('pass@example.com', x.cookie);
    expect(await livePasses()).toEqual([]);
  });

  it('E. a duplicate grant add fired with the removal, 20 rounds: the removal answers 200, the add 409 or 404, never a 500, no deadlock', async () => {
    const x = await addMember('grant-dup@example.com', 'member');
    const projectId = await newProject('Race E');
    const addGrant = () =>
      send(
        'POST',
        `/projects/${projectId}/members`,
        { cookie: adminCookie },
        { userId: x.userId, role: 'editor' }
      );
    // Other backends' pending statistics flush within the idle interval (10 s).
    await new Promise((r) => setTimeout(r, 11_000));
    const deadlocksBefore = await deadlockCount();

    const ROUNDS = 20;
    const adds: number[] = [];
    const removals: number[] = [];
    let grantsLeft = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // The grant exists and the person is active before each round (a 409:
      // a failed removal of the round before left it in place).
      expect([201, 409]).toContain((await addGrant()).status);
      const [add, removal] = await Promise.all([
        addGrant(),
        send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie })
      ]);
      adds.push(add.status);
      removals.push(removal.status);
      grantsLeft += (await grantRows(x.memberId, projectId)).length;
      // An admin's Reactivate, the act of the workspace that brings the person back.
      const back = await send('PATCH', `/members/${x.memberId}`, { cookie: ownerCookie }, { isActive: true });
      expect(back.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 11_000));
    const deadlocksAfter = await deadlockCount();
    const tally = (list: number[]) =>
      Object.entries(
        list.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
      )
        .map(([status, n]) => `${status}=${n}`)
        .join(' ');
    console.log(
      `arm E (${ROUNDS} rounds): add ${tally(adds)}; removal ${tally(removals)}; grants left ${grantsLeft}; deadlocks ${deadlocksBefore} -> ${deadlocksAfter}`
    );
    expect(removals.every((status) => status === 200)).toBe(true);
    expect(adds.every((status) => status === 409 || status === 404)).toBe(true);
    expect(grantsLeft).toBe(0);
    expect(deadlocksAfter).toBe(deadlocksBefore);
  }, 180_000);

  it('G. a duplicate seat add fired with the removal, 20 rounds: the removal answers 200, the add 409 or 404, never a 500, no deadlock', async () => {
    // Arm E's twin on the team seat (verifier round 2, G4): the seat add
    // reads the existing row before it inserts, so a repeat never waits on
    // the removal's uncommitted delete of that seat.
    const x = await addMember('seat-dup@example.com', 'member');
    const team = await send('POST', '/teams', { cookie: ownerCookie }, { name: 'Race G team' });
    expect(team.status).toBe(201);
    const teamId = (await readJson(team)).id as string;
    const addSeat = () =>
      send('POST', `/teams/${teamId}/members`, { cookie: adminCookie }, { userId: x.userId });
    await new Promise((r) => setTimeout(r, 11_000));
    const deadlocksBefore = await deadlockCount();

    const ROUNDS = 20;
    const adds: number[] = [];
    const removals: number[] = [];
    let seatsLeft = 0;
    for (let round = 0; round < ROUNDS; round++) {
      expect([201, 409]).toContain((await addSeat()).status);
      const [add, removal] = await Promise.all([
        addSeat(),
        send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie })
      ]);
      adds.push(add.status);
      removals.push(removal.status);
      seatsLeft += (await seatRows(x.memberId, teamId)).length;
      const back = await send('PATCH', `/members/${x.memberId}`, { cookie: ownerCookie }, { isActive: true });
      expect(back.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 11_000));
    const deadlocksAfter = await deadlockCount();
    const tally = (list: number[]) =>
      Object.entries(
        list.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
      )
        .map(([status, n]) => `${status}=${n}`)
        .join(' ');
    console.log(
      `arm G (${ROUNDS} rounds): add ${tally(adds)}; removal ${tally(removals)}; seats left ${seatsLeft}; deadlocks ${deadlocksBefore} -> ${deadlocksAfter}`
    );
    expect(removals.every((status) => status === 200)).toBe(true);
    expect(adds.every((status) => status === 409 || status === 404)).toBe(true);
    expect(seatsLeft).toBe(0);
    expect(deadlocksAfter).toBe(deadlocksBefore);
  }, 180_000);

  it('F. a project the person creates while the removal sits between its update and its commit: no grant of theirs survives', async () => {
    const x = await addMember('creator@example.com', 'member');
    const outcome = await withLockClient(async (holdRow) => {
      const holdInvitation = await app.db.pool.connect();
      try {
        // The removal's first pass runs; its update then waits on the held row.
        await holdRow.query('BEGIN');
        await holdRow.query('SELECT 1 FROM workspace_members WHERE id = $1 FOR SHARE', [x.memberId]);
        const remove = send('POST', `/members/${x.memberId}/remove`, { cookie: ownerCookie });
        await waitForStatementWaiting('update "workspace_members"');
        // An invitation the person issued, made after the first pass and held,
        // parks the removal's SECOND pass after its grant delete, before its commit.
        const invited = await send(
          'POST',
          '/invitations',
          { cookie: adminCookie },
          { email: 'someone-creator-asked@example.com', role: 'member' }
        );
        expect(invited.status).toBe(201);
        const invitationId = (await readJson(invited)).invitation.id as string;
        await app.db.pool.query(`UPDATE invitations SET invited_by = $1 WHERE id = $2`, [
          x.userId,
          invitationId
        ]);
        await holdInvitation.query('BEGIN');
        await holdInvitation.query('SELECT 1 FROM invitations WHERE id = $1 FOR UPDATE', [invitationId]);
        await holdRow.query('COMMIT');
        await waitForStatementWaiting('update "invitations"');
        // The person creates a project now: the creator's read of their own
        // membership waits on the removal's uncommitted update.
        const create = Promise.resolve(
          send('POST', '/projects', { cookie: x.cookie }, { name: 'Made during the removal' })
        );
        const early = await settledWithin(create, 1500);
        console.log(
          'arm F: create settled before the removal committed?',
          early === 'pending' ? 'no (waiting)' : `yes, ${early.status}`
        );
        await holdInvitation.query('ROLLBACK');
        const [createRes, removeRes] = await Promise.all([create, remove]);
        return { create: createRes.status, remove: removeRes.status };
      } finally {
        await holdInvitation.query('ROLLBACK').catch(() => undefined);
        holdInvitation.release();
      }
    });
    console.log('arm F outcome', JSON.stringify(outcome));
    expect(outcome.remove).toBe(200);
    expect([401, 404, 201]).toContain(outcome.create);
    const { rows } = await app.db.pool.query(`SELECT project_id FROM project_members WHERE member_id = $1`, [
      x.memberId
    ]);
    expect(rows).toEqual([]);
  });
});
