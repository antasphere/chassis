import type PgBoss from 'pg-boss';
import type pg from 'pg';
import type { Logger } from '../logger.js';

/**
 * One-off timers (PRDCT-3254): a tool runs a function ONCE at an instant or
 * after a delay, with a JSON payload, on a queue its `jobs` slot declared.
 * The runtime is pg-boss, the same durable queue the crons ride: a timer is a
 * job row with `start_after` in the future, so it lives in the tool's own
 * Postgres, survives a restart and a redeploy, and is taken by exactly one
 * worker replica (pg-boss fetches with SKIP LOCKED). Edition-neutral, and an
 * api-role replica schedules and cancels like any other: neither needs DDL.
 *
 * A KEY makes a timer replaceable: at most one PENDING timer per (queue, key).
 * `schedule` with a key withdraws the pending timer of that key and inserts
 * the new one in ONE transaction under a per-key advisory lock, so two
 * replicas re-arming the same thing at once never leave two timers, and
 * `cancel({ key })` withdraws whatever is pending under it. A timer that is
 * already RUNNING is neither replaced nor cancelled (its handler is on it;
 * the handler's own claim decides what it does), so a consumer keeps its
 * at-most-once guard in the data it writes (meet's claim-before-send stamps),
 * never in the timer alone. What a replace or a cancel DOES do to a running
 * timer is take its retries away (`retry_limit = retry_count`): pg-boss's
 * fail path re-inserts a failed run as a pending `retry` row with the same
 * key, which would put the withdrawn payload back beside the new one
 * (verifier round 1, F1). A withdrawn run that throws therefore ends
 * `failed`, and "one pending per key" holds across the run's failure too.
 * `cancel` itself runs without the per-key lock: a cancel concurrent with a
 * replace may answer 0 and leave the replace's fresh timer pending (it ran
 * first); a consumer that wants "nothing pending" cancels after its last
 * schedule, as every path does.
 *
 * The payload is a plain JSON object (not an array, not a Date, nothing a
 * `JSON.stringify` refuses): node-postgres serialises anything else into a
 * value the `jsonb` column refuses with a raw database error, so the check is
 * made here and answers `invalid_argument` before any statement runs.
 *
 * What a timer costs in pg-boss's terms: `keep_until` is `start_after` plus
 * the queue's retention (fourteen days by default), so a timer months ahead is
 * not archived before its time; the handler's run is bounded by the queue's
 * `expireIn` (fifteen minutes by default); a handler that throws fails the
 * job, retried per `retry` or the queue's own settings (pg-boss's queue
 * default is two retries with no delay, so a handler that always throws runs
 * three times back to back), then left `failed`.
 *
 * The pending-state SQL reads pg-boss's own `job` table (its schema is
 * `PGBOSS_SCHEMA`, the column names pg-boss 10's), because pg-boss exposes no
 * lookup by key; `timers.test.ts` pins the statements against the installed
 * version. A pg-boss bump re-verifies them.
 */

/** The pg-boss schema the chassis installs (`createJobs`). */
export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Advisory-lock class serializing the replace of a keyed timer, beside the
 * migration lock (7432001), the last-owner locks (7432002 xact / 7432003
 * session) and the pg-boss install lock (7432004). Transaction-scoped, two-int
 * form: the class and `hashtext(queue + US + key)`.
 */
export const TIMER_KEY_LOCK_CLASS = 7_432_005;

/** What a handler learns about the run beside its payload. */
export interface TimerJob {
  /** pg-boss's job id, the one `schedule` answered. */
  id: string;
  queue: string;
  /** The dedupe key the timer was scheduled with; null without one, and on a cron's run. */
  key: string | null;
}

/** When the timer fires: an instant, or a delay from now in seconds. Exactly one. */
export type TimerWhen = { at: Date; inSeconds?: never } | { inSeconds: number; at?: never };

