import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The handle type is schema-AGNOSTIC on purpose: the chassis only knows its own
 * tables, the tool merges its domain tables in (`createDb(url, schema)`), and
 * both must pass the same handle around. Nothing in the codebase uses drizzle's
 * relational `db.query.*` API — the only member the schema generic shapes — so
 * the query builder (`select/insert/update/delete/transaction/execute`) is typed
 * identically whatever the schema is.
 */
export type Db = NodePgDatabase<Record<string, unknown>>;

/**
 * A database handle OR an open transaction — for code that must run either
 * standalone or inside a caller's transaction (e.g. a tool's blob
 * in-use guard inside the file-delete transaction).
 */
export type DbConn = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export interface CreateDbOptions {
  /**
   * Told when an IDLE pooled connection ends on the server's side (a Postgres
   * restart, a failover, `pg_terminate_backend`): the place to log it. The
   * pool has already dropped that client and opens a new one on the next query.
   */
  onIdleError?: (err: Error) => void;
}

export function createDb(
  connectionString: string,
  schema: Record<string, unknown>,
  options: CreateDbOptions = {}
): DbHandle {
  // Conservative pool defaults for a single-container instance. A runaway
  // query cannot hold a connection (or a transaction) forever, and the pool
  // cannot starve Postgres' default max_connections when replicas multiply.
  // Note for PgBouncer transaction mode: statement_timeout is a session-level
  // setting — set it server-side instead (documented in deployment-profiles).
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000
  });
  // ALWAYS listened to, whoever the caller is. node-postgres emits `error` on
  // the pool when an idle client's connection ends server-side, and an `error`
  // event nobody listens to is an uncaught exception: without this line a
  // Postgres restart kills the process (57P01) instead of costing one reconnect.
  pool.on('error', (err) => options.onIdleError?.(err));
  const db = drizzle(pool, { schema });
  return { db, pool };
}
