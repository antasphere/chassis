import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { projectRoleAtLeast, type Principal, type ProjectRole } from '@antasphere/chassis-contract';
import {
  projectArchiveRoute,
  projectCreateRoute,
  projectGetRoute,
  projectMemberAddRoute,
  projectMemberRemoveRoute,
  projectMemberRoleRoute,
  projectMembersListRoute,
  projectsListRoute,
  projectTeamRemoveRoute,
  projectTeamRoleRoute,
  projectUnarchiveRoute,
  projectUpdateRoute
} from '@antasphere/chassis-contract/routes';
import {
  projectMembers,
  projects,
  projectTeams,
  user as userTable,
  workspaceMembers,
  workspaceTeams,
  type Db,
  type DbConn
} from '@antasphere/chassis-db';
import { requireAuth, requireNonGuest } from '../middleware/auth-context.js';
import {
  createdAtText,
  cursorRowId,
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetBefore,
  pageOf
} from '../pagination.js';
import {
  PROJECTS_ID,
  projectGrantPredicate,
  projectRole,
  projectRoleExpression
} from '../projects/access.js';

/**
 * The project routes. NOT under the hub-managed gate, on purpose: project
 * membership is the tool's own on both editions (the gate is mounted on
 * `/members/*` and `/invitations/*`, and this subtree is neither). Members are
 * picked among the workspace's own ACTIVE non-guest members, and its TEAMS
 * (PRDCT-2794: a team holds a role like a person, on both editions; on cloud
 * the team is the hub's projection, on self-hosted the tool's own): no
 * invitation, no claim token and no account is ever minted here, so nothing
 * in this file can diverge from the hub.
 *
 * The tiered answer, on every route (the ADR 013 posture):
 *   404  whoever cannot read the project (`projectRole` = null);
 *   403  a proven reader whose role does not allow the act;
 *   409  `project_archived` on every mutation of an archived project but unarchive.
 * The order is fixed: read, then role, then archive. A viewer of an archived
 * project who tries to rename it learns 403, the fact about THEM, before 409.
 */
export interface ProjectRouteDeps {
  db: Db;
}

const err = (code: string, message: string) => ({ error: { code, message } });
const notFound = () => err('not_found', 'Project not found');

/** A Postgres foreign-key violation (SQLSTATE 23503) on the named constraint, down drizzle's `cause` chain. */
function isForeignKeyViolation(e: unknown, constraint: string): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 10; cur = cur.cause, depth++) {
    const link = cur as { code?: unknown; constraint?: unknown };
    if (link.code === '23503') return link.constraint === constraint;
  }
  return false;
}

/** The foreign key a team's place on a project rides on: the one violation that means "the team went". */
const PROJECT_TEAM_FK = 'project_teams_team_id_workspace_teams_id_fk';

type ProjectWireRow = {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  myRole: ProjectRole | null;
  memberCount: number;
};

const toWire = (p: ProjectWireRow & { myRole: ProjectRole }) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  metadata: p.metadata,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdBy: p.createdBy,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  myRole: p.myRole,
  memberCount: p.memberCount
});

const memberToWire = (m: {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
  addedBy: string | null;
  createdAt: Date;
}) => ({
  kind: 'person' as const,
  userId: m.userId,
  email: m.email,
  name: m.name,
  role: m.role,
  addedBy: m.addedBy,
  createdAt: m.createdAt.toISOString()
});

const teamToWire = (t: {
  teamId: string;
  slug: string;
  name: string;
  membersCount: number;
  hubTeamId: string | null;
  role: ProjectRole;
  addedBy: string | null;
  createdAt: Date;
}) => ({
  kind: 'team' as const,
  teamId: t.teamId,
  slug: t.slug,
  name: t.name,
  membersCount: Number(t.membersCount),
  hubTeamId: t.hubTeamId,
  role: t.role,
  addedBy: t.addedBy,
  createdAt: t.createdAt.toISOString()
});

/** How many people a team seats: the people who hold the project role through it. */
const TEAM_MEMBERS_COUNT = sql<number>`(SELECT count(*)::int FROM workspace_team_members prj_tmc WHERE prj_tmc.team_id = ${sql.raw('"workspace_teams"."id"')})`;