/** How a failing handler is retried: `limit` more attempts, `delaySeconds` apart (doubled each time with `backoff`). */
export interface TimerRetry {
  limit: number;
  delaySeconds?: number;
  backoff?: boolean;
}

export type TimerOptions = TimerWhen & {
  /** The dedupe key: at most one pending timer per (queue, key); a new schedule under it replaces the pending one. */
  key?: string;
  /** Absent: the queue's own retry settings. */
  retry?: TimerRetry;
};

export type TimerRef = { id: string; key?: never } | { key: string; id?: never };

export interface Timers {
  /**
   * Run the queue's handler once with `data`, at `at` or `inSeconds` from
   * now. Answers the job id. Throws `TimerError` (`unknown_queue`) when the
   * queue is not one the tool's `jobs` slot declared, `invalid_argument` on a
   * malformed call.
   */
  schedule<TData extends object>(queue: string, data: TData, options: TimerOptions): Promise<string>;
  /**
   * Withdraw a timer that has not run yet, by its id or by its key. Answers
   * how many pending timers were withdrawn (0 when none was pending: already
   * run, already withdrawn, running right now, or never scheduled).
   */
  cancel(queue: string, ref: TimerRef): Promise<number>;
}

export class TimerError extends Error {
  constructor(
    readonly code: 'unknown_queue' | 'invalid_argument',
    message: string
  ) {
    super(message);
    this.name = 'TimerError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pg-boss's own rule for a queue name (`Attorney.assertQueueName`), applied before any statement runs. */
const QUEUE_NAME = /^[\w-]+$/;
/** Unit separator: joins the queue and the key under one lock hash, and can appear in neither. */
const US = '\u001f';

const invalid = (message: string) => new TimerError('invalid_argument', `timers: ${message}`);
/** The longest delay a timer takes, in seconds: a hundred years. Postgres refuses an interval written in exponent form. */
export const MAX_IN_SECONDS = 100 * 365.25 * 24 * 3600;

function assertQueue(queue: unknown): asserts queue is string {
  if (typeof queue !== 'string' || !QUEUE_NAME.test(queue)) {
    throw invalid('the queue must be a name of letters, digits, underscores and hyphens');
  }
}

/** The pg-boss `startAfter` for `options`: the Date of `at`, or the delay in seconds. */
export function startAfterOf(options: TimerWhen): Date | number {
  const hasAt = options.at !== undefined;
  const hasIn = options.inSeconds !== undefined;
  if (hasAt === hasIn) throw invalid('exactly one of `at` and `inSeconds` is required');
  if (hasAt) {
    const at = options.at as Date;
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid('`at` must be a valid Date');
    return at;
  }
  const seconds = options.inSeconds as number;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_IN_SECONDS)
    throw invalid('`inSeconds` must be a finite number, between 0 and a hundred years');
  return seconds;
}

function retryOptionsOf(retry: TimerRetry | undefined): PgBoss.RetryOptions {
  if (retry === undefined) return {};
  if (!Number.isInteger(retry.limit) || retry.limit < 0)
    throw invalid('`retry.limit` must be an integer, 0 or more');
  const delay = retry.delaySeconds ?? 0;
  if (!Number.isInteger(delay) || delay < 0)
    throw invalid('`retry.delaySeconds` must be an integer, 0 or more');
  return { retryLimit: retry.limit, retryDelay: delay, retryBackoff: retry.backoff ?? false };
}

function assertData(data: unknown): void {
  const proto = typeof data === 'object' && data !== null ? Object.getPrototypeOf(data) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw invalid('the payload must be a plain object');
  }
  try {
    JSON.stringify(data);
  } catch {
    throw invalid('the payload must be JSON (no bigint, no circular reference)');
  }
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.includes(US)) {
    throw invalid('the key must be a non-empty string');
  }
}

