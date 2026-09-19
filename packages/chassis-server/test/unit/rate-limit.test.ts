import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { makeClientIp } from '@antasphere/chassis-server/middleware';

/**
 * makeClientIp reads the RIGHTMOST x-forwarded-for hop (the one the trusted
 * proxy appended/set) — the leftmost is client-claimed and spoofable. The
 * stub has no socket, so getConnInfo throws and the fallback is 'unknown'.
 */
function stubContext(xff?: string): Context {
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : undefined)
    }
  } as unknown as Context;
}

describe('makeClientIp (rightmost XFF hop)', () => {
  it('picks the rightmost hop when TRUST_PROXY is on', () => {
    const clientIp = makeClientIp(true);
    expect(clientIp(stubContext('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('returns the single hop when there is only one', () => {
    const clientIp = makeClientIp(true);
    expect(clientIp(stubContext('203.0.113.9'))).toBe('203.0.113.9');
  });

  it('trims whitespace around the selected hop', () => {
    const clientIp = makeClientIp(true);
    expect(clientIp(stubContext('a,   203.0.113.9  '))).toBe('203.0.113.9');
  });

  it('ignores x-forwarded-for entirely when TRUST_PROXY is off', () => {
    const clientIp = makeClientIp(false);
    // Header ignored → no socket in the stub → 'unknown' fallback.
    expect(clientIp(stubContext('6.6.6.6, 203.0.113.9'))).toBe('unknown');
  });
});
