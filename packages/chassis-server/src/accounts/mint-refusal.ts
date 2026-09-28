import { and, eq, ne } from 'drizzle-orm';
import { workspaceMembers, type Db } from '@antasphere/chassis-db';

/**
 * Shared refusal for the SIGN-IN-EQUIVALENT mint routes (PRDCT-1354,
 * findings AUTH-1/AUTH-2/AUTH-8). `/members/{id}/reset-link`,
 * `/members/{id}/change-email-link` and the demo pass mint
 * (`POST /demo/passes`) all hand the caller a bearer credential
 * for ANOTHER user's GLOBAL account: consuming any one of them signs the
 * target in (LESSONS.md M6: "Consuming a change-email JWT while logged
 * out CREATES a session for the target user"). A `user` row is
 * instance-global, so the blast radius of a mint is every workspace that
 * user belongs to — not just the minter's.
 *
 * Two target classes therefore make a mint a CROSS-TENANT takeover and
 * are refused outright:
 *
 *  1. `origin='guest'` — the guest row exists for principal resolution
 *     only (D2). It was created by the per-resource claim path for an
 *     EXTERNAL party whose account is not this tenant's to administer;
 *     the host tenant never owned that credential. Admins have no
 *     recovery duty toward a guest, so there is nothing to trade away.
 *  2. a target holding a membership in ANY OTHER workspace — the minted
 *     credential would carry into that workspace too. "Admin of the
 *     workspace" is not "owner of the person"; a user who works with two
 *     tenants must never be recoverable by either one unilaterally.
 *     Recovery for such a user is self-serve (`/request-password-reset`)
 *     or the operator's break-glass surface.
 *
 * The role gate is OWNER, not admin (AUTH-8): the old guards only fired
 * when `target.role === 'owner'`, so any admin could mint against any
 * other admin and escalate laterally. Minting someone else's credential
 * is an owner-level act on every route that calls this.
 *
 * Fail-CLOSED shape: a new route that mints a credential for another user
 * must call this helper. Returning `null` means "no refusal found".
 * `guestTargetMessage` is the tool's `guest_target` sentence
 * (`copy.guestTarget`).
 */
export async function mintRefusal(
  db: Db,
  guestTargetMessage: string,
  principal: { workspaceId: string },
  target: { userId: string; origin: string }
): Promise<{ code: string; message: string } | null> {
  if (target.origin === 'guest') {
    return {
      code: 'guest_target',
      message: guestTargetMessage
    };
  }
  const [foreign] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.userId, target.userId), ne(workspaceMembers.workspaceId, principal.workspaceId))
    )
    .limit(1);
  if (foreign) {
    return {
      code: 'cross_workspace_target',
      message:
        'This member also belongs to another workspace — an admin-minted link would carry into it, so it is refused'
    };
  }
  return null;
}