/** The one statement that withdraws pending timers: created or waiting for a retry, never running. */
const CANCEL_PENDING = (where: string) => `
  UPDATE ${PGBOSS_SCHEMA}.job
  SET state = 'cancelled', completed_on = now()
  WHERE name = $1 AND ${where} AND state IN ('created', 'retry')
`;
/**
 * The statement that takes a RUNNING timer's retries away, so that if the
 * run fails it ends `failed` and never comes back as a pending `retry` row
 * under the withdrawn key or id (pg-boss retries while
 * `retry_count < retry_limit`).
 */
const DISARM_ACTIVE = (where: string) => `
  UPDATE ${PGBOSS_SCHEMA}.job
  SET retry_limit = retry_count
  WHERE name = $1 AND ${where} AND state = 'active'
`;

interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Withdraw the pending timers `ref` names and disarm a running one; answers the pending count withdrawn. */
async function cancelPending(client: Queryable, queue: string, ref: TimerRef): Promise<number> {
  let where: string;
  let value: string;
  if (ref.id !== undefined) {
    if (!UUID.test(ref.id)) throw invalid('the id must be a job id');
    where = 'id = $2::uuid';
    value = ref.id;
  } else {
    assertKey(ref.key);
    where = 'singleton_key = $2';
    value = ref.key;
  }
  // The disarm FIRST, then the withdraw (verifier round 2, F7): pg-boss's fail
  // path deletes the active row and re-inserts it as `retry` under the same
  // key. Disarm first either takes the row lock before that fail (which then
  // waits for the commit and computes `failed` on the disarmed row) or runs
  // after it, and the withdraw, a new statement with a new snapshot, then
  // sees the re-inserted `retry` row and cancels it. In the other order both
  // statements could miss the row, one round trip wide. A replace whose
  // insert then fails rolls the disarm back with it: the old run keeps its
  // retries, a failed replace changes nothing.
  await client.query(DISARM_ACTIVE(where), [queue, value]);
  const res = await client.query(CANCEL_PENDING(where), [queue, value]);
  return res.rowCount ?? 0;
}

export class PgBossTimers implements Timers {
  constructor(
    private readonly boss: PgBoss,
    private readonly pool: pg.Pool,
    private readonly logger: Logger
  ) {}

  async schedule<TData extends object>(queue: string, data: TData, options: TimerOptions): Promise<string> {
    assertQueue(queue);
    assertData(data);
    const send: PgBoss.SendOptions = { startAfter: startAfterOf(options), ...retryOptionsOf(options.retry) };
    if (options.key === undefined) {
      return this.insert(queue, data, send);
    }
    assertKey(options.key);
    const key = options.key;
    // Replace = withdraw + insert in one transaction, serialized per key
    // across replicas by a transaction-scoped advisory lock on a client of
    // our own: pg-boss runs the insert through the `db` executor we hand it.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        TIMER_KEY_LOCK_CLASS,
        queue + US + key
      ]);
      const replaced = await cancelPending(client, queue, { key });
      const id = await this.insert(queue, data, {
        ...send,
        singletonKey: key,
        db: { executeSql: (text, values) => client.query(text, values) }
      });
      await client.query('COMMIT');
      if (replaced > 0) this.logger.debug({ queue, key, replaced }, 'timers: a pending timer was replaced');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(queue: string, ref: TimerRef): Promise<number> {
    assertQueue(queue);
    if ((ref.id === undefined) === (ref.key === undefined))
      throw invalid('exactly one of `id` and `key` is required');
    return cancelPending(this.pool, queue, ref);
  }

  /** pg-boss answers null for a queue that does not exist (its insert joins the queue row): that is an unknown queue, named. */
  private async insert(queue: string, data: object, send: PgBoss.SendOptions): Promise<string> {
    const id = await this.boss.send(queue, data, send);
    if (id === null) {
      throw new TimerError(
        'unknown_queue',
        `timers: the queue "${queue}" is not declared by the tool's jobs slot (a timer rides a declared queue)`
      );
    }
    return id;
  }
}
