import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Keyset (cursor) pagination over (created_at, id), newest first — the audit
 * route's convention extended to the uuid-keyed tables. Two cursor dialects,
 * one rule: the timestamp's precision never leaves Postgres, because a JS
 * Date round-trip truncates its microseconds and a millisecond-equal
 * boundary row would then be skipped or repeated.
 *
 *  - `keysetBefore`: the cursor is the last returned row's plain id, and the
 *    timestamp is resolved from that row by subquery at page time. For the
 *    tables that never hard-delete a row (members are deactivated, keys and
 *    invitations revoked, projects archived): the cursor row is always there.
 *  - `keysetBeforeValue`: the cursor CARRIES the timestamp, as the text
 *    Postgres itself rendered (`created_at::text`, selected beside the row,
 *    never a JS Date), with the id. For a table that hard-deletes rows
 *    (project_members): a cursor naming a removed row would compare against
 *    NULL under the subquery dialect and end the listing early.
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

/**
 * The value-carrying cursor (`keysetBeforeValue`): the row's `created_at` as
 * Postgres rendered it and its id, base64url of `<text>|<id>`. Opaque on the
 * wire like the other dialect; a malformed one is ignored (page 1).
 */
const TIMESTAMPTZ_TEXT_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2}(?::\d{2})?)?$/;

export interface KeysetValueCursor {
  /** `created_at::text`, exactly as Postgres rendered it. */
  createdAt: string;
  id: string;
}

export function encodeKeysetCursor(row: { id: string; createdAtText: string }): string {
  return Buffer.from(`${row.createdAtText}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeKeysetCursor(cursor: string | undefined): KeysetValueCursor | null {
  if (!cursor || cursor.length > 200) return null;
  // Node's base64url decoder never throws (it drops what it cannot read):
  // the guard is the two shape checks below, not the decode.
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = decoded.lastIndexOf('|');
  if (at < 0) return null;
  const createdAt = decoded.slice(0, at);
  const id = decoded.slice(at + 1);
  // Both halves are validated before they reach a Postgres cast: a shape the
  // casts would refuse must answer page 1, never a 500.
  if (!TIMESTAMPTZ_TEXT_RE.test(createdAt) || !isUuid(id)) return null;
  return { createdAt, id };
}

/** The `created_at::text` column to select beside a row that will mint a value cursor. */
export function createdAtText(createdAt: PgColumn): SQL<string> {
  return sql<string>`${createdAt}::text`;
}

/** `(created_at, id) < (cursor)` with the cursor's own values; `keysetBefore`'s twin for hard-deleting tables. */
export function keysetBeforeValue(opts: {
  id: PgColumn;
  createdAt: PgColumn;
  cursor: KeysetValueCursor;
}): SQL {
  return sql`(${opts.createdAt}, ${opts.id}) < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`;
}
