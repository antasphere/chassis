import { describe, expect, it } from 'vitest';
import { refusalDescription } from '../../src/identity/hub-grant.js';

/**
 * PRDCT-3584. The hub's `invalid_grant` has four causes at the pinned
 * plugin (unknown token, expired, rotated out, refused by the pre-flight)
 * and the tool used to drop the sentence that tells them apart. The reader
 * keeps it for the log line, bounded and trimmed, and nothing else.
 */
describe('refusalDescription', () => {
  it('reads a non-empty error_description', () => {
    expect(refusalDescription({ error: 'invalid_grant', error_description: 'session not found' })).toBe(
      'session not found'
    );
  });
  it('trims and bounds it', () => {
    expect(refusalDescription({ error_description: '  invalid refresh token \n' })).toBe(
      'invalid refresh token'
    );
    expect(refusalDescription({ error_description: 'x'.repeat(1000) })?.length).toBe(300);
  });
  it('answers null for anything else', () => {
    expect(refusalDescription({ error: 'invalid_grant' })).toBeNull();
    expect(refusalDescription({ error_description: '' })).toBeNull();
    expect(refusalDescription({ error_description: 42 })).toBeNull();
    expect(refusalDescription(null)).toBeNull();
    expect(refusalDescription('invalid_grant')).toBeNull();
  });
});
