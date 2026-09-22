import { and, eq } from 'drizzle-orm';
import { account, type Db } from '@antasphere/chassis-db';
import { HUB_SSO_PROVIDER_ID } from '../identity/hub-sso.js';

/**
 * The hub user behind a local user (the billing rail, PRDCT-2625): a usage
 * event reports the hub's `sub`, which the SSO link stores as the account
 * row's `accountId` under the `antasphere` provider. A user with no hub link
 * (the cloud operator, a local invitee) reports null — the hub would refuse
 * a local id as `unknown_user`. Cached per user for `ttlMs`; a miss is
 * cached too (the operator uploads as much as anyone).
 */
export function hubSubjectResolver(db: Db, ttlMs = 5 * 60_000): (userId: string) => Promise<string | null> {
  const cache = new Map<string, { sub: string | null; until: number }>();
  return async (userId) => {
    const hit = cache.get(userId);
    if (hit && hit.until > Date.now()) return hit.sub;
    const [row] = await db
      .select({ sub: account.accountId })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .limit(1);
    const sub = row?.sub ?? null;
    cache.set(userId, { sub, until: Date.now() + ttlMs });
    return sub;
  };
}
