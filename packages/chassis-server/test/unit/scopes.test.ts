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
