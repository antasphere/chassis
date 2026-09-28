import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import {
  demoPassesListRoute,
  demoPassMintRoute,
  demoPassRevokeRoute
} from '@antasphere/chassis-contract/routes';
import { DEMO_PASS_DEFAULT_MINUTES } from '@antasphere/chassis-contract';
import { user as userTable, workspaceMembers, type Db } from '@antasphere/chassis-db';
import type { MiddlewareHandler } from 'hono';
import type { Env, HubConfig } from '../env.js';
import type { Logger } from '../logger.js';
import { mintRefusal } from '../accounts/mint-refusal.js';
import { requireRole } from '../middleware/auth-context.js';
import { DemoPassService, demoPassToWire } from '../identity/demo-pass.js';
import { isDemoAddress, isSafeDemoPath, parseDemoEmailDomains } from '../identity/demo-pass-rules.js';

/**
 * The owner's demo pass routes (the demo pass spec, section 4): mint, list,
 * revoke. Registered by create-api.ts ONLY while `demoSignInOn` says so;
 * otherwise the three paths are unknown paths and answer the JSON 404 like
 * any other. The redeem is not here: it is an endpoint of the sign-in
 * library (identity/demo-pass-plugin.ts), so the library's own cookie and
 * hooks apply to it.
 *
 * Owner and session only. A machine credential never reaches a handler (the
 * paths are unlisted in the fail-closed scope allowlist, so an API key or an
 * OAuth bearer answers 403 at the gate); the `sessions_only` check below is
 * the second lock, should the allowlist ever open them.
 */

export interface DemoPassRouteDeps {
  db: Db;
  publicBaseUrl: string;
  /** `DEMO_SIGN_IN_EMAIL_DOMAINS`, raw (validated at boot). */
  emailDomains: string | undefined;
  /** The tool's `guest_target` sentence (`copy.guestTarget`), for the shared mint refusal. */
  guestTargetMessage: string;
}

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * The one switch of the chassis half: DEMO_SIGN_IN on AND the self-hosted
 * edition (on cloud the hub owns identity, so the chassis registers no demo
 * route and mints nothing). Says so once in the boot log either way the
 * switch is on: a `warn` naming the host while it works, a line saying it
 * does nothing on cloud.
 */
export function demoSignInOn(
  env: Pick<Env, 'DEMO_SIGN_IN' | 'PUBLIC_BASE_URL'>,
  hub: HubConfig | null,
  logger: Logger
): boolean {
  if (!env.DEMO_SIGN_IN) return false;
  if (hub) {
    logger.warn('DEMO_SIGN_IN is on but has no effect on the cloud edition: identity is the hub’s');
    return false;
  }
  logger.warn(
    { host: new URL(env.PUBLIC_BASE_URL).host },
    'DEMO_SIGN_IN is on: owners can mint demo links that sign a member in without a password'
  );
  return true;
}

/**
 * The credential resolver's judge (identity/demo-pass.ts `judgeSession`): a
 * session a pass opened lives only while its pass does, and carries the
 * pass's id for the audit trail. Handed to `authContext` only while the
 * switch is on, so an instance without it pays no lookup.
 */
export function demoSessionJudge(
  db: Db
): (headers: Headers) => Promise<{ passId: string; sessionId: string } | 'ended' | null> {
  const service = new DemoPassService(db);
  return (headers) => service.judgeSession(headers);
}

/** The second lock behind the scope allowlist: a pass is minted from a browser session only. */
const sessionsOnly = (): MiddlewareHandler => async (c, next) => {
  const principal = c.get('principal');
  if (principal && principal.via !== 'session') {
    return c.json(err('sessions_only', 'Demo passes are managed from a browser session only'), 403);
  }
  // A session a demo link opened manages no demo link, whoever it signed in:
  // an owner may make a link for themself, and whoever holds that link must
  // not be able to make more of them, or to read and revoke the others.
  if (c.get('demoPassId')) {
    return c.json(
      err(
        'demo_session',
        'A session opened by a demo link cannot manage demo links: sign in with your password'
      ),
      403
    );
  }
  return next();
};

