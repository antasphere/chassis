import { describe, expect, it } from 'vitest';
import { sanitizeEntryName } from '@antasphere/chassis-server/api';

/**
 * Zip-slip guard: export entry names embed the user-supplied originalName.
 * A hostile name must never yield a path separator (entry escaping the
 * extraction directory) or control characters, and must stay bounded.
 */
describe('export sanitizeEntryName (zip-slip guard)', () => {
  it('neutralizes path traversal and separators', () => {
    expect(sanitizeEntryName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeEntryName('..\\..\\windows\\system32')).toBe('.._.._windows_system32');
    expect(sanitizeEntryName('a/b\\c')).toBe('a_b_c');
  });

  it('strips control characters', () => {
    expect(sanitizeEntryName('a\u0000b\u001fc\u007fd')).toBe('a_b_c_d');
  });

  it('never returns an empty name', () => {
    expect(sanitizeEntryName('')).toBe('file');
  });

  it('caps the length at 150', () => {
    expect(sanitizeEntryName('x'.repeat(500))).toHaveLength(150);
  });
});
