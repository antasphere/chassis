import pg from 'pg';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { user as userTable, workspaceMembers, workspaces, type Db } from '@antasphere/chassis-db';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import type { ErasureLog } from './erasure-log.js';

/**
 * Account deletion (GDPR erasure), shared by both delete surfaces: the
 * self-service Better Auth `/delete-user` route (via the boot-wired
 * before/after hooks) and the admin `DELETE /members/{id}` endpoint.
 *
 * Deliberately NO storage dependency: files are WORKSPACE data, not the
 * uploader's personal data — they survive the delete with `created_by`
 * nulled by the FK (migration 0008, ADR 006). Blobs are never touched here.
 *
 * Multi-workspace (ADR 014): a user owning N workspaces has N last-owner
 * obligations — the guard runs for EVERY workspace where they are an
 * active owner, with the per-workspace locks acquired in deterministic
 * order (sorted workspace id) so two concurrent deletes of co-owners can
 * never deadlock. The completion audit row lands in every workspace the
 * user belonged to.
 *
 * Projection exemption (D11, slideless-cloud-binding-plan): the guard
 * applies ONLY to workspaces this instance owns (centralAccountId IS
 * NULL). A projected (hub-origin) workspace asserts ownership hub-side —
 * its local membership rows are a re-syncable projection, so a
 * zero-local-owner state is legal there and the guard (app layer AND the
 * 0009 trigger, migration 0019) stands aside. Structured now, inert until
 * the cloud edition creates the first projection (Phase 3).
 *
 * Last-owner race hardening (ADR 006, M9): a zero-active-owner workspace is
 * unrecoverable (setup is one-shot), so the guard is enforced in two layers:
 *
 *  1. A `BEFORE DELETE OR UPDATE` trigger on workspace_members (migration
 *     0009) raises SQLSTATE {@link LAST_OWNER_SQLSTATE} whenever an operation
 *     would drop the workspace's ACTIVE owners to zero — serialized inside
 *     the trigger by a per-workspace `pg_advisory_xact_lock`, so it holds
 *     under ANY concurrency and on any code path. This is the guarantee.
 *  2. A per-workspace session-scoped advisory lock (dedicated `pg.Client`,
 *     mirroring the migration-lock pattern) serializes the HTTP surfaces
 *     around their guard re-check, so the LOSER of a race is rejected at the
 *     guard with a clean `LastOwnerError` (→ 400) instead of tripping the
 *     trigger mid-cascade (→ 500).
 */

/** Deleting this account would leave the workspace without an active owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('The workspace must keep at least one active owner');
    this.name = 'LastOwnerError';
  }
}

/** SQLSTATE raised by the workspace_members last-owner trigger (migration 0009). */
export const LAST_OWNER_SQLSTATE = 'P0409';

/**
 * True when `cause` (or anything on its `cause` chain — drizzle wraps pg's
 * DatabaseError) is the last-owner trigger rejection.
 */
export function isLastOwnerDbError(cause: unknown): boolean {
  for (let err: unknown = cause; err instanceof Error; err = (err as { cause?: unknown }).cause) {
    if ((err as { code?: unknown }).code === LAST_OWNER_SQLSTATE) return true;
  }
  return false;
}

/**
 * Advisory-lock namespace for serializing owner-removing operations
 * (two-int form: classid 7432003, objid = hashtext(workspace id)). Distinct
 * from the migration lock (7432001) and the trigger's own xact lock
 * (7432002) — the session lock is held ACROSS the cascade while the trigger
 * lock is taken INSIDE it, so sharing a key would self-deadlock.
 */
const OWNER_GUARD_LOCK_KEY = 7_432_003;

/**
 * The self-service path parks the lock between Better Auth's before/after
 * hooks; if the cascade dies in between, afterDelete never runs. The
 * watchdog then cuts the dedicated connection (a session lock dies with its
 * session), so a leaked lock can stall owner removals for at most this long.
 */
const LOCK_WATCHDOG_MS = 60_000;

interface OwnerLock {
  client: pg.Client;
  workspaceId: string;
  released: boolean;
  watchdog?: NodeJS.Timeout;
}

/** True when the workspace keeps ≥1 ACTIVE owner besides excludeUserId. */
export async function hasOtherActiveOwner(
  db: Db,
  workspaceId: string,
  excludeUserId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        eq(workspaceMembers.isActive, true),
        ne(workspaceMembers.userId, excludeUserId)
      )
    )
    .limit(1);
  return Boolean(row);
}

export class AccountDeletionService {
  /**
   * before/after stash: beforeUserDelete runs with the user row still
   * present (memberships + email are readable); afterUserDelete runs after
   * the FK cascade, when neither is — so the system-actor audit rows pop
   * their context from here. In-process by design: both hooks run in the
   * same request on the same replica.
   */
  private readonly stash = new Map<string, { workspaceIds: string[]; email: string }>();

