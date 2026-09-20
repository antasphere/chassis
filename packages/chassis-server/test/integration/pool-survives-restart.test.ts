import { createDb } from '@antasphere/chassis-db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    const { pool } = createDb(url, {}, { onIdleError: (err) => seen.push(err as { code?: string }) });
    try {
      // three IDLE clients: checked out together, then all released
      const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
      for (const c of clients) c.release();
      expect(pool.idleCount).toBe(3);

      expect(await terminateOtherBackends(url)).toBe(3);
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(3);

      expect(seen.map((e) => e.code)).toEqual(['57P01', '57P01', '57P01']);
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
