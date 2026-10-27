import { createDb, type DbConn } from '@antasphere/chassis-db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endPool, startPostgres } from '../../src/testing/helpers.js';

/**
 * The production pool survives what a Postgres restart does to it (lane A's
 * verifier, F5). node-postgres emits `error` on the POOL when an idle client's
 * connection ends on the server's side; with no listener that event is an
 * uncaught exception and the process dies with 57P01. `createDb` listens, so
 * the cost of a restart is one reconnect.
 *
 * The backends are ended with `pg_terminate_backend`, from a connection of its
 * own: exactly what a restart, a failover or an administrator does.
 */
let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

/** Ends every other backend of this database, the way a restart would. */
async function terminateOtherBackends(url: string): Promise<number> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    const res = await admin.query<{ ended: boolean }>(
      `select pg_terminate_backend(pid) as ended from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()`
    );
    return res.rows.filter((r) => r.ended).length;
  } finally {
    await admin.end();
  }
}

describe('createDb: an idle pooled connection ended by the server', () => {
  it('reaches the listener, never the process, and the next query gets a new connection', async () => {
    const url = container.getConnectionUri();
    const seen: Array<{ code?: string }> = [];
    const checkedOut: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    const { pool } = createDb(
      url,
      {},
      {
        onIdleError: (err) => seen.push(err as { code?: string }),
        onCheckedOutError: (err) => checkedOut.push(err)
      }
    );
    try {
      // three IDLE clients: checked out together, then all released
      const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
      for (const c of clients) c.release();
      expect(pool.idleCount).toBe(3);

      expect(await terminateOtherBackends(url)).toBe(3);
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(3);

      expect(seen.map((e) => e.code)).toEqual(['57P01', '57P01', '57P01']);
      // an idle client is the pool's to report, once: never the checked-out hook
      expect(checkedOut).toEqual([]);
      expect(uncaught).toEqual([]);
      // the dead clients left the pool, and the pool still serves
      expect(pool.totalCount).toBe(0);
      const res = await pool.query<{ one: number }>('select 1 as one');
      expect(res.rows[0]?.one).toBe(1);
    } finally {
      process.off('uncaughtException', onUncaught);
      await endPool(pool);
    }
  });

  it('listens even when the caller gives no callback: the bare handle is safe too', async () => {
    const { pool } = createDb(container.getConnectionUri(), {});
    try {
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      await endPool(pool);
    }
  });
});

/** Ends one backend, from a connection of its own. */
async function terminateBackend(url: string, pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query('select pg_terminate_backend($1)', [pid]);
  } finally {
    await admin.end();
  }
}

/**
 * PRDCT-3583: the same, for a client the pool has HANDED OUT. node-postgres
 * emits `error` on the client when the server ends a checked-out connection,
 * and pg-pool listens on a client only while it is idle: inside a
 * `db.transaction` nobody listened, and the process died (Mail's sync, 641
 * crashes in a day, 25P03 from the pool's own idle-in-transaction timeout).
 */
describe('createDb: a checked-out connection ended by the server', () => {
  async function run(body: (trx: DbConn, pid: number) => Promise<void>) {
    const url = container.getConnectionUri();
    const seen: Array<{ code?: string }> = [];
    const idle: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    const { db, pool } = createDb(
      url,
      {},
      {
        onIdleError: (err) => idle.push(err),
        onCheckedOutError: (err) => seen.push(err as { code?: string })
      }
    );
    try {
      const tx = db.transaction(async (trx) => {
        const res = await trx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await body(trx, res.rows[0]!.pid);
        await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1);
        await trx.execute(sql`select 1`);
      });
      // the transaction rejects, the process does not hear of it
      await expect(tx).rejects.toThrow();
      expect(uncaught).toEqual([]);
      expect(idle).toEqual([]);
      // the dead client left the pool, and the pool still serves
      await expect.poll(() => pool.totalCount, { timeout: 10_000 }).toBe(0);
      const res = await pool.query<{ one: number }>('select 1 as one');
      expect(res.rows[0]?.one).toBe(1);
      return seen.map((e) => e.code);
    } finally {
      process.off('uncaughtException', onUncaught);
      await endPool(pool);
    }
  }

  it('pg_terminate_backend inside db.transaction: the transaction rejects, the process survives', async () => {
    const url = container.getConnectionUri();
    expect(await run((_trx, pid) => terminateBackend(url, pid))).toEqual(['57P01']);
  });

  it('a transaction held across a slow call past idle_in_transaction_session_timeout (25P03)', async () => {
    const codes = await run(async (trx) => {
      await trx.execute(sql`set local idle_in_transaction_session_timeout = 200`);
      // the network call the transaction should never have been held across
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    expect(codes).toEqual(['25P03']);
  });
});