  /** Locks parked across Better Auth's cascade (beforeUserDelete → afterUserDelete). */
  private readonly heldLocks = new Map<string, OwnerLock[]>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    /** Dedicated advisory-lock connections (mirrors packages/chassis-db migrate.ts). */
    private readonly connectionString: string,
    /** The append-only erasure tombstone (OPS-3): every completed erasure lands a line. */
    private readonly erasureLog?: ErasureLog
  ) {}

  /**
   * Throws LastOwnerError when the user is the last ACTIVE owner of ANY of
   * their non-projected workspaces (ADR 014: N owned workspaces = N
   * obligations; projected ones are exempt, D11). Unlocked fast-path check —
   * the race-free enforcement is withLastOwnerGuard + the 0009/0019 trigger.
   */
  async assertDeletable(userId: string): Promise<void> {
    for (const workspaceId of await this.ownedGuardedWorkspaceIds(userId)) {
      if (!(await hasOtherActiveOwner(this.db, workspaceId, userId))) {
        throw new LastOwnerError();
      }
    }
  }

  /**
   * Serialize an owner-removing operation and enforce the last-owner rule
   * race-free: the per-workspace advisory lock makes the guard re-check see
   * every previously committed removal (the loser of a race rejects with
   * LastOwnerError → 400), and the migration-0009 trigger — surfaced here as
   * LastOwnerError too — backstops anything that slips past. The lock is
   * released on EVERY path (finally). Projected workspaces skip the guard
   * entirely (D11): ownership is asserted hub-side and the trigger stands
   * aside there too (migration 0019).
   */
  async withLastOwnerGuard<T>(workspaceId: string, excludeUserId: string, op: () => Promise<T>): Promise<T> {
    if (await this.isProjectedWorkspace(workspaceId)) {
      return op();
    }
    const lock = await this.acquireOwnerLock(workspaceId);
    try {
      if (!(await hasOtherActiveOwner(this.db, workspaceId, excludeUserId))) {
        throw new LastOwnerError();
      }
      return await op();
    } catch (cause) {
      if (isLastOwnerDbError(cause)) throw new LastOwnerError();
      throw cause;
    } finally {
      await this.releaseOwnerLock(lock);
    }
  }

  /**
   * Guard + stash. Runs while the user row still exists. For EVERY
   * non-projected workspace where the user is an ACTIVE OWNER the guard
   * re-check runs under that workspace's lock — locks acquired in
   * deterministic order (sorted workspace id) so concurrent deletes never
   * deadlock — and the locks are parked across Better Auth's cascade
   * (released by afterUserDelete, or by the watchdog if the cascade dies in
   * between). Of two concurrent last-owner self-deletes, the loser blocks
   * here until the winner's cascade commits, re-checks, and rejects with a
   * clean LastOwnerError.
   */
  async beforeUserDelete(userId: string): Promise<void> {
    const memberships = await this.membershipsOf(userId);
    if (memberships.length === 0) return; // no workspace to guard or audit against
    const locks = await this.acquireOwnerLocks(userId);
    if (locks.length > 0) this.parkLocks(userId, locks);
    const [u] = await this.db
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    this.stash.set(userId, {
      workspaceIds: memberships.map((m) => m.workspaceId),
      email: u?.email ?? ''
    });
  }

  /**
   * Run an erasure under EVERY last-owner guard the user is subject to, with
   * nothing touched when any guard refuses (PRDCT-1809). The boot-time
   * tombstone replay uses this: Better Auth's cascade deletes the account
   * rows BEFORE the user row, so a delete the 0009 trigger refuses mid-way
   * leaves a half-erased owner (no credential, PII intact, membership
   * intact). The locks are acquired in sorted order (as beforeUserDelete)
   * and released on every path; a refusal surfaces as LastOwnerError before
   * `op` runs, and a trigger refusal inside `op` is mapped to the same.
   */
  async withAllLastOwnerGuards<T>(userId: string, op: () => Promise<T>): Promise<T> {
    const locks = await this.acquireOwnerLocks(userId);
    try {
      return await op();
    } catch (cause) {
      if (isLastOwnerDbError(cause)) throw new LastOwnerError();
      throw cause;
    } finally {
      for (const lock of locks) await this.releaseOwnerLock(lock);
    }
  }

  /**
   * Land the erasure tombstone (OPS-3) for a deletion that did NOT run
   * through Better Auth's deleteUser hooks — the admin DELETE /members/{id}
   * cascade calls the internal adapter directly, so afterUserDelete never
   * fires there. Every GDPR surface must end here or in afterUserDelete.
   */
  async recordErasure(user: { id: string; email: string }): Promise<void> {
    await this.erasureLog?.append(user);
  }

  /** Pop the stash and record the system-actor completion rows (FK-safe: the user is gone). */
  async afterUserDelete(user: { id: string; email: string }): Promise<void> {
    const locks = this.heldLocks.get(user.id);
    if (locks) {
      this.heldLocks.delete(user.id);
      for (const lock of locks) await this.releaseOwnerLock(lock);
    }
    // The tombstone is written for EVERY completed erasure, stashed context
    // or not: the audit rows below are what a restore rolls back; this line
    // is what makes the erasure hold across one (OPS-3).
    await this.erasureLog?.append(user);
    const stashed = this.stash.get(user.id);
    this.stash.delete(user.id);
    if (!stashed) {
      this.logger.warn({ userId: user.id }, 'account delete completed without a stashed context');
      return;
    }
    // One row per workspace the user belonged to: every workspace's audit
    // trail records that its member's account was erased (ADR 014).
    for (const workspaceId of stashed.workspaceIds) {
      await this.audit.write({
        workspaceId,
        principal: null, // → actorVia 'system'
        action: 'user.account_delete',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { deletedUserId: user.id, email: stashed.email || user.email }
      });
    }
  }

  /**
   * Acquire the per-workspace lock and run the guard re-check for EVERY
   * non-projected workspace where the user is an active owner, in sorted
   * order (deterministic → no deadlock between concurrent deletes). On a
   * refusal every lock taken so far is released and LastOwnerError is
   * thrown; on success the caller owns the locks.
   */
  private async acquireOwnerLocks(userId: string): Promise<OwnerLock[]> {
    const locks: OwnerLock[] = [];
    try {
      for (const workspaceId of await this.ownedGuardedWorkspaceIds(userId)) {
        locks.push(await this.acquireOwnerLock(workspaceId));
        if (!(await hasOtherActiveOwner(this.db, workspaceId, userId))) {
          throw new LastOwnerError();
        }
      }
      return locks;
    } catch (cause) {
      for (const lock of locks) await this.releaseOwnerLock(lock);
      throw cause;
    }
  }

  /**
   * Session-scoped pg_advisory_lock on a dedicated client — never the pool:
   * a session lock parked on a pooled connection would poison the pool.
   */
  private async acquireOwnerLock(workspaceId: string): Promise<OwnerLock> {
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    const lock: OwnerLock = { client, workspaceId, released: false };
    try {
      await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [OWNER_GUARD_LOCK_KEY, workspaceId]);
    } catch (cause) {
      await this.releaseOwnerLock(lock);
      throw cause;
    }
    return lock;
  }

  /** Idempotent; closing the client guarantees the session lock dies with it. */
  private async releaseOwnerLock(lock: OwnerLock): Promise<void> {
    if (lock.released) return;
    lock.released = true;
    if (lock.watchdog) clearTimeout(lock.watchdog);
    try {
      await lock.client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        OWNER_GUARD_LOCK_KEY,
        lock.workspaceId
      ]);
    } catch {
      // client.end() below still drops the session-scoped lock
    }
    await lock.client.end().catch(() => {});
  }

  /** Park the locks across the cascade, each watchdogged against a hook-gap leak. */
  private parkLocks(userId: string, locks: OwnerLock[]): void {
    for (const lock of locks) {
      lock.watchdog = setTimeout(() => {
        const held = this.heldLocks.get(userId)?.filter((l) => l !== lock);
        if (held !== undefined) {
          if (held.length === 0) this.heldLocks.delete(userId);
          else this.heldLocks.set(userId, held);
        }
        this.logger.warn(
          { userId, workspaceId: lock.workspaceId },
          'owner-delete lock watchdog fired — a delete died between the hooks; releasing the lock'
        );
        void this.releaseOwnerLock(lock);
      }, LOCK_WATCHDOG_MS);
      lock.watchdog.unref();
    }
    this.heldLocks.set(userId, locks);
  }

  /** Every membership row the user holds, active or not. */
  private async membershipsOf(
    userId: string
  ): Promise<Array<{ workspaceId: string; role: string; isActive: boolean }>> {
    return this.db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
  }

  /**
   * Workspaces where the user is an ACTIVE OWNER and the last-owner guard
   * applies — i.e. NON-PROJECTED ones (centralAccountId IS NULL, D11).
   * Sorted for deterministic lock ordering.
   */
  private async ownedGuardedWorkspaceIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, 'owner'),
          eq(workspaceMembers.isActive, true),
          isNull(workspaces.centralAccountId)
        )
      );
    return rows.map((r) => r.workspaceId).sort();
  }

  /** True when the workspace is a hub projection (ownership asserted hub-side, D11). */
  private async isProjectedWorkspace(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ centralAccountId: workspaces.centralAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return Boolean(row?.centralAccountId);
  }
}
