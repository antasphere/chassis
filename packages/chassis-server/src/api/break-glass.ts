import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  breakGlassClaimOwnershipRoute,
  breakGlassResetTwoFactorRoute
} from '@antasphere/chassis-contract/routes';
import { twoFactor, user as userTable, workspaceMembers, workspaces, type Db } from '@antasphere/chassis-db';
import type { Auth } from '../identity/better-auth.js';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import { parseSuperadminEmails } from '../accounts/superadmin.js';

/**
 * Break-glass superadmin recovery (ADR 010) — the instance-level recovery
 * surface for the per-tenant hosting model. Two capabilities only:
 *
 *  - claim-ownership: make the calling superadmin (or a named existing user)
 *    an ACTIVE OWNER of a workspace — creating the membership when absent,
 *    reactivating and promoting when present. It ADDS an owner and never
 *    removes one, so the migration-0009 last-owner trigger is satisfied by
 *    construction. The target workspace is explicit (`workspaceId`) once the
 *    instance runs several (ADR 014); a single-workspace instance keeps the
 *    old no-argument call.
 *  - reset-2fa: clear a locked-out user's second factor (the recovery ADR 009
 *    deferred to manual DB surgery). User-level — needs no workspace; its
 *    audit row is instance-attributed.
 *
 * SAFETY MODEL (a bug here = full instance compromise — keep all of it):
 *
 *  - Off by default: superadmin exists ONLY while SUPERADMIN_EMAILS is set.
 *  - Session-only, twice over: these paths are deliberately UNLISTED in the
 *    fail-closed scope allowlist (middleware/scopes.ts), so machine
 *    principals 403 before reaching the handlers; AND the handlers resolve
 *    the Better Auth session directly — a request without a session cookie
 *    can never qualify, whatever headers it carries.
 *  - Verified email required: an allowlisted address that was never proven
 *    (invitation copyable-link accounts are unverified) does NOT match.
 *  - Identity is re-read from the DB by session user id — never derived from
 *    any header, body field, or client-supplied value.
 *  - No requireAuth()/requireRole() gate: the recovering operator may hold a
 *    session with NO membership (principal resolves to null), which is
 *    exactly the state break-glass exists to fix. The handlers do their own
 *    authentication and are exempted from the generic audit middleware
 *    because they write their own richer rows (see audit/service.ts).
 */

export interface BreakGlassRouteDeps {
  db: Db;
  auth: Auth;
  audit: AuditService;
  logger: Logger;
  /** Raw SUPERADMIN_EMAILS value (already validated by the env schema). */
  superadminEmails: string | undefined;
}

const err = (code: string, message: string) => ({ error: { code, message } });

type SuperadminResolution =
  | { kind: 'ok'; caller: { userId: string; email: string; name: string } }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' };

