import { inArray } from 'drizzle-orm';
import { projectMembers, workspaceTeamMembers, type DbConn } from '@antasphere/chassis-db';

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
  /** What the tool's hook ended, under the names it gave; empty without a hook. */
  tool: Record<string, number>;
}

/**
 * What a REMOVAL takes away beside the membership itself, stated once for
 * both editions (PRDCT-2816): the person's project grants, their team seats
 * (which is also every grant they held through a team), and what the tool
 * hangs on them in that workspace (`toolHook`).
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
 */
export async function deleteMembershipGrants(
  tx: DbConn,
  removed: readonly RemovedMembership[],
  toolHook?: MembershipRemovalHook
): Promise<RemovalCounts> {
  if (removed.length === 0) return { projectGrants: 0, teamSeats: 0, tool: {} };
  const ids = removed.map((row) => row.memberId);
  const grants = await tx
    .delete(projectMembers)
    .where(inArray(projectMembers.memberId, ids))
    .returning({ id: projectMembers.id });
  const seats = await tx
    .delete(workspaceTeamMembers)
    .where(inArray(workspaceTeamMembers.memberId, ids))
    .returning({ id: workspaceTeamMembers.id });
  const tool = toolHook ? await toolHook(tx, removed) : {};
  return { projectGrants: grants.length, teamSeats: seats.length, tool };
}