/** The wire columns of a project, the caller's role and the member count computed in the same read. */
const projectSelection = (principal: Principal) => ({
  id: projects.id,
  name: projects.name,
  description: projects.description,
  metadata: projects.metadata,
  archivedAt: projects.archivedAt,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  myRole: projectRoleExpression(principal, PROJECTS_ID),
  // People and teams alike: what the members list shows.
  memberCount: sql<number>`(SELECT count(*)::int FROM project_members prj_count WHERE prj_count.project_id = ${PROJECTS_ID})
    + (SELECT count(*)::int FROM project_teams prj_tcount WHERE prj_tcount.project_id = ${PROJECTS_ID})`
});

// The members list pages with the value-carrying cursor (`keysetBeforeValue`):
// project_members HARD-deletes rows, so a cursor naming a member removed
// between two pages would compare against NULL under `keysetBefore` and end
// the roster early. The timestamp rides as Postgres rendered it, never as a
// JS Date, so a millisecond shared by two rows loses nobody.
const memberSelection = {
  id: projectMembers.id,
  createdAtText: createdAtText(projectMembers.createdAt),
  userId: workspaceMembers.userId,
  email: userTable.email,
  name: userTable.name,
  role: projectMembers.role,
  addedBy: projectMembers.addedBy,
  createdAt: projectMembers.createdAt
};

/** A team's entry on a project, joined to the team; the same cursor columns as a person's. */
const teamSelection = {
  id: projectTeams.id,
  createdAtText: createdAtText(projectTeams.createdAt),
  teamId: workspaceTeams.id,
  slug: workspaceTeams.slug,
  name: workspaceTeams.name,
  membersCount: TEAM_MEMBERS_COUNT,
  hubTeamId: workspaceTeams.hubTeamId,
  role: projectTeams.role,
  addedBy: projectTeams.addedBy,
  createdAt: projectTeams.createdAt
};

/** One row of the members list's union: a person's or a team's entry, the unused columns null. */
interface MemberUnionRow {
  kind: 'person' | 'team';
  id: string;
  created_at_text: string;
  created_at: Date;
  role: ProjectRole;
  added_by: string | null;
  user_id: string | null;
  email: string | null;
  name: string;
  team_id: string | null;
  slug: string | null;
  members_count: number | null;
  hub_team_id: string | null;
}