export function registerDemoPassRoutes(api: OpenAPIHono, deps: DemoPassRouteDeps): void {
  const { db, publicBaseUrl } = deps;
  const service = new DemoPassService(db);
  const extraDomains = parseDemoEmailDomains(deps.emailDomains);
  const base = publicBaseUrl.replace(/\/+$/, '');

  // Two patterns, both gated: `/demo/passes/:id` is a second segment the
  // collection gate does not cover (LESSONS.md, the 3-segment reset-link).
  for (const path of ['/demo/passes', '/demo/passes/:id']) {
    api.use(path, requireRole('owner'));
    api.use(path, sessionsOnly());
  }

  api.openapi(demoPassesListRoute, async (c) => {
    const principal = c.get('principal')!;
    const passes = await service.list(principal.workspaceId);
    return c.json({ passes: passes.map(demoPassToWire) }, 200);
  });

  api.openapi(demoPassMintRoute, async (c) => {
    const principal = c.get('principal')!;
    const body = c.req.valid('json');

    // The refusals, in the spec's order (section 4). Better Auth stores
    // addresses lowercased; the member is looked up among the ACTIVE members
    // of the caller's workspace only, so no other tenant's address is probed.
    const [target] = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        origin: workspaceMembers.origin,
        email: userTable.email,
        twoFactorEnabled: userTable.twoFactorEnabled
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(userTable.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          eq(workspaceMembers.isActive, true),
          eq(userTable.email, body.email.toLowerCase())
        )
      )
      .limit(1);
    if (!target) {
      return c.json(err('no_such_member', 'No member of this workspace holds that address'), 404);
    }
    if (target.role === 'owner' && target.userId !== principal.userId) {
      return c.json(err('owner_target', 'A demo link cannot open another owner’s account'), 403);
    }
    if (!isDemoAddress(target.email, extraDomains)) {
      return c.json(
        err(
          'demo_address_required',
          'A demo link opens only a demonstration address: a reserved example or test domain, or one listed in DEMO_SIGN_IN_EMAIL_DOMAINS'
        ),
        403
      );
    }
    if (target.twoFactorEnabled) {
      return c.json(
        err('two_factor_enrolled', 'This account has a second factor: a demo link would walk past it'),
        403
      );
    }
    const refusal = await mintRefusal(db, deps.guestTargetMessage, principal, target);
    if (refusal) return c.json(err(refusal.code, refusal.message), 403);
    const targetPath = body.path ?? '/';
    if (!isSafeDemoPath(targetPath)) {
      return c.json(
        err('invalid_demo_path', 'The page must be a path on this instance, starting with a single /'),
        400
      );
    }

    const { pass, secret } = await service.mint({
      workspaceId: principal.workspaceId,
      userId: target.userId,
      createdBy: principal.userId,
      targetPath,
      expiresInMinutes: body.expiresInMinutes ?? DEMO_PASS_DEFAULT_MINUTES
    });

    // Never the secret, never its hash: the trail says who, where, until when.
    c.set('audit', {
      action: 'demo_pass.mint',
      resourceType: 'demo_pass',
      resourceId: pass.id,
      metadata: { targetUserId: pass.userId, targetPath, expiresAt: pass.expiresAt.toISOString() }
    });
    // The secret rides in the FRAGMENT: a browser never sends it to a server,
    // so no access log, proxy or referrer ever carries it.
    const url = `${base}/demo#pass=${secret}&to=${encodeURIComponent(targetPath)}`;
    return c.json({ pass: demoPassToWire(pass), secret, url }, 201);
  });

  api.openapi(demoPassRevokeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const pass = await service.revoke(principal.workspaceId, id);
    if (!pass) return c.json(err('not_found', 'Demo pass not found'), 404);
    c.set('audit', {
      action: 'demo_pass.revoke',
      resourceType: 'demo_pass',
      resourceId: pass.id,
      metadata: { targetUserId: pass.userId }
    });
    return c.json(demoPassToWire(pass), 200);
  });
}
