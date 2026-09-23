import { describe, expect, it, vi } from 'vitest';
import { hubSubjectCache } from '../../src/entitlements/hub-subject.js';

/**
 * The hub-subject cache (PRDCT-2654): a per-user TTL cache over the SSO link
 * lookup, a miss cached too, and bounded on a long-lived replica by a sweep
 * of the expired entries once it holds more than `sweepAbove` users.
 */

function setup(opts: { ttlMs?: number; sweepAbove?: number } = {}) {
  let clock = 1_000_000;
  const subs = new Map<string, string>([
    ['u1', 'sub-1'],
    ['u2', 'sub-2']
  ]);
  const lookup = vi.fn(async (userId: string) => subs.get(userId) ?? null);
  const cache = hubSubjectCache(lookup, { ttlMs: 1_000, ...opts, now: () => clock });
  return {
    cache,
    lookup,
    subs,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

describe('hubSubjectCache', () => {
  it('serves a hit within the TTL without calling the lookup', async () => {
    const { cache, lookup, advance } = setup();
    expect(await cache.resolve('u1')).toBe('sub-1');
    advance(999);
    expect(await cache.resolve('u1')).toBe('sub-1');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too', async () => {
    const { cache, lookup } = setup();
    expect(await cache.resolve('local-operator')).toBeNull();
    expect(await cache.resolve('local-operator')).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('overwrites an expired entry on the next read', async () => {
    const { cache, lookup, subs, advance } = setup();
    expect(await cache.resolve('u1')).toBe('sub-1');
    subs.set('u1', 'sub-1-relinked');
    advance(1_000);
    expect(await cache.resolve('u1')).toBe('sub-1-relinked');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });

  it('sweeps the expired entries once it holds more than sweepAbove users, keeping the live ones', async () => {
    const { cache, advance } = setup({ sweepAbove: 3 });
    for (const u of ['a', 'b', 'c']) await cache.resolve(u);
    advance(600);
    await cache.resolve('live'); // written at +600, lives until +1600
    expect(cache.size).toBe(4);
    advance(500); // a, b, c expired (until +1000); 'live' has 500 ms left
    await cache.resolve('d');
    expect(cache.size).toBe(2);
    advance(1);
    const before = cache.size;
    await cache.resolve('live');
    expect(cache.size).toBe(before);
  });

  it('does not sweep at or below the threshold', async () => {
    const { cache, advance } = setup({ sweepAbove: 3 });
    for (const u of ['a', 'b']) await cache.resolve(u);
    advance(2_000);
    await cache.resolve('c');
    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