export function registerProjectRoutes(api: OpenAPIHono, deps: ProjectRouteDeps): void {
  const { db } = deps;

  // Projects are a workspace-level surface: a guest membership exists for
  // principal resolution only (D2) and is refused the whole subtree, flat, on
  // both editions and for every credential. The predicates refuse a guest a
  // second time (`projects/access.ts`): this gate is the truthful answer, that
  // clause is what a tool's own rule inherits.
  for (const path of ['/projects', '/projects/*']) {
    api.use(path, requireAuth());
    api.use(path, requireNonGuest());
  }

  /** One project of the request's workspace AS THE CALLER reads it, or null (= 404). */
  async function readProject(
    conn: DbConn,
    principal: Principal,
    id: string
  ): Promise<(ProjectWireRow & { myRole: ProjectRole }) | null> {
    const [row] = await conn
      .select(projectSelection(principal))
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!row || row.myRole === null) return null;
    return { ...row, myRole: row.myRole };
  }

  /**
   * The gate of every mutation, in its fixed order: 404, then 403, then 409.
   * Returns the project as the caller reads it, or the response to send.
   */
  async function gateMutation(
    c: Context,
    id: string,
    min: ProjectRole,
    opts: { allowArchived?: boolean } = {}
  ): Promise<{ project: ProjectWireRow & { myRole: ProjectRole } } | { response: Response }> {
    const principal = c.get('principal')!;
    const project = await readProject(db, principal, id);
    if (!project) return { response: c.json(notFound(), 404) };
    if (!projectRoleAtLeast(project.myRole, min)) {
      return {
        response: c.json(err('insufficient_project_role', `This needs the ${min} role on the project`), 403)
      };
    }
    if (project.archivedAt !== null && !opts.allowArchived) {
      return { response: c.json(archived(), 409) };
    }
    return { project };
  }

  const archived = () => err('project_archived', 'The project is archived: unarchive it to change it');

  /**
   * Runs a membership write while holding the project row FOR SHARE, after
   * re-reading its archive state under that lock. Archiving UPDATEs the row,
   * so it waits for the write (or the write sees it): an archive landing
   * between the gate and the write can never be overtaken. `null` = archived.
   */
  async function whileLive<T>(
    principal: Principal,
    id: string,
    write: (tx: DbConn) => Promise<T>
  ): Promise<T | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.workspaceId, principal.workspaceId)))
        .for('share')
        .limit(1);
      if (!row || row.archivedAt !== null) return null;
      return write(tx);
    });
  }

  // ── List ─────────────────────────────────────────────────────────────────
  api.openapi(projectsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit, archived: archivedFilter } = c.req.valid('query');
    const cursorId = cursorRowId(cursor);
    const rows = await db
      .select(projectSelection(principal))
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, principal.workspaceId),
          // The read rule, the same builder a tool uses: a member's page is
          // the projects they hold a grant on, an owner's or admin's is all.
          projectGrantPredicate(principal, PROJECTS_ID, { atLeast: 'viewer', access: 'read' }),
          ...(archivedFilter === 'false' ? [isNull(projects.archivedAt)] : []),
          ...(archivedFilter === 'true' ? [isNotNull(projects.archivedAt)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: projects,
                  id: projects.id,
                  createdAt: projects.createdAt,
                  workspaceId: projects.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    // The WHERE is the rule: every selected row carries a role.
    return c.json({ projects: page.map((p) => toWire({ ...p, myRole: p.myRole! })), nextCursor }, 200);
  });

  // ── Create ───────────────────────────────────────────────────────────────
  // Any non-guest member creates a project and becomes its first manager in
  // the SAME transaction: a project is never born without someone to manage it
  // (an owner or admin could anyway, but the creator should not need one).
  api.openapi(projectCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const body = c.req.valid('json');
    const created = await db.transaction(async (tx) => {
      const [membership] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, principal.workspaceId),
            eq(workspaceMembers.userId, principal.userId),
            eq(workspaceMembers.isActive, true)
          )
        )
        .limit(1);
      if (!membership) return null;
      const [project] = await tx
        .insert(projects)
        .values({
          workspaceId: principal.workspaceId,
          name: body.name,
          description: body.description ?? null,
          metadata: body.metadata ?? {},
          createdBy: principal.userId
        })
        .returning({ id: projects.id });
      await tx.insert(projectMembers).values({
        projectId: project!.id,
        memberId: membership.id,
        role: 'manager',
        addedBy: principal.userId
      });
      return readProject(tx, principal, project!.id);
    });
    // The principal resolved from an active membership a moment ago; losing
    // it mid-request is a revoked caller, answered like any other.
    if (!created) return c.json(err('unauthenticated', 'Authentication required'), 401);
    c.set('audit', {
      action: 'project.create',
      resourceType: 'project',
      resourceId: created.id,
      metadata: { name: created.name }
    });
    return c.json(toWire(created), 201);
  });

  // ── Get ──────────────────────────────────────────────────────────────────
  api.openapi(projectGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const project = await readProject(db, principal, id);
    if (!project) return c.json(notFound(), 404);
    return c.json(toWire(project), 200);
  });

  // ── Update ───────────────────────────────────────────────────────────────
  api.openapi(projectUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    // `archived_at IS NULL` again in the WHERE: an archive landing between
    // the gate and this write must win.
    const updated = await db
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updatedAt: new Date()
      })
      .where(
        and(eq(projects.id, id), eq(projects.workspaceId, principal.workspaceId), isNull(projects.archivedAt))
      )
      .returning({ id: projects.id });
    if (updated.length === 0) return c.json(archived(), 409);
    const project = (await readProject(db, principal, id))!;
    c.set('audit', {
      action: 'project.update',
      resourceType: 'project',
      resourceId: id,
      metadata: { fields: Object.keys(patch) }
    });
    return c.json(toWire(project), 200);
  });

  // ── Archive / unarchive ──────────────────────────────────────────────────
  // A project is never deleted. Archiving cascades onto NOTHING: what a tool
  // linked to the project keeps working; only writes THROUGH a project grant
  // stop (the archived-write rule of the predicate).
  api.openapi(projectArchiveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    const updated = await db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(projects.id, id), eq(projects.workspaceId, principal.workspaceId), isNull(projects.archivedAt))
      )
      .returning({ id: projects.id });
    if (updated.length === 0) return c.json(archived(), 409);
    const project = (await readProject(db, principal, id))!;
    c.set('audit', { action: 'project.archive', resourceType: 'project', resourceId: id });
    return c.json(toWire(project), 200);
  });

  api.openapi(projectUnarchiveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const gate = await gateMutation(c, id, 'manager', { allowArchived: true });
    if ('response' in gate) return gate.response as never;
    const updated = await db
      .update(projects)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(projects.id, id),
          eq(projects.workspaceId, principal.workspaceId),
          isNotNull(projects.archivedAt)
        )
      )
      .returning({ id: projects.id });
    if (updated.length === 0) {
      return c.json(err('project_not_archived', 'The project is not archived'), 409);
    }
    const project = (await readProject(db, principal, id))!;
    c.set('audit', { action: 'project.unarchive', resourceType: 'project', resourceId: id });
    return c.json(toWire(project), 200);
  });

  // ── Members ──────────────────────────────────────────────────────────────
  // People and teams in ONE list, newest first, on one value-carrying cursor
  // (`created_at`, `id`) that both tables answer: the cursor is applied inside
  // each branch, so a page is the same page whichever kind the boundary row
  // is. Raw SQL because a set operation is where drizzle's builder stops.
  api.openapi(projectMembersListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    if ((await projectRole(db, principal, id)) === null) return c.json(notFound(), 404);
    const after = decodeKeysetCursor(cursor);
    const before = (createdAt: string, rowId: string) =>
      after
        ? sql`AND (${sql.raw(createdAt)}, ${sql.raw(rowId)}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
        : sql``;
    const result = await db.execute(sql`
      SELECT 'person' AS kind, pm.id, pm.created_at::text AS created_at_text, pm.created_at, pm.role, pm.added_by,
             wm.user_id, u.email, u.name,
             NULL::uuid AS team_id, NULL::text AS slug, NULL::int AS members_count, NULL::text AS hub_team_id
        FROM project_members pm
        JOIN workspace_members wm ON wm.id = pm.member_id
        JOIN "user" u ON u.id = wm.user_id
       WHERE pm.project_id = ${id} ${before('pm.created_at', 'pm.id')}
      UNION ALL
      SELECT 'team' AS kind, pt.id, pt.created_at::text AS created_at_text, pt.created_at, pt.role, pt.added_by,
             NULL::text AS user_id, NULL::text AS email, t.name,
             t.id AS team_id, t.slug,
             (SELECT count(*)::int FROM workspace_team_members tm WHERE tm.team_id = t.id) AS members_count,
             t.hub_team_id
        FROM project_teams pt
        JOIN workspace_teams t ON t.id = pt.team_id
       WHERE pt.project_id = ${id} ${before('pt.created_at', 'pt.id')}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `);
    const rows = result.rows as unknown as MemberUnionRow[];
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    const members = page.map((row) =>
      row.kind === 'person'
        ? memberToWire({
            userId: row.user_id!,
            email: row.email!,
            name: row.name,
            role: row.role,
            addedBy: row.added_by,
            createdAt: new Date(row.created_at)
          })
        : teamToWire({
            teamId: row.team_id!,
            slug: row.slug!,
            name: row.name,
            membersCount: row.members_count ?? 0,
            hubTeamId: row.hub_team_id,
            role: row.role,
            addedBy: row.added_by,
            createdAt: new Date(row.created_at)
          })
    );
    return c.json(
      {
        members,
        nextCursor: last ? encodeKeysetCursor({ id: last.id, createdAtText: last.created_at_text }) : null
      },
      200
    );
  });

  /** One member of one project, by the person's user id, or undefined. */
  async function findProjectMember(conn: DbConn, projectId: string, userId: string) {
    const [row] = await conn
      .select(memberSelection)
      .from(projectMembers)
      .innerJoin(workspaceMembers, eq(projectMembers.memberId, workspaceMembers.id))
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(projectMembers.projectId, projectId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return row;
  }

  /** One team's entry on one project, by the team id, or undefined. */
  async function findProjectTeam(conn: DbConn, projectId: string, teamId: string) {
    const [row] = await conn
      .select(teamSelection)
      .from(projectTeams)
      .innerJoin(workspaceTeams, eq(projectTeams.teamId, workspaceTeams.id))
      .where(and(eq(projectTeams.projectId, projectId), eq(workspaceTeams.id, teamId)))
      .limit(1);
    return row;
  }

  /**
   * Adds a team of the request's workspace to the project (PRDCT-2794): the
   * team side of the members POST. A team of another workspace, or none, is
   * 404 `team_not_found`; a repeat is 409 `already_member`.
   */
  async function addTeam(c: Context, id: string, teamId: string, role: ProjectRole): Promise<Response> {
    const principal = c.get('principal')!;
    const [team] = await db
      .select({
        teamId: workspaceTeams.id,
        slug: workspaceTeams.slug,
        name: workspaceTeams.name,
        membersCount: TEAM_MEMBERS_COUNT,
        hubTeamId: workspaceTeams.hubTeamId
      })
      .from(workspaceTeams)
      .where(and(eq(workspaceTeams.id, teamId), eq(workspaceTeams.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!team) return c.json(err('team_not_found', 'No team of this workspace matches'), 404);
    let inserted: { createdAt: Date }[] | null;
    try {
      inserted = await whileLive(principal, id, (tx) =>
        tx
          .insert(projectTeams)
          .values({ projectId: id, teamId: team.teamId, role, addedBy: principal.userId })
          .onConflictDoNothing({ target: [projectTeams.projectId, projectTeams.teamId] })
          .returning({ createdAt: projectTeams.createdAt })
      );
    } catch (cause) {
      // The team went between the read above and the insert (a delete at the
      // hub's next pass, an admin's): the foreign key says so, and the answer
      // is the same 404 as a team that never was (verifier round 1, F2).
      if (isForeignKeyViolation(cause, PROJECT_TEAM_FK)) {
        return c.json(err('team_not_found', 'No team of this workspace matches'), 404);
      }
      throw cause;
    }
    if (inserted === null) return c.json(archived(), 409);
    const [row] = inserted;
    if (!row) return c.json(err('already_member', 'This team is already a member of the project'), 409);
    c.set('audit', {
      action: 'project.team_add',
      resourceType: 'project',
      resourceId: id,
      metadata: { teamId: team.teamId, role }
    });
    return c.json(teamToWire({ ...team, role, addedBy: principal.userId, createdAt: row.createdAt }), 201);
  }

  api.openapi(projectMemberAddRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    if (body.teamId !== undefined) return (await addTeam(c, id, body.teamId, body.role)) as never;

    // The target comes from THIS workspace's own roster, by user id or by
    // email, and nowhere else: nothing is invited, claimed or minted here.
    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        origin: workspaceMembers.origin,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          body.userId !== undefined
            ? eq(workspaceMembers.userId, body.userId)
            : sql`lower(${userTable.email}) = ${body.email!.toLowerCase()}`
        )
      )
      .limit(1);
    if (!target || !target.isActive) {
      return c.json(err('member_not_found', 'No active member of this workspace matches'), 404);
    }
    // A guest membership exists for principal resolution only (D2): it can
    // never hold a project grant. The predicates would ignore the row anyway;
    // refusing it here keeps the table honest.
    if (target.origin === 'guest') {
      return c.json(
        err(
          'guest_target',
          'A guest cannot be a project member: invite them to the workspace as a member first'
        ),
        403
      );
    }
    const inserted = await whileLive(principal, id, (tx) =>
      tx
        .insert(projectMembers)
        .values({ projectId: id, memberId: target.id, role: body.role, addedBy: principal.userId })
        .onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.memberId] })
        .returning({ createdAt: projectMembers.createdAt })
    );
    if (inserted === null) return c.json(archived(), 409);
    const [row] = inserted;
    if (!row) {
      return c.json(err('already_member', 'This person is already a member of the project'), 409);
    }
    // The answer is built from what the insert returned and the target row
    // read above, never from a re-read outside the transaction: a removal
    // landing in between would turn a succeeded add into a 500.
    const member = { ...target, role: body.role, addedBy: principal.userId, createdAt: row.createdAt };
    c.set('audit', {
      action: 'project.member_add',
      resourceType: 'project',
      resourceId: id,
      metadata: { targetUserId: target.userId, role: body.role }
    });
    return c.json(memberToWire(member), 201);
  });

  api.openapi(projectMemberRoleRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, userId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    const target = await findProjectMember(db, id, userId);
    if (!target) return c.json(err('member_not_found', 'This person is not a member of the project'), 404);
    const done = await whileLive(principal, id, (tx) =>
      tx.update(projectMembers).set({ role }).where(eq(projectMembers.id, target.id))
    );
    if (done === null) return c.json(archived(), 409);
    c.set('audit', {
      action: 'project.member_role',
      resourceType: 'project',
      resourceId: id,
      metadata: { targetUserId: userId, from: target.role, to: role }
    });
    return c.json(memberToWire({ ...target, role }), 200);
  });

  // A manager removes anyone; any member removes THEMSELVES, whatever their
  // role. There is no last-manager guard: a workspace owner or admin manages
  // every project, so none is ever locked.
  api.openapi(projectMemberRemoveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, userId } = c.req.valid('param');
    const self = userId === principal.userId;
    const gate = await gateMutation(c, id, self ? 'viewer' : 'manager');
    if ('response' in gate) return gate.response as never;
    const target = await findProjectMember(db, id, userId);
    if (!target) return c.json(err('member_not_found', 'This person is not a member of the project'), 404);
    const done = await whileLive(principal, id, (tx) =>
      tx.delete(projectMembers).where(eq(projectMembers.id, target.id))
    );
    if (done === null) return c.json(archived(), 409);
    c.set('audit', {
      action: 'project.member_remove',
      resourceType: 'project',
      resourceId: id,
      metadata: { targetUserId: userId, role: target.role, self }
    });
    return c.json(memberToWire(target), 200);
  });

  // ── Teams on a project (PRDCT-2794) ──────────────────────────────────────
  // The same gate and order as a person's entry: 404, 403, 409. A team is
  // never "itself" (no self-removal branch): a manager acts, or an owner or
  // admin of the workspace.
  api.openapi(projectTeamRoleRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, teamId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    const target = await findProjectTeam(db, id, teamId);
    if (!target) return c.json(err('team_not_found', 'This team is not a member of the project'), 404);
    const done = await whileLive(principal, id, (tx) =>
      tx.update(projectTeams).set({ role }).where(eq(projectTeams.id, target.id))
    );
    if (done === null) return c.json(archived(), 409);
    c.set('audit', {
      action: 'project.team_role',
      resourceType: 'project',
      resourceId: id,
      metadata: { teamId, from: target.role, to: role }
    });
    return c.json(teamToWire({ ...target, role }), 200);
  });

  api.openapi(projectTeamRemoveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, teamId } = c.req.valid('param');
    const gate = await gateMutation(c, id, 'manager');
    if ('response' in gate) return gate.response as never;
    const target = await findProjectTeam(db, id, teamId);
    if (!target) return c.json(err('team_not_found', 'This team is not a member of the project'), 404);
    const done = await whileLive(principal, id, (tx) =>
      tx.delete(projectTeams).where(eq(projectTeams.id, target.id))
    );
    if (done === null) return c.json(archived(), 409);
    c.set('audit', {
      action: 'project.team_remove',
      resourceType: 'project',
      resourceId: id,
      metadata: { teamId, role: target.role }
    });
    return c.json(teamToWire(target), 200);
  });
}
