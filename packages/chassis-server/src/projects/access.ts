import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Principal, ProjectRole } from '@antasphere/chassis-contract';
import { projects, type DbConn } from '@antasphere/chassis-db';

/**
 * THE project access rule, stated once. A tool links its own resources to
 * projects through a table of its own, and asks ONE question of the chassis:
 * "does this principal hold a grant of at least `<role>` on the project in
 * this column?". The chassis routes (`api/projects.ts`) ask the same question
 * through the same builder, so a tool cannot drift from them.
 *
 * What the predicate carries, and every clause is load-bearing:
 *
 *  - **The guest refusal.** An `origin='guest'` membership exists for
 *    principal resolution only (D2): it is never a project member. Refused on
 *    the PRINCIPAL (`false`, no query at all) AND on the membership row the
 *    grant rides on (`origin <> 'guest'`), so a stray row is inert.
 *  - **The live membership.** The grant is read THROUGH its
 *    `workspace_members` row: same user, same workspace as the request,
 *    `is_active`. A deleted membership took the grant with it (the foreign
 *    key's cascade); a deactivated one resolves no principal at all.
 *  - **One workspace.** The project belongs to the request's workspace and to
 *    the membership's. A request never spans workspaces (ADR 014).
 *  - **The role ladder.** `manager` contains `editor` contains `viewer`.
 *  - **The operator view.** A workspace owner or admin acts as a manager on
 *    every project of the workspace (ADR 006), which is why a project with no
 *    manager stays manageable and there is no last-manager guard.
 *  - **The archived-write rule.** `access: 'write'` is off while the project
 *    is archived, for everyone, the operator included. A READ stays.
 *
 * Callers answer 404, never 403, when a READ predicate is false: a project a
 * principal cannot read must not reveal its existence.
 */

const LADDER: Record<ProjectRole, readonly ProjectRole[]> = {
  viewer: ['viewer', 'editor', 'manager'],
  editor: ['editor', 'manager'],
  manager: ['manager']
};

export interface ProjectGrantOptions {
  /** The least role that satisfies the predicate. */
  atLeast: ProjectRole;
  /** `write` adds the archived-write rule; `read` does not look at the archive. */
  access: 'read' | 'write';
}

/**
 * A boolean SQL expression over `projectId`, a column (or expression) of the
 * CALLER's query that holds a project id: the tool's link table column, or
 * `projects.id` itself. The aliases are prefixed so they cannot collide with
 * the ones of the query the predicate is embedded in.
 *
 * **Pass a QUALIFIED reference when the predicate lands in a SELECT LIST.**
 * drizzle renders a column object of a single-table select WITHOUT its table
 * name there (`"id"`), and inside this subquery a bare `"id"` binds to the
 * subquery's own tables: ambiguous at best, always-true at worst. A raw
 * `sql\`"link_table"."project_id"\`` (or `PROJECTS_ID` below) is immune; a
 * column object is safe in a WHERE, where drizzle always qualifies it.
 */
export function projectGrantPredicate(
  principal: Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>,
  projectId: SQLWrapper,
  opts: ProjectGrantOptions
): SQL {
  if (principal.origin === 'guest') return sql`false`;
  const live = opts.access === 'write' ? sql`AND prj_pr.archived_at IS NULL` : sql``;
  if (principal.role === 'owner' || principal.role === 'admin') {
    return sql`EXISTS (
      SELECT 1 FROM projects prj_pr
      WHERE prj_pr.id = ${projectId}
        AND prj_pr.workspace_id = ${principal.workspaceId}
        ${live}
    )`;
  }
  const roles = sql.join(
    LADDER[opts.atLeast].map((role) => sql`${role}`),
    sql`, `
  );
  return sql`EXISTS (
    SELECT 1
    FROM project_members prj_pm
    JOIN workspace_members prj_wm ON prj_wm.id = prj_pm.member_id
    JOIN projects prj_pr ON prj_pr.id = prj_pm.project_id
    WHERE prj_pm.project_id = ${projectId}
      AND prj_wm.user_id = ${principal.userId}
      AND prj_wm.workspace_id = ${principal.workspaceId}
      AND prj_wm.is_active
      AND prj_wm.origin <> 'guest'
      AND prj_pr.workspace_id = prj_wm.workspace_id
      AND prj_pm.role IN (${roles})
      ${live}
  )`;
}

/** `projects.id`, always qualified: safe in a select list as in a WHERE (see above). */
export const PROJECTS_ID: SQL = sql.raw('"projects"."id"');

/**
 * The caller's effective role on a project AS A SQL EXPRESSION over a project
 * id column: `manager`, `editor`, `viewer`, or NULL (no read). Built from the
 * predicate above, never beside it. Archive-blind on purpose: a role is a
 * READ fact, and whether an act is allowed on an archived project is the
 * act's own question (`access: 'write'`, or the route's 409).
 */
export function projectRoleExpression(
  principal: Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>,
  projectId: SQLWrapper
): SQL<ProjectRole | null> {
  const has = (atLeast: ProjectRole) =>
    projectGrantPredicate(principal, projectId, { atLeast, access: 'read' });
  return sql<ProjectRole | null>`CASE
    WHEN ${has('manager')} THEN 'manager'
    WHEN ${has('editor')} THEN 'editor'
    WHEN ${has('viewer')} THEN 'viewer'
  END`;
}

/**
 * The effective role of `principal` on one project of the request's
 * workspace, or null. **null = 404**: no such project here, or a project the
 * principal cannot read; the two must stay indistinguishable to the caller.
 */
export async function projectRole(
  conn: DbConn,
  principal: Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>,
  projectId: string
): Promise<ProjectRole | null> {
  const rows = await conn
    .select({ role: projectRoleExpression(principal, PROJECTS_ID) })
    .from(projects)
    .where(sql`${projects.id} = ${projectId} AND ${projects.workspaceId} = ${principal.workspaceId}`)
    .limit(1);
  return rows[0]?.role ?? null;
}
