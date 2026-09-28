import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  demoPasses,
  demoPassSessions,
  invitations,
  oauthAccessToken,
  oauthRefreshToken,
  projectMembers,
  session as sessionTable,
  user as userTable,
  workspaceMembers,
  workspaceTeamMembers,
  type DbConn
} from '@antasphere/chassis-db';

/**
 * The membership an ADD hangs a right on, re-read inside the add's own
 * transaction and held FOR SHARE until it commits: true when the row is
 * there, in that workspace, and active. Every add of something a removal
 * takes (a project grant, a team seat, a demo pass) calls this before its
 * insert, and refuses on false the way it refuses an inactive member.
 *
 * Why the lock (the end-to-end verification, finding 5): the add's first read
 * is outside any transaction, and the insert's foreign key check takes only a
 * KEY SHARE lock, which a removal's `UPDATE workspace_members` does not wait
 * for. An add that read the row active, then waited on another lock (the
 * project row, the team row), inserted after a removal had committed, on the
 * now inactive row, and the right came back with the person at their
 * re-invitation. Held FOR SHARE, the row makes the removal's update wait for
 * the add to commit (the removal's second pass then takes what the add
 * wrote, `deleteMembershipGrants`'s caller); an add that arrives after the
 * update re-reads the row off and inserts nothing.
 */
export async function holdLiveMembership(
  tx: DbConn,
  workspaceId: string,
  who: { memberId: string } | { userId: string }
): Promise<boolean> {
  const [row] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        'memberId' in who ? eq(workspaceMembers.id, who.memberId) : eq(workspaceMembers.userId, who.userId),
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.isActive, true)
      )
    )
    .for('share')
    .limit(1);
  return row !== undefined;
}

/** One membership a removal switched off. */
export interface RemovedMembership {
  /** The `workspace_members` row. */
  memberId: string;
  workspaceId: string;
  userId: string;
}

/**
 * The tool's half of a removal (the `membershipRemoval` slot): what the TOOL
 * hangs on a person in a workspace outside the chassis tables (an invite
 * waiting for them, a grant on one of its resources). It runs in the
 * removal's own transaction and answers what it ended, by name, for the
 * audit record.
 */
export type MembershipRemovalHook = (
  tx: DbConn,
  removed: readonly RemovedMembership[]
) => Promise<Record<string, number>>;

export interface RemovalCounts {
  projectGrants: number;
  teamSeats: number;
  /** Open workspace invitations revoked: the ones FOR the person and the ones they ISSUED. */
  invitations: number;
  /** Live demo passes revoked, their sessions ended: the ones opening the person and the ones they MINTED. */
  demoPasses: number;
  /** What the tool's hook ended, under the names it gave; empty without a hook. */
  tool: Record<string, number>;
}

/**
 * What a REMOVAL takes away beside the membership itself, stated once for
 * both editions (PRDCT-2816): the person's project grants, their team seats
 * (which is also every grant they held through a team), the open workspace
 * invitations that name them or that they issued, and what the tool hangs
 * on them in that workspace (`toolHook`).
 *
 * The demo passes are doors too (round 3, F1): a pass the person MINTED
 * signs a demo person in, who could reactivate them; a pass minted FOR them
 * works again the day they are re-invited, in whoever's hands it is. Both
 * are revoked with the sessions they opened, the pass service's own way.
 *
 * ORDER (round 3, F2): the caller runs this BEFORE it switches the membership
 * row off, inside the same transaction. An invitation's accept locks the
 * invitation, then the membership row; a removal that locked the membership
 * first and the invitation second met it head on and one of the two died
 * of a deadlock. Same order on both sides, no deadlock.
 *
 * The invitations are doors, not rights (the verifier's round 2, N1 and N2).
 * An invitation FOR the person that was open at the removal reactivates the
 * row at the role it names: the person would come back alone, as admin if it
 * says so. An invitation the person ISSUED is a way back in under another
 * address. Both are revoked; an invitation made after the removal is the
 * workspace's own act and brings the person back.
 *
 * A removal switches the membership row off and never deletes it (a re-add
 * reactivates the very same row), so the foreign keys' cascade never fires:
 * without these deletes, a person removed and added back later would find
 * every old grant and seat waiting, and a door left open for them (a pending
 * invite of the tool's) would let them switch the row back on themselves. A
 * removal is a removal: only an act of the workspace brings the person back,
 * and they come back with nothing. A PAUSE (`PATCH /members/{id}` with
 * `isActive: false`) keeps everything, on purpose.
 *
 * The two callers: the hub reconcile's sweep (cloud, the hub removed the
 * person) and `POST /members/{id}/remove` (a workspace managed here). Run it
 * in the transaction that switches the rows off.
 *
 * Idempotent, so a caller may run it twice in one transaction: the deletes
 * are by membership, the revokes filter on what is still open. The removal
 * route does (a second pass after the row is off, `mergeRemovalCounts`).
 */
