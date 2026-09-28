import type { OpenAPIHono } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { createEmailVerificationToken } from 'better-auth/api';
import {
  memberChangeEmailLinkRoute,
  memberDeleteRoute,
  memberRemoveRoute,
  memberResetLinkRoute,
  memberUpdateRoute,
  membersListRoute
} from '@antasphere/chassis-contract/routes';
import { workspaceMembers, user as userTable, type Db } from '@antasphere/chassis-db';
import type { Auth } from '../identity/better-auth.js';
import { isLastOwnerDbError, LastOwnerError, type AccountDeletionService } from '../accounts/deletion.js';
import { mintRefusal as sharedMintRefusal } from '../accounts/mint-refusal.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import { requireAuth, requireNonGuest, requireRole } from '../middleware/auth-context.js';
import { hubManagedMembershipGate } from '../middleware/hub-managed.js';
import {
  deleteMembershipGrants,
  type MembershipRemovalHook,
  type RemovalCounts
} from '../members/removal.js';

export interface MemberRouteDeps {
  db: Db;
  auth: Auth;
  publicBaseUrl: string;
  accountDeletion: AccountDeletionService;
  /**
   * Cloud edition only (P7, internal/federation.md): when set, every membership
   * MUTATION on a hub-origin workspace answers 403 `hub_managed` with this
   * pointer. undefined on oss — zero behavior change there.
   */
  hubManaged?: { manageUrl: string } | undefined;
  /** The tool's `guest_target` sentence (`copy.guestTarget`). */
  guestTargetMessage: string;
  /** The tool's half of a removal (the `membershipRemoval` slot), run in the removal's transaction. */
  onMembershipRemoval?: MembershipRemovalHook | undefined;
}

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (m: {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  isActive: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
}) => ({
  id: m.id,
  userId: m.userId,
  email: m.email,
  name: m.name,
  role: m.role,
  isActive: m.isActive,
  createdAt: m.createdAt.toISOString(),
  lastSeenAt: m.lastSeenAt?.toISOString() ?? null
});

