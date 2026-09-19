import { and, eq, gte, ilike, inArray, isNull, like, lte, or, type SQL } from 'drizzle-orm';
import { AUDIT_ACTOR_SYSTEM, type AuditListQuery, type AuditVia } from '@antasphere/chassis-contract';
import { auditLog, user as userTable } from '@antasphere/chassis-db';

/**
 * The audit list's WHERE, from the validated query. Every value arrives as
 * a bound parameter (drizzle's `eq`/`like`/`ilike` never interpolate), and
 * the free-text ones are escaped as LIKE patterns first, so a `%` or `_` in
 * what the admin typed matches itself rather than anything.
 */

/** A LIKE pattern for "contains this text", the wildcards of the text itself escaped. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The `action` list, split and de-duplicated: an item ending in `.` is a
 * family (a prefix), any other item is one action. The contract has already
 * bounded the count and the alphabet; empty items are dropped here.
 */
export function parseActionList(value: string): { exact: string[]; families: string[] } {
  const exact = new Set<string>();
  const families = new Set<string>();
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (item.endsWith('.')) families.add(item);
    else exact.add(item);
  }
  return { exact: [...exact], families: [...families] };
}

/** The `actorVia` list, split and de-duplicated (the contract pinned the alphabet). */
export function parseViaList(value: string): AuditVia[] {
  return [...new Set(value.split(',').map((v) => v.trim()))].filter((v): v is AuditVia =>
    ['session', 'api_key', 'oauth', 'system'].includes(v)
  );
}

/**
 * The cursor, or null when absent, malformed or out of range. Malformed
 * cursors serve page 1; out-of-range ones are refused the same way, since
 * Number('99999999999999999999') is finite but past bigint precision, and
 * sending it to the `lt(id, …)` comparison overflows in Postgres.
 * Safe-integer is the honest bound for a JS-roundtripped bigserial id.
 */
export function cursorId(cursor: string | undefined): number | null {
  const parsed = cursor ? Number(cursor) : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The filter conditions (the workspace scope and the cursor are the
 * caller's): one AND-ed list, each member a parameterised comparison.
 * Returns an empty list when nothing filters.
 */
export function auditFilterConditions(query: AuditListQuery): SQL[] {
  const conditions: SQL[] = [];

  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    const either = or(ilike(userTable.email, pattern), ilike(auditLog.action, pattern));
    if (either) conditions.push(either);
  }

  if (query.action) {
    const { exact, families } = parseActionList(query.action);
    const alternatives: SQL[] = [];
    if (exact.length) alternatives.push(inArray(auditLog.action, exact));
    for (const family of families) alternatives.push(like(auditLog.action, `${escapeLike(family)}%`));
    const anyOf = alternatives.length ? or(...alternatives) : undefined;
    if (anyOf) conditions.push(anyOf);
  }

  if (query.actorVia) {
    const vias = parseViaList(query.actorVia);
    if (vias.length) conditions.push(inArray(auditLog.actorVia, vias));
  }

  if (query.actor) {
    conditions.push(
      query.actor === AUDIT_ACTOR_SYSTEM
        ? isNull(auditLog.actorUserId)
        : eq(auditLog.actorUserId, query.actor)
    );
  }

  if (query.resourceType) conditions.push(eq(auditLog.resourceType, query.resourceType));
  if (query.resourceId) conditions.push(eq(auditLog.resourceId, query.resourceId));
  if (query.from) conditions.push(gte(auditLog.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(auditLog.createdAt, new Date(query.to)));

  return conditions;
}

/** The whole WHERE: the scope, the filters, and the keyset cursor when there is one. */
export function auditWhere(scope: SQL, filters: SQL[], cursor: SQL | null): SQL {
  const all = [scope, ...filters, ...(cursor ? [cursor] : [])];
  return and(...all) ?? scope;
}
