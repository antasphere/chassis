import { describe, expect, it } from 'vitest';
import { parseSuperadminEmails } from '@antasphere/chassis-server/accounts';

describe('parseSuperadminEmails', () => {
  it('returns an empty set (dormant) for undefined and blank input', () => {
    expect(parseSuperadminEmails(undefined).size).toBe(0);
    expect(parseSuperadminEmails('').size).toBe(0);
    expect(parseSuperadminEmails('   ').size).toBe(0);
  });

  it('parses a comma-separated list, trimming and lowercasing entries', () => {
    const set = parseSuperadminEmails(' Ops@Example.com ,root@host.io ');
    expect(set.size).toBe(2);
    expect(set.has('ops@example.com')).toBe(true);
    expect(set.has('root@host.io')).toBe(true);
    // Matching is on the lowercased form only.
    expect(set.has('Ops@Example.com')).toBe(false);
  });

  it('dedupes case-variant duplicates', () => {
    const set = parseSuperadminEmails('a@b.co,A@B.CO');
    expect(set.size).toBe(1);
  });

  it('throws LOUDLY on malformed entries (a typo must never silently disarm)', () => {
    expect(() => parseSuperadminEmails('not-an-email')).toThrow(/not a valid email/);
    expect(() => parseSuperadminEmails('ok@example.com,broken')).toThrow(/broken/);
    expect(() => parseSuperadminEmails('a b@example.com')).toThrow(/not a valid email/);
    // Only separators, no entries: refuse rather than arm an empty list.
    expect(() => parseSuperadminEmails(',,')).toThrow(/at least one email/);
  });
});