export function registerMemberRoutes(api: OpenAPIHono, deps: MemberRouteDeps): void {
  const { db, auth, publicBaseUrl, accountDeletion, hubManaged } = deps;
  // P7 (cloud only): membership of a hub-origin workspace is the HUB's to
  // manage — every local mutation shape under /members answers the
  // `hub_managed` pointer. Registered BEFORE the role gates so any
  // authenticated caller gets the truthful refusal (an anonymous caller
  // passes through — no principal — and still 401s at requireRole below).
  // GET /members is untouched: the gate is method-keyed and the projected
  // roster is real. ONE wildcard mount covers the whole subtree — the
  // collection root, `/members/:id`, the 3-segment link paths, and any
  // FUTURE mutation registered under /members — so fail-closed holds by
  // construction, never by remembering a per-path registration.
  if (hubManaged) {
    api.use('/members/*', hubManagedMembershipGate(hubManaged.manageUrl));
  }
  api.use('/members', requireAuth());
  // Guest capability limit (D2, both editions): the member roster (names +
  // emails of the whole team) is a workspace-level surface. A guest is an
  // external party invited to ONE resource — the host tenant's directory is not
  // theirs to read. Per-resource surfaces their grant opens are untouched.
  api.use('/members', requireNonGuest());
  api.openapi(membersListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const cursorId = cursorRowId(cursor);
    const rows = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: workspaceMembers,
                  id: workspaceMembers.id,
                  createdAt: workspaceMembers.createdAt,
                  workspaceId: workspaceMembers.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(workspaceMembers.createdAt), desc(workspaceMembers.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return c.json({ members: page.map(toWire), nextCursor }, 200);
  });

  api.use('/members/:id', requireRole('admin'));
  api.openapi(memberUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        origin: workspaceMembers.origin,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);

    if (target.userId === principal.userId && patch.isActive === false) {
      return c.json(err('cannot_deactivate_self', 'You cannot deactivate yourself'), 400);
    }
    // Guest role-lock (D2): a guest row is 'member' by construction and the
    // guest capability limits key on origin, which no surface upgrades —
    // promoting one would mint a workspace admin the guest gates still
    // refuse resource creation to (an incoherent half-state), and on cloud an
    // administrator the hub knows nothing about. To empower the person,
    // invite them as a real member; the claim path preserves that row's
    // origin. Deactivate/reactivate stays available — cutting a guest off
    // entirely is a legitimate admin act.
    if (target.origin === 'guest' && patch.role && patch.role !== target.role) {
      return c.json(
        err('guest_role_locked', 'A guest membership cannot change role — invite them as a member instead'),
        403
      );
    }
    // Only owners touch owners (grant or revoke).
    if ((target.role === 'owner' || patch.role === 'owner') && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can change owner roles'), 403);
    }
    // Never leave the workspace without an active owner (shared with the
    // account-deletion guards in accounts/deletion.ts). Demotions run under
    // the race-free guard: workspace advisory lock + re-check, with the
    // migration-0009 trigger as the DB-level backstop — a concurrent-race
    // loser gets this clean 400, never a 500.
    const losesOwner =
      target.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.isActive === false);
    const applyPatch = async () => {
      await db
        .update(workspaceMembers)
        .set({
          ...(patch.role ? { role: patch.role } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {})
        })
        .where(eq(workspaceMembers.id, target.id));
    };
    try {
      if (losesOwner) {
        await accountDeletion.withLastOwnerGuard(principal.workspaceId, target.userId, applyPatch);
      } else {
        await applyPatch();
      }
    } catch (cause) {
      // The guarded loser throws LastOwnerError; the unguarded branch (or a
      // demotion racing invitation re-acceptance) can still trip the 0009
      // trigger with P0409 — both mean the last active owner would be lost.
      if (cause instanceof LastOwnerError || isLastOwnerDbError(cause)) {
        const message =
          cause instanceof LastOwnerError
            ? cause.message
            : 'The workspace must keep at least one active owner';
        return c.json(err('last_owner', message), 400);
      }
      throw cause;
    }

    const [updated] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);

    c.set('audit', {
      action: 'member.update',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { ...patch, targetUserId: target.userId }
    });
    return c.json(toWire(updated!), 200);
  });

  // Admin account deletion (GDPR erasure, the second delete surface).
  // Covered by the 2-segment `/members/:id` requireRole gate above; machines
  // are excluded automatically because DELETE /members/{id} is deliberately
  // unlisted in the fail-closed scope allowlist. Files the target uploaded
  // stay with the workspace (created_by → NULL via FK); NO blob cleanup.
  api.openapi(memberDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    if (target.userId === principal.userId) {
      return c.json(err('cannot_delete_self', 'Delete your own account from the account page'), 400);
    }
    if (target.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can delete an owner'), 403);
    }
    // ADR 014: deleting the ACCOUNT erases the user from EVERY workspace, and
    // an admin's authority ends at their own — refuse when the target belongs
    // to any other workspace (remove the person from this one instead; the account
    // holder can erase themselves). Single-workspace instances never hit this.
    const [foreign] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, target.userId),
          ne(workspaceMembers.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (foreign) {
      return c.json(
        err(
          'member_of_other_workspaces',
          'This account belongs to other workspaces — remove the person from this workspace instead of deleting the account'
        ),
        409
      );
    }

    // Snapshot the wire member BEFORE the cascade removes the joined user row.
    const [snapshot] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);

    // Better Auth's own deletion path (adapter hooks included) — NOT raw
    // drizzle. Membership, api keys, invitations they issued, and sessions
    // cascade; audit rows and file uploader anonymize via SET NULL.
    // Deleting an ACTIVE OWNER runs under the race-free last-owner guard
    // (workspace advisory lock + re-check; the migration-0009 trigger
    // backstops) so a concurrent-race loser gets a clean 400 last_owner.
    const cascade = async () => {
      const authCtx = await auth.$context;
      await authCtx.internalAdapter.deleteUser(target.userId);
      await authCtx.internalAdapter.deleteUserSessions(target.userId);
      // OPS-3 (PRDCT-1357): this path bypasses the deleteUser hooks, so the
      // erasure tombstone is written here — a restore must not undo this.
      await accountDeletion.recordErasure({ id: target.userId, email: snapshot!.email });
    };
    try {
      if (target.role === 'owner' && target.isActive) {
        await accountDeletion.withLastOwnerGuard(principal.workspaceId, target.userId, cascade);
      } else {
        await cascade();
      }
    } catch (cause) {
      // isLastOwnerDbError: the unguarded branch can still trip the trigger
      // when the target is promoted to last owner mid-flight.
      if (cause instanceof LastOwnerError || isLastOwnerDbError(cause)) {
        return c.json(err('last_owner', 'The workspace must keep at least one active owner'), 400);
      }
      throw cause;
    }

    c.set('audit', {
      action: 'member.delete',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId, email: snapshot!.email }
    });
    return c.json(toWire(snapshot!), 200);
  });

  // Removal (PRDCT-2816): the act between the pause and the account erasure,
  // and the same one the hub's removal is on cloud. The membership row is
  // switched off, never deleted (a new invitation reactivates the very same
  // row), and the person's project grants, their team seats and what the
  // tool hangs on them in this workspace go with it, in ONE transaction: a
  // person brought back starts with none. The row is left at the role
  // `member`: the role a person held is not kept in wait for them either, so
  // whatever switches the row back on (an admin's Reactivate, an invitation,
  // which names its own role) never hands an old admin or owner role back.
  // The account, and the person's memberships of other workspaces, are untouched.
  // An already paused member can be removed: that turns the pause into a
  // removal. The 2-segment gate above does NOT cover this 3-segment path, so
  // it is gated explicitly. Machines never reach it: the path is deliberately
  // UNLISTED in the fail-closed scope allowlist, like the account deletion.
  // A hub-origin workspace died at the subtree gate with `hub_managed`.
  api.use('/members/:id/remove', requireRole('admin'));
  api.openapi(memberRemoveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    if (target.userId === principal.userId) {
      return c.json(err('cannot_remove_self', 'You cannot remove yourself'), 400);
    }
    if (target.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can remove an owner'), 403);
    }

    // The WHERE names the workspace again: the row is the one read above,
    // and the statement could not reach another workspace's even if it were not.
    // What the person held goes first, the row second: the same lock order
    // as an invitation's accept, which locks the invitation and then the
    // membership row (members/removal.ts, ORDER).
    const remove = () =>
      db.transaction(async (tx) => {
        const counts = await deleteMembershipGrants(
          tx,
          [{ memberId: target.id, workspaceId: principal.workspaceId, userId: target.userId }],
          deps.onMembershipRemoval
        );
        await tx
          .update(workspaceMembers)
          .set({ isActive: false, isDefault: false, role: 'member' })
          .where(
            and(eq(workspaceMembers.id, target.id), eq(workspaceMembers.workspaceId, principal.workspaceId))
          );
        return counts;
      });
    let removed: RemovalCounts;
    try {
      // Removing an ACTIVE owner runs under the race-free last-owner guard,
      // as the pause and the account deletion do.
      removed =
        target.role === 'owner' && target.isActive
          ? await accountDeletion.withLastOwnerGuard(principal.workspaceId, target.userId, remove)
          : await remove();
    } catch (cause) {
      if (cause instanceof LastOwnerError || isLastOwnerDbError(cause)) {
        return c.json(err('last_owner', 'The workspace must keep at least one active owner'), 400);
      }
      throw cause;
    }

    const [after] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);

    c.set('audit', {
      action: 'member.remove',
      resourceType: 'member',
      resourceId: target.id,
      // The tool's counts first: a name the chassis writes is the chassis's.
      metadata: {
        ...removed.tool,
        targetUserId: target.userId,
        roleBefore: target.role,
        projectGrants: removed.projectGrants,
        teamSeats: removed.teamSeats,
        invitations: removed.invitations,
        demoPasses: removed.demoPasses
      }
    });
    return c.json(toWire(after!), 200);
  });

  // The shared refusal of every route that mints a sign-in-equivalent
  // credential for another user (PRDCT-1354): guest targets and targets
  // belonging to another workspace. Its own module (accounts/mint-refusal.ts),
  // shared with the demo pass mint; bound here to this router's db and copy.
  const mintRefusal = (principal: { workspaceId: string }, target: { userId: string; origin: string }) =>
    sharedMintRefusal(db, deps.guestTargetMessage, principal, target);

  // Owner-generated password reset link — the recovery path that works with
  // no email driver (invitations' copyable-link pattern). The 2-segment gate
  // above does NOT cover this 3-segment path, so gate it explicitly — and at
  // OWNER, not admin (AUTH-8: see mintRefusal).
  api.use('/members/:id/reset-link', requireRole('owner'));
  api.openapi(memberResetLinkRoute, async (c) => {
    // Cloud edition (`hubManaged` is present iff EDITION=cloud): the token a
    // mint would produce lands on POST /reset-password, which the D1 hub-only
    // posture refuses there (identity/better-auth.ts isPasswordResetPath) —
    // so minting would hand admins a dead link. Refuse at the source instead.
    // Hub-origin workspaces already died at the subtree gate above with
    // `hub_managed`; this covers cloud-LOCAL workspaces (the operator's,
    // guest hosts). Recovery for local accounts there: hub SSO for
    // humans, break-glass for the operator. oss is untouched.
    if (hubManaged) {
      return c.json(
        err(
          'password_reset_disabled',
          'Local password reset is disabled on this edition — credentials are managed at the Antasphere hub'
        ),
        403
      );
    }
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        origin: workspaceMembers.origin
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    const refusal = await mintRefusal(principal, target);
    if (refusal) return c.json(err(refusal.code, refusal.message), 403);

    // Mint a single-use token in Better Auth's own verification table, in the
    // exact shape POST /reset-password consumes (`reset-password:<token>`).
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    const authCtx = await auth.$context;
    await authCtx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: target.userId,
      expiresAt
    });

    c.set('audit', {
      action: 'member.reset_link',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId }
    });
    return c.json(
      {
        resetUrl: `${publicBaseUrl.replace(/\/+$/, '')}/reset-password?token=${token}`,
        expiresAt: expiresAt.toISOString()
      },
      200
    );
  });

  // Owner-generated email change link — the email-change path that works
  // with no email driver (same copyable-link pattern as the reset link).
  // The 2-segment gate above does NOT cover this 3-segment path either, so
  // gate it explicitly — at OWNER, like its sibling (AUTH-8).
  api.use('/members/:id/change-email-link', requireRole('owner'));
  api.openapi(memberChangeEmailLinkRoute, async (c) => {
    // Cloud edition (`hubManaged` is present iff EDITION=cloud): the SAME
    // closure the reset-link sibling carries, which this route was missing
    // (AUTH-1). It is the stronger of the two — the minted JWT is
    // sign-in-equivalent AND rewrites the address the hub identity is keyed
    // on, while on cloud a user's email is the hub's to own (D10 re-syncs it
    // on every login, so a local rewrite is either overwritten or a
    // hijack). Hub-origin workspaces already died at the P7 subtree gate
    // with `hub_managed`; this covers cloud-LOCAL workspaces (the
    // operator's, guest hosts). oss is untouched.
    if (hubManaged) {
      return c.json(
        err(
          'email_change_disabled',
          'Local email changes are disabled on this edition — identities are managed at the Antasphere hub'
        ),
        403
      );
    }
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        origin: workspaceMembers.origin,
        email: userTable.email
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    const refusal = await mintRefusal(principal, target);
    if (refusal) return c.json(err(refusal.code, refusal.message), 403);

    // Better Auth stores emails lowercased — compare and mint in that form.
    // ⚠️ RACE-7: this lookup is ADVISORY ONLY, never the boundary. It is a
    // read outside any lock, and the mint writes nothing (the token is a
    // stateless JWT — LESSONS.md M6), so two concurrent mints for the same
    // `newEmail` both pass it. The REAL enforcement is the `user.email`
    // UNIQUE constraint at CONSUMPTION time: whichever link is consumed
    // first wins the address and the loser's link fails, leaving exactly one
    // account on that email (asserted in test/integration/minted-credentials
    // .test.ts). Never promote this pre-check to a uniqueness guarantee.
    // RACE-7 scope choice: joined on THIS workspace's membership rows — an
    // unscoped user lookup made the 409-vs-200 an instance-global account
    // oracle; the owner already sees these emails on the roster.
    // ⚠️ The constraint at consumption is OBSERVABLE, not a silent backstop
    // (PRDCT-1437): a colliding consume used to answer a raw 500 against the
    // free case's 302 — a mint-then-consume account oracle. The consume path
    // now answers the SAME redirect + session on both branches (the
    // collision rewrite at the /auth mount — rewriteChangeEmailCollision in
    // api/index.ts re-signs the token as a no-op change so Better Auth runs
    // its native success path), and the honest residual — the owner can always
    // read back whether the change TOOK, because email uniqueness is
    // instance-global — is documented in ADR 013's amendment.
    const newEmail = body.newEmail.toLowerCase();
    const [existing] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(userTable.email, newEmail), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (existing) {
      return c.json(err('email_taken', 'That email is already in use'), 409);
    }

    // Mint the exact stateless JWT GET /verify-email consumes for an email
    // change ({email: current, updateTo: new, requestType}), signed with the
    // auth secret — Better Auth's own helper, never hand-rolled jose.
    // ⚠️ Consuming this link updates the email AND signs the target in (a
    // session is created when none exists) — it is sign-in-equivalent. Hand
    // it to the target member only, never to anyone else.
    const expiresIn = 3600; // 1h
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const authCtx = await auth.$context;
    const token = await createEmailVerificationToken(authCtx.secret, target.email, newEmail, expiresIn, {
      requestType: 'change-email-verification'
    });
    const verifyUrl = `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/auth/verify-email?token=${token}&callbackURL=%2Faccount`;

    c.set('audit', {
      action: 'member.change_email_link',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId, newEmail }
    });
    return c.json({ verifyUrl, newEmail, expiresAt: expiresAt.toISOString() }, 200);
  });
}
