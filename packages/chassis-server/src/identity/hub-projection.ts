import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  workspaceMembers,
  workspaceTeamMembers,
  workspaceTeams,
  workspaces,
  type Db,
  type DbConn,
  type WorkspaceRole
} from '@antasphere/chassis-db';

/**
 * The ONE hub-org projection primitive (internal/federation.md, ADR 015/018):
 * extracted verbatim from `HubSsoService.project()` so the SSO login path
 * and the H4 reconciler (`hub-reconcile.ts`) write byte-identical rows.
 *
 * Lazy projection: the hub org becomes a local workspace on first use
 * (`centralAccountId` = the hub org id), then a membership upsert
 * re-asserts (role, origin='hub', active) on EVERY call — reactivating a
 * deactivated row and following hub role changes (D11). Deliberately NOT
 * WorkspaceService.create: the projection needs ON CONFLICT semantics on
 * the 0021 unique partial index, the hub's role (not owner), and
 * origin='hub'.
 *
 * Throws raw on any database failure — each caller owns its error posture
 * (the login path maps to the fail-closed `sso_projection_failed`; the
 * reconciler logs and continues with the next entry).
 */
export interface OrgMembershipProjection {
  localUserId: string;
  /** The hub org id (uuid, validated upstream) — never a local workspace id. */
  hubWorkspaceId: string;
  /** Display name (H1); null keeps the current name (or mints the placeholder). */
  hubWorkspaceName: string | null;
  /** The hub org role, verbatim (D11) — validated upstream, never invented here. */
  role: WorkspaceRole;
}

/**
 * The name a hub org goes by when the hub sends none (an older hub, a blank
 * name): recognizable, and self-healing wherever the next hub read carries
 * the real one. The projection's H1 fallback and the refusal page's hint.
 */
export function placeholderWorkspaceName(hubOrgId: string): string {
  return `Antasphere workspace ${hubOrgId.slice(0, 8)}`;
}

export async function projectOrgMembership(
  db: Db,
  projection: OrgMembershipProjection
): Promise<{ workspaceId: string; memberId: string }> {
  const { localUserId, hubWorkspaceId, hubWorkspaceName, role } = projection;
  let [ws] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.centralAccountId, hubWorkspaceId))
    .limit(1);
  if (!ws) {
    // H1 fallback: without workspace_name (older hub), project under a
    // recognizable placeholder — self-healing, the re-sync below renames
    // it at the first call whose hub data carries the name.
    const name = hubWorkspaceName ?? placeholderWorkspaceName(hubWorkspaceId);
    const inserted = await db
      .insert(workspaces)
      .values({ name, centralAccountId: hubWorkspaceId })
      .onConflictDoNothing({
        target: workspaces.centralAccountId,
        where: sql`${workspaces.centralAccountId} IS NOT NULL`
      })
      .returning({ id: workspaces.id, name: workspaces.name });
    // Conflict = a concurrent first projection won the insert; land on its row.
    ws =
      inserted[0] ??
      (
        await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.centralAccountId, hubWorkspaceId))
          .limit(1)
      )[0];
    if (!ws) throw new Error('projection insert and re-select both returned nothing');
  }
  if (hubWorkspaceName && ws.name !== hubWorkspaceName) {
    await db.update(workspaces).set({ name: hubWorkspaceName }).where(eq(workspaces.id, ws.id));
  }
  const [member] = await db
    .insert(workspaceMembers)
    .values({
      workspaceId: ws.id,
      userId: localUserId,
      role,
      origin: 'hub',
      isActive: true
    })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role, origin: 'hub', isActive: true }
    })
    .returning({ id: workspaceMembers.id });
  if (!member) throw new Error('membership upsert returned nothing');
  return { workspaceId: ws.id, memberId: member.id };
}

/**
 * The person's team seats in ONE projected workspace, as the hub asserted
 * them in this pass (`GET /orgs`' per-org `teams`: the caller's own, never
 * the team's roster). Upserts each team by its hub id (slug and name follow
 * the hub; `updated_at` moves only when one of them changed), inserts the
 * missing seats, and deletes this membership's seats whose team the hub no
 * longer lists. Both the login pass and the periodic pass come through here,
 * so they write byte-identical rows.
 *
 * Run inside one transaction per org by the caller. Throws raw, like
 * `projectOrgMembership`. A team id already projected into ANOTHER workspace
 * (a hub id cannot move between organizations; only a corrupt answer could
 * say so) is left where it is and not seated here.
 */
export interface TeamSeatsProjection {
  /** The projected workspace (from `projectOrgMembership`). */
  workspaceId: string;
  /** The person's membership row in it — the seat rides on it. */
  memberId: string;
  teams: ReadonlyArray<{ id: string; slug: string; name: string }>;
}

export async function projectTeamSeats(db: DbConn, projection: TeamSeatsProjection): Promise<void> {
  const { workspaceId, memberId, teams } = projection;
  const seatTeamIds: string[] = [];
  if (teams.length > 0) {
    await db
      .insert(workspaceTeams)
      .values(teams.map((team) => ({ workspaceId, hubTeamId: team.id, slug: team.slug, name: team.name })))
      .onConflictDoUpdate({
        target: workspaceTeams.hubTeamId,
        set: {
          slug: sql`excluded.slug`,
          name: sql`excluded.name`,
          updatedAt: sql`now()`
        },
        // Renamed on drift only, and never across organizations.
        setWhere: sql`${workspaceTeams.workspaceId} = ${workspaceId}
          AND (${workspaceTeams.slug} IS DISTINCT FROM excluded.slug
            OR ${workspaceTeams.name} IS DISTINCT FROM excluded.name)`
      });
    const rows = await db
      .select({ id: workspaceTeams.id })
      .from(workspaceTeams)
      .where(
        and(
          eq(workspaceTeams.workspaceId, workspaceId),
          inArray(
            workspaceTeams.hubTeamId,
            teams.map((team) => team.id)
          )
        )
      );
    seatTeamIds.push(...rows.map((row) => row.id));
    if (seatTeamIds.length > 0) {
      await db
        .insert(workspaceTeamMembers)
        .values(seatTeamIds.map((teamId) => ({ teamId, memberId })))
        .onConflictDoNothing({ target: [workspaceTeamMembers.teamId, workspaceTeamMembers.memberId] });
    }
  }
  // The seats the hub no longer asserts, in THIS workspace only.
  const inWorkspace = db
    .select({ id: workspaceTeams.id })
    .from(workspaceTeams)
    .where(eq(workspaceTeams.workspaceId, workspaceId));
  await db
    .delete(workspaceTeamMembers)
    .where(
      and(
        eq(workspaceTeamMembers.memberId, memberId),
        inArray(workspaceTeamMembers.teamId, inWorkspace),
        ...(seatTeamIds.length > 0 ? [notInArray(workspaceTeamMembers.teamId, seatTeamIds)] : [])
      )
    );
}
