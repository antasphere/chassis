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
  type TestApp
} from './helpers.js';

/**
 * Last-owner delete race (M9 P0): two concurrent removals of the two last
 * ACTIVE owners must never both succeed — a zero-active-owner workspace is
 * unrecoverable (setup is one-shot). Pinned here across all three surfaces:
 *
 *  - self-service POST /auth/delete-user (the confirmed-live finding: both
 *    parallel no-password deletes returned 200 and bricked the workspace);
 *  - admin DELETE /members/{id};
 *  - PATCH /members/{id} demotion.
 *
 * Contract per race: exactly one winner (200), the loser answers a clean
 * 400 last_owner (never a 500), and ≥1 active owner survives in the DB. The
 * DB trigger (migration 0009) is additionally pinned via raw SQL.
 *
 * Each round rebuilds the 2-owner state: the survivor of round N plus a
 * freshly invited owner enter round N+1.
 */

const OWNER = { email: 'owner@race.test', name: 'Race Owner', password: 'race-owner-password-12' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId: string;
let ipCounter = 0;

/** Fresh XFF per actor so per-IP auth buckets never collide across rounds. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

const json = (body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

interface Actor {
  email: string;
  cookie: string;
  ip: string;
  userId: string;
  memberId: string;
}

async function signIn(email: string, password: string, ip: string): Promise<string> {
  const res = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email, password }, { 'x-forwarded-for': ip })
  );
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function actorOf(email: string, cookie: string, ip: string): Promise<Actor> {
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  const { members } = await readJson(
    await app.app.request('/api/v1/members?limit=100', { headers: { cookie } })
  );
  const memberId = members.find((m: { email: string }) => m.email === email).id as string;
  return { email, cookie, ip, userId: me.user.id as string, memberId };
}

/** Invite → accept → sign in a brand-new OWNER-role member. */
async function addOwner(inviterCookie: string, tag: string): Promise<Actor> {
  const email = `owner-${tag}@race.test`;
  const password = `race-${tag}-password-1234`;
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', {
      ...json({ email, role: 'owner' }),
      headers: { 'content-type': 'application/json', cookie: inviterCookie }
    })
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  const acceptIp = nextIp();
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: `Owner ${tag}`, password }, { 'x-forwarded-for': acceptIp })
  );
  expect(accept.status).toBe(200);
  const ip = nextIp();
  const cookie = await signIn(email, password, ip);
  return actorOf(email, cookie, ip);
}

async function activeOwnerCount(): Promise<number> {
  const rows = await app.db.db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        eq(workspaceMembers.isActive, true)
      )
    );
  return rows.length;
}

/** The two-last-owners invariant assertion shared by every race below. */
async function assertOneWinner(results: Response[]): Promise<void> {
  const statuses = results.map((r) => r.status);
  const winners = statuses.filter((s) => s === 200).length;
  expect(winners).toBe(1);
  for (const res of results) {
    if (res.status === 200) continue;
    // The loser gets a clean 400 (or a 404 when the winner's cascade already
    // removed its target row) — never a 500.
    expect([400, 404]).toContain(res.status);
    const body = await readJson(res);
    expect(JSON.stringify(body)).toMatch(/active owner|not found|Not found/i);
  }
  expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'race'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Race', owner: OWNER })
  );
  const cookie = await signIn(OWNER.email, OWNER.password, nextIp());
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  workspaceId = me.workspace.id;
  // Round state entry point: the setup owner is the initial survivor.
  survivor = await actorOf(OWNER.email, cookie, nextIp());
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

/** Survivor of the previous round; each race re-arms the 2-owner state from it. */
let survivor: Actor;

/** Re-resolve the survivor after a race (whichever of the pair still resolves). */
async function resolveSurvivor(a: Actor, b: Actor): Promise<Actor> {
  const aliveA = (await app.app.request('/api/v1/me', { headers: { cookie: a.cookie } })).status === 200;
  return aliveA ? a : b;
}

