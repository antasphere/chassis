import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Keyset (cursor) pagination over (created_at, id), newest first — the audit
 * route's convention extended to the uuid-keyed tables. The cursor is the
 * last returned row's plain id, NOT an encoded (createdAt, id) pair: a JS
 * Date round-trip truncates Postgres microseconds, and a millisecond-equal
 * boundary row would then be skipped or repeated. Keeping the timestamp
 * SQL-side (resolved from the cursor row by subquery) means the precision
 * never leaves Postgres.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared UUID shape check — cursors here, and the id params of the
 * plain-Hono routes that have no contract schema (files content/HEAD): a
 * non-UUID string must be rejected before it reaches Postgres' uuid cast.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The cursor row id, or null when absent/malformed. A malformed cursor is
 * silently ignored — the caller serves page 1 (the audit route's
 * `Number('banana')` tolerance).
 */
export function cursorRowId(cursor: string | undefined): string | null {
  if (!cursor || !isUuid(cursor)) return null;
  return cursor;
}

/**
 * Row-value keyset predicate: everything strictly older than the cursor row,
 * with the cursor row's (created_at, id) resolved by a SQL-side subquery.
 * The subquery is workspace-scoped so a foreign workspace's cursor can never
 * position inside this workspace's ordering. A well-formed-but-unknown id
 * makes the subquery empty → NULL predicate → empty page + nextCursor null;
 * harmless, since cursors are server-issued and these tables never
 * hard-delete rows.
 */
export function keysetBefore(opts: {
  table: PgTable;
  id: PgColumn;
  createdAt: PgColumn;
  workspaceId: PgColumn;
  cursorId: string;
  workspace: string;
}): SQL {
  return sql`(${opts.createdAt}, ${opts.id}) < (SELECT ${opts.createdAt}, ${opts.id} FROM ${opts.table} WHERE ${opts.id} = ${opts.cursorId} AND ${opts.workspaceId} = ${opts.workspace})`;
}

/** Slice a limit+1 fetch into the page + the audit-style nextCursor (last id of the page). */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number
): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
  return { page, nextCursor };
}
