import { describe, expect, it } from 'vitest';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { EntitlementService, Principal, RequestQuota } from '@antasphere/chassis-contract';
import { createRequestQuota, principalBucketKey } from '@antasphere/chassis-server/middleware';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * The general per-principal quota service: bucket keys derive from the
 * AUTHENTICATED principal identity only, limits come from the
 * EntitlementService seam, and backend/entitlement failures fail OPEN (the
 * quota is a cost control, not an authz boundary).
 */

const noopLogger = { error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    email: 'u@example.test',
    name: 'U',
    workspaceId: 'ws-1',
    role: 'member',
    origin: 'local',
    via: 'session',
    scopes: null,
    ...overrides
  };
}

function stubEntitlements(quota: RequestQuota | (() => RequestQuota)): EntitlementService {
  return {
    check: async () => ({ allowed: true }),
    getRequestQuota: async () => (typeof quota === 'function' ? quota() : quota)
  };
}

const memoryMake = (prefix: string, points: number, duration: number) =>
  new RateLimiterMemory({ keyPrefix: `rl:${prefix}`, points, duration });

describe('principalBucketKey', () => {
  it('keys API-key principals by the key id, not the user', () => {
    const p = principal({ via: 'api_key', apiKeyId: 'key-abc', scopes: new Set(['things:read']) });
    expect(principalBucketKey(p)).toBe('key:key-abc');
  });

  it('keys OAuth principals by the token subject (userId)', () => {
    const p = principal({ via: 'oauth', scopes: new Set(['things:read']) });
    expect(principalBucketKey(p)).toBe('oauth:user-1');
  });

  it('keys session principals by the user id', () => {
    expect(principalBucketKey(principal())).toBe('session:user-1');
  });

  it('gives two API keys of the same user distinct buckets', () => {
    const a = principal({ via: 'api_key', apiKeyId: 'key-a', scopes: new Set() });
    const b = principal({ via: 'api_key', apiKeyId: 'key-b', scopes: new Set() });
    expect(principalBucketKey(a)).not.toBe(principalBucketKey(b));
  });
});

describe('createRequestQuota', () => {
  it('trips at the sustained threshold with a retry hint and recovers headers state', async () => {
    const quota = createRequestQuota({
      entitlements: stubEntitlements({ perMinute: 3, burstPerSecond: 0 }),
      make: memoryMake,
      logger: noopLogger
    });
    const p = principal();

    for (let i = 0; i < 3; i++) {
      const d = await quota.consume(p);
      expect(d?.ok).toBe(true);
      expect(d?.limit).toBe(3);
      expect(d?.remaining).toBe(2 - i);
    }

    const rejected = await quota.consume(p);
    expect(rejected?.ok).toBe(false);
    expect(rejected?.remaining).toBe(0);
    expect(rejected?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rejected?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('isolates principals: A exhausted, B unaffected', async () => {
    const quota = createRequestQuota({
      entitlements: stubEntitlements({ perMinute: 2, burstPerSecond: 0 }),
      make: memoryMake,
      logger: noopLogger
    });
    const keyA = principal({ via: 'api_key', apiKeyId: 'key-a', scopes: new Set() });
    const keyB = principal({ via: 'api_key', apiKeyId: 'key-b', scopes: new Set() });

    await quota.consume(keyA);
    await quota.consume(keyA);
    expect((await quota.consume(keyA))?.ok).toBe(false);
    expect((await quota.consume(keyB))?.ok).toBe(true);
  });

  it('returns null (disabled) when perMinute is 0', async () => {
    const quota = createRequestQuota({
      entitlements: stubEntitlements({ perMinute: 0, burstPerSecond: 100 }),
      make: memoryMake,
      logger: noopLogger
    });
    expect(await quota.consume(principal())).toBeNull();
  });

  it('caps 1-second spikes without burning sustained points, and a fresh window recovers', async () => {
    const quota = createRequestQuota({
      entitlements: stubEntitlements({ perMinute: 100, burstPerSecond: 2 }),
      make: memoryMake,
      logger: noopLogger
    });
    const p = principal();

    expect((await quota.consume(p))?.ok).toBe(true);
    expect((await quota.consume(p))?.ok).toBe(true);

    const spiked = await quota.consume(p);
    expect(spiked?.ok).toBe(false);
    expect(spiked?.retryAfterSeconds).toBe(1);
    // The rejected spike reported the sustained bucket untouched: 2 consumed.
    expect(spiked?.remaining).toBe(98);

    await new Promise((r) => setTimeout(r, 1100));
    const recovered = await quota.consume(p);
    expect(recovered?.ok).toBe(true);
    // 3 sustained points consumed in total — the 429 burned none.
    expect(recovered?.remaining).toBe(97);
  });

  it('fails open (null) when the entitlement lookup throws', async () => {
    const quota = createRequestQuota({
      entitlements: {
        check: async () => ({ allowed: true }),
        getRequestQuota: async () => {
          throw new Error('plan service down');
        }
      },
      make: memoryMake,
      logger: noopLogger
    });
    expect(await quota.consume(principal())).toBeNull();
  });
});
