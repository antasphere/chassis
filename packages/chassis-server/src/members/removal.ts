import { inArray } from 'drizzle-orm';
import { projectMembers, workspaceTeamMembers, type DbConn } from '@antasphere/chassis-db';

/**
 * What a REMOVAL takes away beside the membership itself, stated once for
 * both editions (PRDCT-2816): the person's project grants and their team
 * seats, which is also every grant they held through a team.
 *
 * A removal switches the membership row off and never deletes it (a re-add
 * reactivates the very same row), so the foreign keys' cascade never fires:
 * without these deletes, a person removed and added back later would find
 * every old grant and seat waiting. A removal is a removal: a re-add starts
 * with none. A PAUSE (`PATCH /members/{id}` with `isActive: false`) keeps
 * them, on purpose.
 *
 * The two callers: the hub reconcile's sweep (cloud, the hub removed the
 * person) and `POST /members/{id}/remove` (a workspace managed here). Run it
 * in the transaction that switches the rows off.
 */
export async function deleteMembershipGrants(
  tx: DbConn,
  memberIds: readonly string[]
): Promise<{ projectGrants: number; teamSeats: number }> {
  if (memberIds.length === 0) return { projectGrants: 0, teamSeats: 0 };
  const ids = [...memberIds];
  const grants = await tx
    .delete(projectMembers)
    .where(inArray(projectMembers.memberId, ids))
    .returning({ id: projectMembers.id });
  const seats = await tx
    .delete(workspaceTeamMembers)
    .where(inArray(workspaceTeamMembers.memberId, ids))
    .returning({ id: workspaceTeamMembers.id });
  return { projectGrants: grants.length, teamSeats: seats.length };
}