export function registerBreakGlassRoutes(api: OpenAPIHono, deps: BreakGlassRouteDeps): void {
  const { db, auth, audit, logger } = deps;
  const allowlist = parseSuperadminEmails(deps.superadminEmails);

  /**
   * Resolve the caller as a superadmin. One uniform `forbidden` for every
   * rejection reason (dormant, not listed, unverified) so the endpoint is
   * not an oracle for the allowlist's contents.
   */
  const resolveSuperadmin = async (c: Context): Promise<SuperadminResolution> => {
    // Session-only: the verified session identity, never a header or bearer.
    // Machine credentials died at the fail-closed scope gate already; a
    // cookieless request has no session and stops here.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return { kind: 'unauthenticated' };
    if (allowlist.size === 0) return { kind: 'forbidden' };
    // Fresh row by session user id — email + verification state are read
    // from the database, not trusted from session claims.
    const [u] = await db
      .select({
        id: userTable.id,
        email: userTable.email,
        emailVerified: userTable.emailVerified,
        name: userTable.name
      })
      .from(userTable)
      .where(eq(userTable.id, session.user.id))
      .limit(1);
    if (!u) return { kind: 'forbidden' };
    if (!allowlist.has(u.email.toLowerCase())) return { kind: 'forbidden' };
    if (!u.emailVerified) return { kind: 'forbidden' };
    return { kind: 'ok', caller: { userId: u.id, email: u.email, name: u.name } };
  };

  /**
   * The workspace an owner-claim targets (ADR 014). Explicit `workspaceId`
   * wins; omitted, it resolves ONLY while the instance runs a single
   * workspace — with several, recovery must name its target (400
   * workspace_required), never guess one.
   */
  const resolveTargetWorkspace = async (
    explicit: string | undefined
  ): Promise<
    { kind: 'ok'; id: string } | { kind: 'not_found' } | { kind: 'not_setup' } | { kind: 'ambiguous' }
  > => {
    if (explicit) {
      const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, explicit))
        .limit(1);
      return ws ? { kind: 'ok', id: ws.id } : { kind: 'not_found' };
    }
    const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(2);
    const [only] = rows;
    if (!only) return { kind: 'not_setup' };
    if (rows.length > 1) return { kind: 'ambiguous' };
    return { kind: 'ok', id: only.id };
  };

  api.openapi(breakGlassClaimOwnershipRoute, async (c) => {
    const resolved = await resolveSuperadmin(c);
    if (resolved.kind === 'unauthenticated') {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }
    if (resolved.kind === 'forbidden') {
      return c.json(err('forbidden', 'Break-glass is not available to this caller'), 403);
    }
    const caller = resolved.caller;
    const body = c.req.valid('json');

    const targetWs = await resolveTargetWorkspace(body.workspaceId);
    if (targetWs.kind === 'not_setup') {
      return c.json(err('not_setup', 'This instance has not completed setup'), 409);
    }
    if (targetWs.kind === 'not_found') {
      return c.json(err('not_found', 'Target workspace not found'), 404);
    }
    if (targetWs.kind === 'ambiguous') {
      return c.json(
        err('workspace_required', 'This instance has several workspaces — pass workspaceId explicitly'),
        400
      );
    }
    const ws = { id: targetWs.id };

    // Target: a named existing user, or the calling superadmin.
    let target = { userId: caller.userId, email: caller.email };
    if (body.userId) {
      const [t] = await db
        .select({ id: userTable.id, email: userTable.email })
        .from(userTable)
        .where(eq(userTable.id, body.userId))
        .limit(1);
      if (!t) return c.json(err('not_found', 'Target user not found'), 404);
      target = { userId: t.id, email: t.email };
    }

    const [before] = await db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, target.userId)))
      .limit(1);

    // Additive by construction: create-or-promote to an ACTIVE OWNER. The
    // 0009 last-owner trigger only rejects operations that REMOVE the last
    // active owner — adding one is always legal, including the first owner
    // of an ownerless workspace.
    const [after] = await db
      .insert(workspaceMembers)
      // origin='local' on BOTH paths (BG-1, PRDCT-1356): a break-glass owner
      // is the tool's own business, never hub truth. Left at 'hub' (the
      // conflict path once kept the row's old origin), the cloud reconciler's
      // deactivation sweep — which targets origin='hub' rows the hub no
      // longer asserts — undid the recovery ~12 s later.
      .values({ workspaceId: ws.id, userId: target.userId, role: 'owner', isActive: true, origin: 'local' })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: 'owner', isActive: true, origin: 'local' }
      })
      .returning({ id: workspaceMembers.id });
    if (!after) throw new Error('break-glass ownership upsert returned no row');

    logger.warn(
      {
        superadminUserId: caller.userId,
        superadminEmail: caller.email,
        targetUserId: target.userId,
        targetEmail: target.email,
        workspaceId: ws.id
      },
      'BREAK-GLASS: workspace ownership claimed'
    );
    await audit.write({
      workspaceId: ws.id,
      principal: { userId: caller.userId, via: 'session' },
      action: 'break_glass.claim_ownership',
      resourceType: 'member',
      resourceId: after.id,
      requestId: c.get('requestId'),
      metadata: {
        superadminUserId: caller.userId,
        superadminEmail: caller.email,
        targetUserId: target.userId,
        targetEmail: target.email,
        before: before ? { role: before.role, isActive: before.isActive } : null,
        after: { role: 'owner', isActive: true },
        created: !before
      }
    });

    return c.json(
      {
        memberId: after.id,
        userId: target.userId,
        email: target.email,
        workspaceId: ws.id,
        role: 'owner' as const,
        isActive: true,
        created: !before
      },
      200
    );
  });

  api.openapi(breakGlassResetTwoFactorRoute, async (c) => {
    const resolved = await resolveSuperadmin(c);
    if (resolved.kind === 'unauthenticated') {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }
    if (resolved.kind === 'forbidden') {
      return c.json(err('forbidden', 'Break-glass is not available to this caller'), 403);
    }
    const caller = resolved.caller;
    const { userId } = c.req.valid('json');

    const [target] = await db
      .select({
        id: userTable.id,
        email: userTable.email,
        twoFactorEnabled: userTable.twoFactorEnabled
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Target user not found'), 404);

    // Clear the factor: the two_factor row (secret + backup codes) and the
    // user flag. Idempotent — resetting an unenrolled user is a no-op 200.
    const removed = await db
      .delete(twoFactor)
      .where(eq(twoFactor.userId, target.id))
      .returning({ id: twoFactor.id });
    await db.update(userTable).set({ twoFactorEnabled: false }).where(eq(userTable.id, target.id));
    const hadTwoFactor = removed.length > 0 || target.twoFactorEnabled === true;

    logger.warn(
      {
        superadminUserId: caller.userId,
        superadminEmail: caller.email,
        targetUserId: target.id,
        targetEmail: target.email,
        hadTwoFactor
      },
      'BREAK-GLASS: two-factor reset'
    );
    // INSTANCE-attributed (workspace_id NULL, ADR 014): a second factor is a
    // user property, not any workspace's — the row needs no workspace home.
    await audit.write({
      workspaceId: null,
      principal: { userId: caller.userId, via: 'session' },
      action: 'break_glass.reset_two_factor',
      resourceType: 'user',
      resourceId: target.id,
      requestId: c.get('requestId'),
      metadata: {
        superadminUserId: caller.userId,
        superadminEmail: caller.email,
        targetUserId: target.id,
        targetEmail: target.email,
        hadTwoFactor
      }
    });

    return c.json({ userId: target.id, hadTwoFactor }, 200);
  });
}
