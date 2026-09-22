import PgBoss from 'pg-boss';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { Db } from '@antasphere/chassis-db';
import type { UsageDownstream, UsageEvent, UsageSink } from '@antasphere/chassis-contract';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { AuditService } from '../audit/service.js';
import { parseSuperadminEmails } from '../accounts/superadmin.js';

/**
 * pg-boss job runtime. Queue creation and worker registration follow
 * SERVICE_ROLE:
 *  - api:    start({ supervise:false, schedule:false, migrate:false }) — can
 *            send jobs, runs no maintenance, needs no DDL rights.
 *  - worker: full start, registers handlers.
 *  - all:    both in one process (single-container default).
 * pg-boss serializes its own SCHEMA install internally, but NOT createQueue —
 * so the whole install section runs under the app's advisory lock (below).
 * First boot must run with role all|worker once.
 */
export const USAGE_QUEUE = 'usage-events';
export const AUDIT_PURGE_QUEUE = 'audit-purge';
export const APIKEY_EXPIRY_QUEUE = 'apikey-expiry-sweep';
export const IDEMPOTENCY_PURGE_QUEUE = 'idempotency-purge';
export const ORPHAN_USER_PURGE_QUEUE = 'orphan-user-purge';

/**
 * A TOOL's own job: its queue, its optional nightly schedule, its handler.
 * The chassis creates the queue (and sets or clears the schedule) INSIDE the
 * install advisory lock, between its own queues, in declaration order, and
 * registers the handler as a poller after the lock is released — exactly
 * where a chassis job of the same kind sits.
 *
 * `schedule.enabled === false` UNSCHEDULES: the queue still exists, so the
 * schedule can be flipped later (the audit-purge pattern). A job with no
 * `schedule` is a queue and a poller only. The handler resolves whatever
 * domain service it needs LAZILY, at run time: the jobs are created before
 * the services that need the storage driver.
 */
export interface JobDeclaration {
  queue: string;
  schedule?: { cron: string; enabled?: boolean };
  handler: () => Promise<void>;
}

/**
 * Advisory-lock key serializing pg-boss's install DDL across replicas.
 *
 * pg-boss wraps its schema migration in its own advisory lock, but
 * `createQueue()` calls `pgboss.create_queue()` (queue-row insert + per-queue
 * partition CREATE TABLE/attach) with NO lock: two or more all|worker
 * replicas booting a fresh database reliably deadlock there (Postgres
 * DeadLockReport; scale drill, I2). Same session-scoped pattern as the
 * migration lock (packages/chassis-db/src/migrate.ts). The key is distinct from the
 * migration lock (7432001) and the last-owner locks (7432002 trigger xact /
 * 7432003 session) — see internal/scale-drill-findings.md.
 */
const PGBOSS_INSTALL_LOCK_KEY = 7_432_004;

/**
 * Run pg-boss's one-time install section (schema + queues + schedules) under
 * a session-scoped pg_advisory_lock on a dedicated client — never the pool
 * (a session lock parked on a pooled connection would poison the pool). Held
 * across boot setup ONLY; steady-state send/work never touches it.
 */
async function withInstallLock(
  connectionString: string,
  logger: Logger,
  fn: () => Promise<void>
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [PGBOSS_INSTALL_LOCK_KEY]);
    logger.info({ scope: 'pgboss' }, 'advisory lock acquired, installing pg-boss schema and queues');
    await fn();
    logger.info({ scope: 'pgboss' }, 'pg-boss install up to date');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [PGBOSS_INSTALL_LOCK_KEY]);
    } finally {
      await client.end();
    }
  }
}

export interface Jobs {
  boss: PgBoss;
  stop: () => Promise<void>;
}

