import { and, eq } from 'drizzle-orm';
import { account, type Db } from '@antasphere/chassis-db';
import { HUB_SSO_PROVIDER_ID } from '../identity/hub-sso.js';

/** How many users the cache may hold before a miss sweeps the expired entries. */
const SWEEP_ABOVE = 5_000;

/** The cache behind `hubSubjectResolver`, exported so its bound can be tested without a database. */
export interface HubSubjectCache {
  resolve(userId: string): Promise<string | null>;
  readonly size: number;
  clear(): void;
}

/**
 * A per-user TTL cache over a hub-subject lookup. A miss (a user with no hub
 * link) is cached too. The map used to be unbounded: on a long-lived replica
 * serving many API-key principals it held one entry per distinct user that
 * ever performed a metered action, for the life of the process (PRDCT-2654).
 * It is now swept the way `profiles.ts` sweeps its plan cache: whenever it
 * holds more than `sweepAbove` entries at the moment a miss is about to be
 * written, every expired entry (`until <= now`) is deleted first.
 */
export function hubSubjectCache(
  lookup: (userId: string) => Promise<string | null>,
  opts: { ttlMs?: number; sweepAbove?: number; now?: () => number } = {}
): HubSubjectCache {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const sweepAbove = opts.sweepAbove ?? SWEEP_ABOVE;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { sub: string | null; until: number }>();
  const sweep = (at: number): void => {
    if (cache.size <= sweepAbove) return;
    for (const [key, entry] of cache) {
      if (entry.until <= at) cache.delete(key);
    }
  };
  return {
    async resolve(userId) {
      const hit = cache.get(userId);
      if (hit && hit.until > now()) return hit.sub;
      const sub = await lookup(userId);
      const at = now();
      sweep(at);
      cache.set(userId, { sub, until: at + ttlMs });
      return sub;
    },
    get size() {
      return cache.size;
    },
    clear() {
      cache.clear();
    }
  };
}

/**
 * The hub user behind a local user (the billing rail, PRDCT-2625): a usage
 * event reports the hub's `sub`, which the SSO link stores as the account
 * row's `accountId` under the `antasphere` provider. A user with no hub link
 * (the cloud operator, a local invitee) reports null — the hub would refuse
 * a local id as `unknown_user`. Cached per user for `ttlMs` through
 * `hubSubjectCache` (bounded by its sweep); a miss is cached too (the
 * operator uploads as much as anyone).
 */
export function hubSubjectResolver(db: Db, ttlMs = 5 * 60_000): (userId: string) => Promise<string | null> {
  const dbLookup = async (userId: string): Promise<string | null> => {
    const [row] = await db
      .select({ sub: account.accountId })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .limit(1);
    return row?.sub ?? null;
  };
  const cache = hubSubjectCache(dbLookup, { ttlMs });
  return (userId) => cache.resolve(userId);
}
