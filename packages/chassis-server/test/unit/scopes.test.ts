import { describe, expect, it } from 'vitest';
import { createScopeAllowlist } from '../../src/middleware/scopes.js';

/**
 * The chassis team routes in the fail-closed machine allowlist (PRDCT-2813):
 * EXACT shapes and methods only. A method the route does not serve on a listed
 * shape answers null (the gate's 403 `endpoint_not_allowed`), so a future
 * handler on that shape stays unreachable to keys and tokens until opened
 * consciously (verifier round 1, mutation #12: POST on the member path).
 */
const requiredScopeFor = createScopeAllowlist({ read: 'r', write: 'w', dataExport: 'x', rules: [] });
const TEAM = '/api/v1/teams/11111111-2222-3333-4444-555555555555';

describe('requiredScopeFor — teams (PRDCT-2813)', () => {
  it('the list: GET under the read scope, POST under the write scope', () => {
    expect(requiredScopeFor('/api/v1/teams', 'GET')).toBe('r');
    expect(requiredScopeFor('/api/v1/teams', 'POST')).toBe('w');
  });

  it('the seat of one person: DELETE under the write scope, every other method closed', () => {
    const seat = `${TEAM}/members/user-abc`;
    expect(requiredScopeFor(seat, 'DELETE')).toBe('w');
    expect(requiredScopeFor(seat, 'POST')).toBeNull();
    expect(requiredScopeFor(seat, 'PUT')).toBeNull();
    expect(requiredScopeFor(seat, 'PATCH')).toBeNull();
  });

  it('the roster: GET under the read scope, PUT closed', () => {
    expect(requiredScopeFor(`${TEAM}/members`, 'GET')).toBe('r');
    expect(requiredScopeFor(`${TEAM}/members`, 'PUT')).toBeNull();
  });

  it('a team id that is not a uuid is not a listed shape', () => {
    expect(requiredScopeFor('/api/v1/teams/not-a-uuid', 'GET')).toBeNull();
  });
});

describe('requiredScopeFor — members stay closed to machines (ADR 014, PRDCT-2816)', () => {
  const MEMBER = '/api/v1/members/11111111-2222-3333-4444-555555555555';

  it('the account deletion and the removal are UNLISTED for every method: sessions only', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(MEMBER, method)).toBeNull();
      expect(requiredScopeFor(`${MEMBER}/remove`, method)).toBeNull();
    }
  });
});

describe('requiredScopeFor — the default workspace (PRDCT-2815)', () => {
  const PATH = '/api/v1/me/default-workspace';

  it('PUT is listed under the write scope', () => {
    expect(requiredScopeFor(PATH, 'PUT')).toBe('w');
  });

  it('every other method on the path stays unlisted', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(PATH, method)).toBeNull();
    }
  });

  it('a longer path and any other path under /me stay unlisted for PUT', () => {
    expect(requiredScopeFor(`${PATH}/x`, 'PUT')).toBeNull();
    expect(requiredScopeFor('/api/v1/me/anything', 'PUT')).toBeNull();
  });
});
