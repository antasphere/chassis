import { describe, expect, it } from 'vitest';
import { open, seal } from '@antasphere/chassis-server/middleware';

/**
 * The replay cache stores response bodies AES-256-GCM encrypted because they
 * carry one-shot secrets. seal/open must round-trip, and open must fail
 * CLOSED (null, never throw or return garbage) on tamper or a wrong key —
 * that null is what turns an AUTH_SECRET rotation into a clean re-execute.
 */

const SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';
const BODY = JSON.stringify({ apiKey: { id: 'x' }, key: 'key_abcd1234_supersecret' });

describe('idempotency seal/open (AES-256-GCM)', () => {
  it('round-trips a response body', () => {
    const sealed = seal(BODY, SECRET);
    expect(open(sealed, SECRET)).toBe(BODY);
  });

  it('produces the iv.ciphertext.tag shape without leaking the plaintext', () => {
    const sealed = seal(BODY, SECRET);
    expect(sealed.split('.')).toHaveLength(3);
    expect(sealed).not.toContain('supersecret');
    // Fresh iv per seal: the same plaintext never encrypts to the same blob.
    expect(seal(BODY, SECRET)).not.toBe(sealed);
  });

  it('returns null on tampered ciphertext', () => {
    const sealed = seal(BODY, SECRET);
    const [iv, ciphertext, tag] = sealed.split('.') as [string, string, string];
    const flipped = ciphertext.startsWith('A') ? `B${ciphertext.slice(1)}` : `A${ciphertext.slice(1)}`;
    expect(open(`${iv}.${flipped}.${tag}`, SECRET)).toBeNull();
  });

  it('returns null under a different key (rotated AUTH_SECRET)', () => {
    const sealed = seal(BODY, SECRET);
    expect(open(sealed, 'another-secret-entirely-9876543210')).toBeNull();
  });

  it('returns null on malformed input', () => {
    expect(open('not-a-sealed-payload', SECRET)).toBeNull();
    expect(open('a.b', SECRET)).toBeNull();
    expect(open('', SECRET)).toBeNull();
  });
});
