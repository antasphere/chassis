import type { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { onboardingDismissRoute } from '@antasphere/chassis-contract/routes';
import { userOnboarding, type Db } from '@antasphere/chassis-db';
import type { Auth } from '../identity/better-auth.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /me/onboarding/dismiss — the explicit act that hides the first-run
 * welcome (SL-6, cloud edition ONLY; api/index.ts registers this module iff
 * the instance boots EDITION=cloud, so oss answers the JSON 404 terminator).
 *
 * Session-only, same construction as /sso/logout: the path is deliberately
 * UNLISTED in the fail-closed scope allowlist (middleware/scopes.ts) — every
 * API key / OAuth bearer 403s in authContext before this runs — and the
 * session resolves ROUTE-LOCALLY (the /me zero-state pattern) so a
 * zero-membership session can dismiss too.
 *
 * The upsert is idempotent and preserves the FIRST dismissal timestamp: a
 * second dismiss (double-click, replayed request) changes nothing. Only this
 * route (and the deploy backfill) ever sets dismissed_at — the login path's
 * lazy insert writes NULL — so `firstRunPending` flips exactly on the user's
 * explicit act, retry-safe on every other path.
 */

export interface OnboardingRouteDeps {
  db: Db;
  auth: Auth;
}

export function registerOnboardingRoutes(api: OpenAPIHono, deps: OnboardingRouteDeps): void {
  const { db, auth } = deps;

  api.openapi(onboardingDismissRoute, async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }
    await db
      .insert(userOnboarding)
      .values({ userId: session.user.id, dismissedAt: new Date() })
      .onConflictDoUpdate({
        target: userOnboarding.userId,
        // Keep an earlier dismissal's timestamp; fill only a NULL.
        set: { dismissedAt: sql`coalesce(${userOnboarding.dismissedAt}, excluded.dismissed_at)` }
      });
    return c.json({ dismissed: true as const }, 200);
  });
}
