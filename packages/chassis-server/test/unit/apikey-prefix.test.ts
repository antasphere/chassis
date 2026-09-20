import { describe, expect, it } from 'vitest';
import type { Db } from '@antasphere/chassis-db';
import { ApiKeyService, buildPepperRegistry } from '@antasphere/chassis-server/apikeys';

/**
 * The key prefix is the tool's, and the service builds its key pattern from
 * it. A prefix is matched LITERALLY: a RegExp metacharacter in it (`a.b`) must
 * never widen the pattern, or a bearer of another shape (`axb_…`) would be
 * taken for an API key of this tool. `isToken` is the shape check alone (no
 * lookup), so no database is needed here; `resolve` reads the same pattern.
 */
const KEY_ID = 'AAAAAAAA';
const SECRET = 'a'.repeat(43);
const peppers = buildPepperRegistry('unit-auth-secret-0123456789abcdef0123456789abcdef');
const service = (prefix: string) => new ApiKeyService(undefined as unknown as Db, peppers, prefix);

describe('ApiKeyService key prefix', () => {
  it('matches a prefix holding a RegExp metacharacter literally', () => {
    const keys = service('a.b');
    expect(keys.isToken(`a.b_${KEY_ID}_${SECRET}`)).toBe(true);
    expect(keys.isToken(`axb_${KEY_ID}_${SECRET}`)).toBe(false);
  });

  it('accepts its own prefix only, in the fixed shape', () => {
    const keys = service('thg');
    expect(keys.isToken(`thg_${KEY_ID}_${SECRET}`)).toBe(true);
    expect(keys.isToken(`other_${KEY_ID}_${SECRET}`)).toBe(false);
    expect(keys.isToken(`thg_${KEY_ID}`)).toBe(false);
  });

  it('refuses to be built without a prefix', () => {
    expect(() => service('')).toThrow('the key prefix is required');
  });
});
