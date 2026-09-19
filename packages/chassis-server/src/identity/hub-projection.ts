import { eq, sql } from 'drizzle-orm';
import { workspaceMembers, workspaces, type Db, type WorkspaceRole } from '@antasphere/chassis-db';

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

export async function projectOrgMembership(
  db: Db,
  projection: OrgMembershipProjection
): Promise<{ workspaceId: string }> {
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
    const name = hubWorkspaceName ?? `Antasphere workspace ${hubWorkspaceId.slice(0, 8)}`;
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
  await db
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
    });
  return { workspaceId: ws.id };
}
