import { describe, expect, it } from 'vitest';
import { buildPepperRegistry, parseApiKeyPeppers } from '@antasphere/chassis-server/apikeys';
import { buildEnvSchema } from '@antasphere/chassis-server/env';

// The chassis schema alone: API_KEY_PEPPERS is a chassis key.
const envSchema = buildEnvSchema({ version: '0.0.0-test' });

const AUTH_SECRET = 'unit-auth-secret-0123456789abcdef0123456789abcdef';
const SECRET_A = 'pepper-secret-a-0123456789abcdef0123456789abcdef';
const SECRET_B = 'pepper-secret-b-0123456789abcdef0123456789abcdef';

describe('buildPepperRegistry', () => {
  it('zero-config: registry is exactly { 1: authSecret }, current = 1', () => {
    const registry = buildPepperRegistry(AUTH_SECRET);
    expect(registry.current).toBe(1);
    expect(registry.v1Pinned).toBe(false);
    // Version 1 IS the auth secret verbatim — the pre-versioning pepper.
    expect(registry.get(1)).toBe(AUTH_SECRET);
    expect(registry.get(2)).toBeUndefined();
    expect(registry.get(0)).toBeUndefined();
  });

  it('adding a version keeps v1 = authSecret and mints under the highest', () => {
    const registry = buildPepperRegistry(AUTH_SECRET, `2:${SECRET_A}`);
    expect(registry.current).toBe(2);
    expect(registry.v1Pinned).toBe(false);
    expect(registry.get(1)).toBe(AUTH_SECRET);
    expect(registry.get(2)).toBe(SECRET_A);
  });

  it('pinning version 1 overrides the AUTH_SECRET default (the rotation prerequisite)', () => {
    const registry = buildPepperRegistry(
      'rotated-auth-secret-now-something-else-entirely',
      `1:${SECRET_A};2:${SECRET_B}`
    );
    expect(registry.current).toBe(2);
    expect(registry.v1Pinned).toBe(true);
    expect(registry.get(1)).toBe(SECRET_A);
    expect(registry.get(2)).toBe(SECRET_B);
  });

  it('current is the highest version regardless of entry order', () => {
    const registry = buildPepperRegistry(AUTH_SECRET, `3:${SECRET_B};2:${SECRET_A}`);
    expect(registry.current).toBe(3);
  });

  it('an unknown version yields undefined — the caller fails closed', () => {
    const registry = buildPepperRegistry(AUTH_SECRET, `2:${SECRET_A}`);
    expect(registry.get(7)).toBeUndefined();
  });
});

describe('parseApiKeyPeppers', () => {
  it('tolerates whitespace and trailing separators', () => {
    const map = parseApiKeyPeppers(` 1:${SECRET_A}; 2:${SECRET_B} ;`);
    expect(map.get(1)).toBe(SECRET_A);
    // Trailing whitespace after the secret survives the entry trim only at
    // the edges — the secret itself is taken verbatim after the first colon.
    expect(map.get(2)).toBe(`${SECRET_B}`);
  });

  it('splits each entry at the FIRST colon so secrets may contain colons', () => {
    const secretWithColon = `left:${SECRET_A}`;
    const map = parseApiKeyPeppers(`2:${secretWithColon}`);
    expect(map.get(2)).toBe(secretWithColon);
  });

  it.each([
    ['no colon', 'abcdef'],
    ['empty version', `:${SECRET_A}`],
    ['non-integer version', `two:${SECRET_A}`],
    ['version 0', `0:${SECRET_A}`],
    ['version beyond smallint', `32768:${SECRET_A}`],
    ['duplicate version', `2:${SECRET_A};2:${SECRET_B}`],
    ['short secret', '2:tooshort'],
    ['only separators', ' ; ; ']
  ])('rejects %s', (_label, raw) => {
    expect(() => parseApiKeyPeppers(raw)).toThrow();
  });

  it('never echoes the secret in the duplicate/short error messages', () => {
    try {
      parseApiKeyPeppers(`2:${SECRET_A};2:${SECRET_B}`);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET_A);
      expect((err as Error).message).not.toContain(SECRET_B);
    }
  });
});

describe('env schema API_KEY_PEPPERS', () => {
  const minimal = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('is optional and blank means unset (compose VAR= convention)', () => {
    expect(envSchema.parse(minimal).API_KEY_PEPPERS).toBeUndefined();
    expect(envSchema.parse({ ...minimal, API_KEY_PEPPERS: '' }).API_KEY_PEPPERS).toBeUndefined();
    expect(envSchema.parse({ ...minimal, API_KEY_PEPPERS: '  ' }).API_KEY_PEPPERS).toBeUndefined();
  });

  it('accepts a valid map and preserves it verbatim', () => {
    const raw = `1:${SECRET_A};2:${SECRET_B}`;
    expect(envSchema.parse({ ...minimal, API_KEY_PEPPERS: raw }).API_KEY_PEPPERS).toBe(raw);
  });

  it('refuses boot on a malformed value', () => {
    const result = envSchema.safeParse({ ...minimal, API_KEY_PEPPERS: '2:tooshort' });
    expect(result.success).toBe(false);
  });
});
