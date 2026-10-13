import { sql, type SQL } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import type { DbConn } from '@antasphere/chassis-db';

/**
 * A pg-boss send INSIDE a drizzle transaction (or on a plain handle): the job
 * row is written by the same connection as the caller's own rows, so it
 * commits with them and never exists for a rolled-back write. pg-boss takes
 * an executor (`db.executeSql(text, values)`); drizzle's handle runs
 * parametrized SQL only through its `sql` template, so the `$n` placeholders
 * of pg-boss's statement are rebound as template parameters here (the same
 * mechanism `jobs/timers.ts` uses with a raw client for its keyed replace).
 */
export function drizzleExecutor(conn: DbConn): PgBoss.Db {
  return {
    executeSql: async (text: string, values: unknown[]) => {
      const res = await conn.execute(bindPlaceholders(text, values));
      return { rows: res.rows as Record<string, unknown>[] };
    }
  };
}

/** `INSERT … VALUES ($1, $2)` with `[a, b]` → the drizzle statement with `a` and `b` as its parameters. */
export function bindPlaceholders(text: string, values: unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      if (part !== '') chunks.push(sql.raw(part));
    } else {
      const index = Number(part) - 1;
      if (index < 0 || index >= values.length) throw new Error(`tx-send: placeholder $${part} has no value`);
      // pg-boss hands `undefined` for an option it leaves to the queue's
      // default; drizzle renders an undefined parameter as nothing, which
      // breaks the statement (`::int as retry_limit_default`), so it is bound as NULL.
      chunks.push(sql`${values[index] === undefined ? null : values[index]}`);
    }
  }
  return sql.join(chunks, sql``);
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