export async function createJobs(
  env: Pick<
    Env,
    | 'DATABASE_URL'
    | 'SERVICE_ROLE'
    | 'AUDIT_RETENTION_DAYS'
    | 'ORPHAN_USER_RETENTION_HOURS'
    | 'SUPERADMIN_EMAILS'
  >,
  db: Db,
  logger: Logger,
  downstreamUsage: UsageDownstream,
  /** Orphan purge deletes through Better Auth's own internalAdapter (FK-safe cascade). */
  auth: Auth,
  /** System-actor audit rows for the orphan purge. */
  audit: AuditService,
  /** The tool's own jobs, installed and polled between the chassis ones. */
  toolJobs: readonly JobDeclaration[] = []
): Promise<Jobs> {
  const isWorker = env.SERVICE_ROLE === 'all' || env.SERVICE_ROLE === 'worker';

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
    // Completed jobs archive after an hour and the archive is dropped after a
    // week — the pgboss tables stay bounded on a busy instance.
    archiveCompletedAfterSeconds: 3600,
    deleteAfterDays: 7,
    ...(isWorker ? {} : { supervise: false, schedule: false, migrate: false })
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));

  const retentionDays = env.AUDIT_RETENTION_DAYS;
  const orphanRetentionHours = env.ORPHAN_USER_RETENTION_HOURS;

  if (isWorker) {
    // The install section — pg-boss schema (start) + queue partitions
    // (createQueue) + nightly schedules — is one-time DDL and runs under the
    // install advisory lock so concurrent fresh-DB boots serialize instead
    // of deadlocking in pgboss.create_queue. Handler registration below runs
    // AFTER release: work() is an in-process poller, no DDL, and steady-state
    // must never hold the lock.
    await withInstallLock(env.DATABASE_URL, logger, async () => {
      await boss.start();
      await boss.createQueue(USAGE_QUEUE);
      // Audit retention queue: 0 = keep forever; the queue always exists so
      // the schedule can be flipped later.
      await boss.createQueue(AUDIT_PURGE_QUEUE);
      if (retentionDays > 0) {
        await boss.schedule(AUDIT_PURGE_QUEUE, '0 3 * * *');
      } else {
        await boss.unschedule(AUDIT_PURGE_QUEUE).catch(() => {});
      }
      await boss.createQueue(APIKEY_EXPIRY_QUEUE);
      await boss.schedule(APIKEY_EXPIRY_QUEUE, '0 3 * * *');
      await boss.createQueue(IDEMPOTENCY_PURGE_QUEUE);
      await boss.schedule(IDEMPOTENCY_PURGE_QUEUE, '0 3 * * *');
      // The tool's queues: same install section, same lock, declaration order.
      for (const job of toolJobs) {
        await boss.createQueue(job.queue);
        if (!job.schedule) continue;
        if (job.schedule.enabled !== false) {
          await boss.schedule(job.queue, job.schedule.cron);
        } else {
          await boss.unschedule(job.queue).catch(() => {});
        }
      }
      // Orphaned-user GC: 0 = disabled; the queue always exists so the
      // schedule can be flipped later (audit-purge pattern).
      await boss.createQueue(ORPHAN_USER_PURGE_QUEUE);
      if (orphanRetentionHours > 0) {
        await boss.schedule(ORPHAN_USER_PURGE_QUEUE, '0 3 * * *');
      } else {
        await boss.unschedule(ORPHAN_USER_PURGE_QUEUE).catch(() => {});
      }
    });

    // Usage events flow through the durable queue (at-least-once); the
    // downstream sink (no-op locally, the rail in cloud) dedupes by ULID.
    // A downstream that takes batches (the hub poster) gets the drained
    // batch whole; a throw fails every job of it back to the queue's retry.
    await boss.work<UsageEvent>(USAGE_QUEUE, { batchSize: 50 }, async (jobs) => {
      if (downstreamUsage.emitBatch) {
        await downstreamUsage.emitBatch(jobs.map((job) => job.data));
      } else {
        for (const job of jobs) {
          await downstreamUsage.emit(job.data);
        }
      }
      logger.debug({ count: jobs.length }, 'usage events flushed');
    });

    // Audit retention: a nightly purge keeps audit_log from growing without
    // bound (machine reads land a row each — see audit/service.ts).
    await boss.work(AUDIT_PURGE_QUEUE, async () => {
      if (retentionDays <= 0) return;
      // Delete in bounded batches: one huge DELETE would seq-scan and blow the
      // pool's statement_timeout on a large table (retention then silently
      // never runs). Each batch touches at most BATCH rows (fast, index-backed
      // by audit_log_created_idx) and loops until the tail is drained.
      const BATCH = 5000;
      let total = 0;
      for (let i = 0; i < 10_000; i++) {
        const res = await db.execute(sql`
          DELETE FROM audit_log
          WHERE id IN (
            SELECT id FROM audit_log
            WHERE created_at < now() - make_interval(days => ${retentionDays})
            ORDER BY created_at
            LIMIT ${BATCH}
          )
        `);
        const deleted = res.rowCount ?? 0;
        total += deleted;
        if (deleted < BATCH) break;
      }
      logger.info({ retentionDays, deleted: total }, 'audit retention purge ran');
    });

    // API-key expiry: resolution already rejects expired keys fail-closed —
    // this nightly sweep only normalizes them to the visible terminal state
    // (revoked_at = expires_at). api_keys is a tiny bounded table, so one
    // unbatched UPDATE is fine (the audit-purge batching lesson applies to
    // unbounded tables only).
    await boss.work(APIKEY_EXPIRY_QUEUE, async () => {
      const res = await db.execute(sql`
        UPDATE api_keys
        SET revoked_at = expires_at
        WHERE expires_at < now() AND revoked_at IS NULL
      `);
      logger.info({ retired: res.rowCount ?? 0 }, 'api key expiry sweep ran');
    });

    // Idempotency replay rows carry a 24h TTL (a protocol constant, the
    // Stripe convention — not an env knob), so the table can never accumulate
    // beyond a day's create traffic: one unbatched, index-backed DELETE is
    // fine (the audit-purge batching lesson applies to unbounded tables only).
    await boss.work(IDEMPOTENCY_PURGE_QUEUE, async () => {
      const res = await db.execute(sql`
        DELETE FROM idempotency_keys WHERE expires_at < now()
      `);
      logger.info({ deleted: res.rowCount ?? 0 }, 'idempotency purge ran');
    });

    // The tool's pollers, registered where they always were: after the
    // chassis purges, before the orphan GC.
    for (const job of toolJobs) {
      await boss.work(job.queue, async () => {
        await job.handler();
      });
    }

    // Orphaned-user GC: setup-race losers, fail-closed SSO login strands
    // (cloud), and any other path leave Better Auth `user` rows with NO
    // workspace_members row — they can sign in but 401 everywhere, and they
    // accumulate forever. Cloud makes some of them CREDENTIAL-BEARING: a
    // fail-closed hub login strands a user + `antasphere` account row
    // HOLDING a live encrypted offline grant (Better Auth writes tokens
    // before the after-hook revokes the session), minted at an
    // unauthenticated-reachable rate during a hub outage — so a hub link
    // must NEVER protect a row from collection (that would accumulate
    // dormant refresh families without bound).
    //
    // What distinguishes the LEGIT zero-membership user (the cloud operator
    // pre-break-glass, a hub user whose last org was removed — both real
    // dashboard users of the /me zero state) from the strand is the LIVE
    // SESSION: the strand's was revoked by the fail-closed login; the legit
    // user holds one. So the sweep collects zero-membership users with NO
    // unexpired session, REGARDLESS of any provider link, plus two explicit
    // exclusions: a live pending invitation (mid-onboarding) and the
    // SUPERADMIN_EMAILS allowlist (the break-glass operator must survive
    // even after their session lapses — ADR 010's "arm the allowlist"
    // guidance, now enforced instead of advised).
    //
    // SAFETY INVARIANTS:
    //  - a user with ANY membership row — even a deactivated one — is a
    //    real member and is NEVER touched;
    //  - ── HARD CONSTRAINT (user-scoped federation) ──────────────────────
    //    the purge must NEVER delete an `antasphere` account row while
    //    leaving an `origin='hub'` membership row behind: that would make
    //    the reconciler's `no_link` branch — today unreachable for
    //    hub-origin principals, and the one unconditional fail-open —
    //    REACHABLE, i.e. a fail-open authorization hole. Held by
    //    construction: the only deletion here is the WHOLE user through
    //    Better Auth's internalAdapter.deleteUser (the exact path both GDPR
    //    delete surfaces use), whose FK cascade removes account rows AND
    //    membership rows together, and only ever for users the immediately
    //    preceding re-check proved to have ZERO membership rows. Never
    //    replace this with a partial cleanup (account rows, tokens) — whole
    //    user or nothing.
    await boss.work(ORPHAN_USER_PURGE_QUEUE, async () => {
      if (orphanRetentionHours <= 0) return; // 0 = disabled (schedule is off too)
      const authCtx = await auth.$context;
      // As ONE json parameter (never a JS array param — driver array
      // serialization is not worth trusting in a deletion query).
      const superadmins = JSON.stringify([...parseSuperadminEmails(env.SUPERADMIN_EMAILS)]);
      const BATCH = 50;
      let total = 0;
      const sample: string[] = [];
      for (let i = 0; i < 200; i++) {
        // Candidates: zero memberships, past the grace period, NO live
        // (unexpired) session, no LIVE pending invitation for their email —
        // an orphan someone just re-invited is mid-onboarding, not garbage
        // (the invitation row exists before its accept URL does, so this
        // closes the scan-then-accept race for the invited case) — and not
        // a superadmin-allowlisted address. The exclusions live in the
        // query (not a JS skip): a skipped candidate would otherwise fill
        // the batch forever and starve the real orphans behind it.
        const res = await db.execute(sql`
          SELECT u.id, u.email FROM "user" u
          WHERE NOT EXISTS (
              SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id
            )
            AND u.created_at < now() - make_interval(hours => ${orphanRetentionHours})
            AND NOT EXISTS (
              SELECT 1 FROM session s WHERE s.user_id = u.id AND s.expires_at > now()
            )
            AND NOT EXISTS (
              SELECT 1 FROM invitations inv
              WHERE lower(inv.email) = lower(u.email)
                AND inv.accepted_at IS NULL
                AND inv.revoked_at IS NULL
                AND inv.expires_at > now()
            )
            -- BG-2: the allowlist protects exactly what break-glass ACCEPTS —
            -- a VERIFIED allowlisted address. An unverified squat of an
            -- allowlisted email is no operator and gets no shelter.
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(${superadmins}::jsonb) AS sa(email)
              WHERE sa.email = lower(u.email) AND u.email_verified
            )
            -- CLOUD-3: the setup operator (instance_settings.operator_user_id)
            -- is NEVER an orphan — on cloud they hold no membership by
            -- design, and deleting them loses the only local credential and
            -- the only break-glass identity. Durable, allowlist or not.
            AND u.id IS DISTINCT FROM (SELECT operator_user_id FROM instance_settings LIMIT 1)
          LIMIT ${BATCH}
        `);
        const rows = res.rows as unknown as Array<{ id: string; email: string }>;
        if (rows.length === 0) break;
        let progressed = 0;
        for (const row of rows) {
          // Final re-check immediately before the delete: a membership OR a
          // live session (the user signing in mid-sweep) can appear between
          // the candidate scan and here — either one disqualifies.
          const still = await db.execute(sql`
            SELECT 1 FROM workspace_members WHERE user_id = ${row.id}
            UNION ALL
            SELECT 1 FROM session WHERE user_id = ${row.id} AND expires_at > now()
            LIMIT 1
          `);
          if ((still.rows?.length ?? 0) > 0) continue;
          try {
            await authCtx.internalAdapter.deleteUser(row.id);
            await authCtx.internalAdapter.deleteUserSessions(row.id);
            total += 1;
            progressed += 1;
            if (sample.length < 20) sample.push(row.email);
          } catch (err) {
            // Skip and keep sweeping: a failed delete (e.g. the 0009
            // last-owner trigger backstopping the pathological race where
            // the user gained a sole-owner membership mid-sweep) aborts
            // THIS user only.
            logger.warn({ err, userId: row.id }, 'orphan purge: skipping user (delete failed)');
          }
        }
        if (rows.length < BATCH) break;
        if (progressed === 0) break; // every candidate failed/was skipped — no hot loop
      }
      if (total > 0) {
        // INSTANCE-attributed system row (workspace_id NULL, ADR 014):
        // orphans belong to no workspace, so no workspace's audit trail is
        // the honest home — the row is an operator-level record.
        await audit.write({
          workspaceId: null,
          principal: null, // → actorVia 'system'
          action: 'user.orphan_purge',
          resourceType: 'user',
          metadata: { deleted: total, retentionHours: orphanRetentionHours, sample }
        });
      }
      logger.info({ retentionHours: orphanRetentionHours, deleted: total }, 'orphan user purge ran');
    });
  } else {
    // api role: migrate:false start() runs no DDL and creates no queues — it
    // only verifies the pgboss schema exists ('pg-boss is not installed' on a
    // fresh DB until an all|worker boot installs it; internal/scale-drill-findings.md), so it
    // needs neither the install lock nor DDL rights.
    await boss.start();
  }

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, wait: true });
    }
  };
}

