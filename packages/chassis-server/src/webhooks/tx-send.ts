import type PgBoss from 'pg-boss';
import type { DbConn } from '@antasphere/chassis-db';

/**
 * A pg-boss send INSIDE a drizzle transaction (or on a plain handle): the job
 * row is written by the same connection as the caller's own rows, so it
 * commits with them and never exists for a rolled-back write. pg-boss takes
 * an executor (`db.executeSql(text, values)`), and the executor here is the
 * connection drizzle's handle wraps: a `pg` PoolClient inside a transaction,
 * the Pool outside one. The statement runs exactly as pg-boss wrote it, its
 * `$n` placeholders untouched: a placeholder pg-boss reuses three times with
 * three casts (`right($5,1)`, `CAST($5 as timestamptz)`, `COALESCE($5,'0')`)
 * keeps its one type, where a rebinding into drizzle's own parameters gave
 * each occurrence a type of its own and refused a `startAfter` in seconds
 * (the chassis suite, scenario 8).
 *
 * The connection is reached through drizzle's node-postgres session
 * (`session.client`), an internal of the driver binding; `tx-send.test.ts`
 * pins the shape against the installed version. A drizzle bump re-verifies it.
 */
interface QueryClient {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The pg client (or pool) behind a drizzle handle or transaction. */
export function connectionOf(conn: DbConn): QueryClient {
  const client = (conn as unknown as { session?: { client?: Partial<QueryClient> } }).session?.client;
  if (!client || typeof client.query !== 'function') {
    throw new Error('tx-send: the drizzle handle exposes no node-postgres client (session.client)');
  }
  return client as QueryClient;
}

export function drizzleExecutor(conn: DbConn): PgBoss.Db {
  const client = connectionOf(conn);
  return {
    executeSql: async (text: string, values: unknown[]) => {
      const res = await client.query(text, values);
      return { rows: res.rows as Record<string, unknown>[] };
    }
  };
}

/** Send one job through `conn`; answers the job id (null when the queue does not exist). */
export function sendInTx(
  boss: PgBoss,
  conn: DbConn,
  queue: string,
  data: object,
  options: PgBoss.SendOptions = {}
): Promise<string | null> {
  return boss.send(queue, data, { ...options, db: drizzleExecutor(conn) });
}
