import { describe, expect, it } from 'vitest';
import { and, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { auditListQuerySchema } from '@antasphere/chassis-contract';
import {
  auditFilterConditions,
  cursorId,
  escapeLike,
  parseActionList,
  parseViaList
} from '@antasphere/chassis-server/audit';

/**
 * The audit list's filters: what the contract admits, how the free-text
 * ones become LIKE patterns, and that every admitted value lands in the
 * WHERE as a bound parameter, never in the SQL text.
 */

const parse = (query: Record<string, string>) => auditListQuerySchema.safeParse(query);

describe('the audit list query contract', () => {
  it('admits every filter, and the page without one', () => {
    expect(parse({}).success).toBe(true);
    const full = parse({
      q: 'owner@example',
      action: 'presentation.,apikey.create,post /api/v1/things',
      actorVia: 'session,api_key',
      actor: 'system',
      resourceType: 'presentation',
      resourceId: '0f0f0f0f-0000-4000-8000-000000000000',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-19T23:59:59.999Z',
      limit: '20'
    });
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.limit).toBe(20);
  });

  it('refuses control characters, an unknown via, a bad date and an oversize list', () => {
    expect(parse({ q: 'a\u0000b' }).success).toBe(false);
    expect(parse({ resourceType: 'x\u0007' }).success).toBe(false);
    expect(parse({ actorVia: 'session,browser' }).success).toBe(false);
    expect(parse({ from: 'yesterday' }).success).toBe(false);
    expect(parse({ action: "presentation.'; drop table audit_log; --" }).success).toBe(false);
    expect(parse({ action: Array.from({ length: 21 }, (_, i) => `a${i}.x`).join(',') }).success).toBe(false);
    expect(parse({ actor: '' }).success).toBe(false);
  });
});

describe('the free-text pattern', () => {
  it('escapes the LIKE wildcards so typed text matches itself', () => {
    expect(escapeLike('50%_done\\')).toBe('50\\%\\_done\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('the action list', () => {
  it('splits families from exact actions and drops blanks and repeats', () => {
    expect(parseActionList('presentation.,apikey.create, ,apikey.create,member.')).toEqual({
      exact: ['apikey.create'],
      families: ['presentation.', 'member.']
    });
  });

  it('splits and de-duplicates the via list', () => {
    expect(parseViaList('session,api_key,session')).toEqual(['session', 'api_key']);
  });
});

describe('the cursor', () => {
  it('serves page 1 for a missing, malformed or out-of-range cursor', () => {
    expect(cursorId(undefined)).toBeNull();
    expect(cursorId('banana')).toBeNull();
    expect(cursorId('0')).toBeNull();
    expect(cursorId('99999999999999999999')).toBeNull();
    expect(cursorId('42')).toBe(42);
  });
});

describe('the WHERE conditions', () => {
  const dialect = new PgDialect();
  const render = (conditions: SQL[]) => dialect.sqlToQuery(and(...conditions)!);

  it('is empty when nothing filters', () => {
    const parsed = parse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(auditFilterConditions(parsed.data)).toEqual([]);
  });

  it('binds every value as a parameter and never inlines it into the SQL text', () => {
    const parsed = parse({
      q: "o'neil%",
      action: 'presentation.,apikey.create',
      actorVia: 'session,api_key',
      actor: 'user-1',
      resourceType: 'presentation',
      resourceId: 'deck-1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-19T00:00:00.000Z'
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const conditions = auditFilterConditions(parsed.data);
    // one condition per filter, AND-ed by the route
    expect(conditions).toHaveLength(8);
    const { sql: text, params } = render(conditions);
    expect(text).not.toContain("o'neil");
    expect(text).not.toContain('presentation');
    expect(text).not.toContain('user-1');
    expect(text).toMatch(/ilike/i);
    expect(params).toContain("%o'neil\\%%");
    expect(params).toContain('presentation.%');
    expect(params).toContain('apikey.create');
    expect(params).toContain('session');
    expect(params).toContain('api_key');
    expect(params).toContain('user-1');
    expect(params).toContain('presentation');
    expect(params).toContain('deck-1');
    // the two instants ride as parameters too, in the driver's own shape
    expect(params.filter((p) => typeof p === 'string' && p.startsWith('2026-09-'))).toHaveLength(2);
  });

  it('turns `system` into an IS NULL on the actor and keeps a user id as an equality', () => {
    const system = parse({ actor: 'system' });
    const user = parse({ actor: 'abc' });
    expect(system.success && user.success).toBe(true);
    if (!system.success || !user.success) return;
    const nullCheck = render(auditFilterConditions(system.data));
    const equality = render(auditFilterConditions(user.data));
    expect(nullCheck.sql).toMatch(/actor_user_id" is null/);
    expect(nullCheck.params).toEqual([]);
    expect(equality.sql).toMatch(/actor_user_id" = \$1/);
    expect(equality.params).toEqual(['abc']);
  });
});