describe('self-service delete race (the confirmed-live P0)', () => {
  const selfDelete = (actor: Actor) =>
    app.app.request(
      '/api/v1/auth/delete-user',
      // Deliberately passwordless: the session is fresh (< freshAge), the
      // exact shape the live campaign used.
      json({}, { cookie: actor.cookie, 'x-forwarded-for': actor.ip })
    );

  for (const round of [1, 2, 3]) {
    it(`round ${round}: two parallel last-owner self-deletes leave exactly one owner`, async () => {
      const fresh = await addOwner(survivor.cookie, `self-${round}`);
      expect(await activeOwnerCount()).toBe(2);

      const results = await Promise.all([selfDelete(survivor), selfDelete(fresh)]);
      await assertOneWinner(results);
      expect(await activeOwnerCount()).toBe(1);

      survivor = await resolveSurvivor(survivor, fresh);
    }, 60_000);
  }
});

describe('admin member-delete race (DELETE /members/{id})', () => {
  it('two owners deleting each other concurrently leave exactly one owner', async () => {
    const fresh = await addOwner(survivor.cookie, 'admin');
    const a = await actorOf(survivor.email, survivor.cookie, survivor.ip);
    expect(await activeOwnerCount()).toBe(2);

    const del = (actorCookie: string, targetMemberId: string) =>
      app.app.request(`/api/v1/members/${targetMemberId}`, {
        method: 'DELETE',
        headers: { cookie: actorCookie }
      });
    const results = await Promise.all([del(a.cookie, fresh.memberId), del(fresh.cookie, a.memberId)]);
    await assertOneWinner(results);
    expect(await activeOwnerCount()).toBe(1);

    survivor = await resolveSurvivor(a, fresh);
  }, 60_000);
});

describe('demotion race (PATCH /members/{id})', () => {
  it('two owners demoting each other concurrently keep one active owner', async () => {
    const fresh = await addOwner(survivor.cookie, 'patch');
    const a = await actorOf(survivor.email, survivor.cookie, survivor.ip);
    expect(await activeOwnerCount()).toBe(2);

    const demote = (actorCookie: string, targetMemberId: string) =>
      app.app.request(`/api/v1/members/${targetMemberId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: actorCookie },
        body: JSON.stringify({ role: 'member' })
      });
    const results = await Promise.all([demote(a.cookie, fresh.memberId), demote(fresh.cookie, a.memberId)]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(1);
    for (const res of results) {
      if (res.status === 200) continue;
      // 400 last_owner from the guard; 403 only when the loser's principal
      // resolved after the winning demotion already landed.
      expect([400, 403]).toContain(res.status);
      if (res.status === 400) {
        expect((await readJson(res)).error.code).toBe('last_owner');
      }
    }
    expect(await activeOwnerCount()).toBe(1);

    // The demoted member is re-promotable — re-arm for any later test.
    const alive = await resolveSurvivorByRole(a, fresh);
    survivor = alive;
  }, 60_000);
});

/** After a demotion race the loser still signs in — survivor = the one still an owner. */
async function resolveSurvivorByRole(a: Actor, b: Actor): Promise<Actor> {
  const rows = await app.db.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        eq(workspaceMembers.isActive, true)
      )
    );
  const ownerIds = new Set(rows.map((r) => r.userId));
  return ownerIds.has(a.userId) ? a : b;
}

describe('DB-level backstop (migration 0009 trigger)', () => {
  it('raw SQL cannot drop the workspace to zero active owners', async () => {
    expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
    await expect(
      app.db.pool.query(`DELETE FROM workspace_members WHERE role = 'owner' AND is_active`)
    ).rejects.toMatchObject({ code: 'P0409' });
    // Nothing was deleted — the statement aborted atomically.
    expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
  });

  it('raw SQL cannot deactivate the last active owner', async () => {
    await expect(
      app.db.pool.query(`UPDATE workspace_members SET is_active = false WHERE role = 'owner' AND is_active`)
    ).rejects.toMatchObject({ code: 'P0409' });
    expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
  });
});