export async function deleteMembershipGrants(
  tx: DbConn,
  removed: readonly RemovedMembership[],
  toolHook?: MembershipRemovalHook
): Promise<RemovalCounts> {
  if (removed.length === 0) {
    return { projectGrants: 0, teamSeats: 0, invitations: 0, demoPasses: 0, tool: {} };
  }
  const ids = removed.map((row) => row.memberId);
  const grants = await tx
    .delete(projectMembers)
    .where(inArray(projectMembers.memberId, ids))
    .returning({ id: projectMembers.id });
  const seats = await tx
    .delete(workspaceTeamMembers)
    .where(inArray(workspaceTeamMembers.memberId, ids))
    .returning({ id: workspaceTeamMembers.id });
  let revokedInvitations = 0;
  let revokedPasses = 0;
  for (const { workspaceId, userId } of removed) {
    const passes = await tx
      .update(demoPasses)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(demoPasses.workspaceId, workspaceId),
          isNull(demoPasses.revokedAt),
          or(eq(demoPasses.userId, userId), eq(demoPasses.createdBy, userId))
        )
      )
      .returning({ id: demoPasses.id });
    if (passes.length > 0) {
      const passIds = passes.map((p) => p.id);
      const sessions = (
        await tx
          .select({ sessionId: demoPassSessions.sessionId })
          .from(demoPassSessions)
          .where(inArray(demoPassSessions.passId, passIds))
      ).map((s) => s.sessionId);
      if (sessions.length > 0) {
        await tx.delete(oauthAccessToken).where(inArray(oauthAccessToken.sessionId, sessions));
        await tx.delete(oauthRefreshToken).where(inArray(oauthRefreshToken.sessionId, sessions));
        await tx.delete(demoPassSessions).where(inArray(demoPassSessions.sessionId, sessions));
        await tx.delete(sessionTable).where(inArray(sessionTable.id, sessions));
      }
      revokedPasses += passes.length;
    }
    const [person] = await tx
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    const rows = await tx
      .update(invitations)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          person
            ? or(eq(invitations.invitedBy, userId), sql`lower(${invitations.email}) = lower(${person.email})`)
            : eq(invitations.invitedBy, userId)
        )
      )
      .returning({ id: invitations.id });
    revokedInvitations += rows.length;
  }
  const tool = toolHook ? await toolHook(tx, removed) : {};
  return {
    projectGrants: grants.length,
    teamSeats: seats.length,
    invitations: revokedInvitations,
    demoPasses: revokedPasses,
    tool
  };
}

/** Two passes of `deleteMembershipGrants` as one record: every count summed, the tool's by name. */
export function mergeRemovalCounts(a: RemovalCounts, b: RemovalCounts): RemovalCounts {
  const tool: Record<string, number> = { ...a.tool };
  for (const [key, n] of Object.entries(b.tool)) tool[key] = (tool[key] ?? 0) + n;
  return {
    projectGrants: a.projectGrants + b.projectGrants,
    teamSeats: a.teamSeats + b.teamSeats,
    invitations: a.invitations + b.invitations,
    demoPasses: a.demoPasses + b.demoPasses,
    tool
  };
}