/**
 * The UsageSink bound into the registry: durable, batched emission via
 * pg-boss. Domain code calls emit() and never blocks on the downstream.
 */
/**
 * The queue's retry budget: ten retries with exponential backoff from thirty
 * seconds, about eight and a half hours in all — a hub deploy (the hub
 * deploys first, and answers 404 until it has) or an outage of an afternoon
 * loses nothing. At-least-once is the posture; the hub dedupes by ULID.
 */
export const DEFAULT_USAGE_RETRY = { limit: 10, delaySeconds: 30 } as const;

export class PgBossUsageSink implements UsageSink {
  constructor(
    private readonly boss: PgBoss,
    private readonly logger: Logger,
    private readonly retry: { limit: number; delaySeconds: number } = DEFAULT_USAGE_RETRY
  ) {}

  async emit(event: UsageEvent): Promise<void> {
    try {
      await this.boss.send(USAGE_QUEUE, event, {
        // Guards against re-enqueueing the same PENDING event only; true
        // idempotency is the receiver's job (dedupe by ULID, per contract).
        singletonKey: event.id,
        retryLimit: this.retry.limit,
        retryDelay: this.retry.delaySeconds,
        retryBackoff: true
      });
    } catch (err) {
      // Usage must never break the request path.
      this.logger.error({ err, meter: event.meter }, 'usage emit failed');
    }
  }
}
