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
  /**
   * Told when a CHECKED-OUT connection ends on the server's side (inside a
   * transaction: `pg_terminate_backend`, a failover, the pool's own
   * `idle_in_transaction_session_timeout`, 25P03): the place to log it. The
   * query or transaction holding that client rejects on its own; the pool
   * drops the client when it is released.
   */
  onCheckedOutError?: (err: Error) => void;
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
  // The same, for a client the pool has handed out (PRDCT-3583). pg-pool
  // listens on a client only while it is idle, and node-postgres emits
  // `error` on the CLIENT when the server ends a checked-out connection: inside
  // a transaction nobody listened, and the process died. Every client gets a
  // listener of its own for its whole life; it reports only while the client
  // is checked out, since the pool's idle listener reports the idle case, and
  // once, as that one does (the socket's close follows with a second error).
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_err, client) => checkedOut.delete(client));
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      if (checkedOut.delete(client)) options.onCheckedOutError?.(err);
    });
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
