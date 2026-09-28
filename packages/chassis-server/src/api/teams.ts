import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { teamSlugSchema, type Principal } from '@antasphere/chassis-contract';
import {
  teamCreateRoute,
  teamDeleteRoute,
  teamGetRoute,
  teamMemberAddRoute,
  teamMemberRemoveRoute,
  teamMembersListRoute,
  teamsListRoute,
  teamUpdateRoute
} from '@antasphere/chassis-contract/routes';
import {
  user as userTable,
  workspaceMembers,
  workspaceTeamMembers,
  workspaceTeams,
  type Db
} from '@antasphere/chassis-db';
import { requireAuth, requireNonGuest } from '../middleware/auth-context.js';
import { HUB_MANAGED_TEAMS_MESSAGE, hubManagedMembershipGate } from '../middleware/hub-managed.js';
import { holdLiveMembership } from '../members/removal.js';
import { createdAtText, decodeKeysetCursor, encodeKeysetCursor, keysetBeforeValue } from '../pagination.js';

/**
 * The team routes (PRDCT-2813): the same routes on both editions, only the
 * source of a team differs. On the self-hosted edition, and in a cloud-LOCAL
 * workspace, owners and admins make and shape teams here (`hub_team_id` NULL,
 * the tool's own). In a hub-origin workspace the teams are the hub's
 * projection (`hub_team_id` set, written by the reconciler alone): read here,
 * managed on the account site. Two locks keep a write off a projected team:
 * the members' `hub_managed` gate refuses every write of a hub-origin
 * workspace (cloud), and every write's WHERE carries `hub_team_id IS NULL`, a
 * projected team met by a write answering the same `hub_managed` refusal.
 *
 * A team holds the workspace's MEMBERSHIPS (the seat references
 * `workspace_members` with ON DELETE CASCADE), so it can never hold an
 * outsider and a person leaves every team with their membership. Nothing is
 * invited, claimed or minted here.
 *
 * Reads (list, one team, its members) are every non-guest member's; writes are
 * an owner's or an admin's, checked INSIDE each handler, never by a
 * path-pattern `requireRole`: `GET /teams/{id}/members` lives under the same
 * prefix and must stay open to every member (LESSONS, the `/thing/:id` trap).
 * A team of another workspace reads as absent: 404, never 403.
 */
export interface TeamRouteDeps {
  db: Db;
  /**
   * Cloud edition only: when set, every write on a hub-origin workspace
   * answers 403 `hub_managed` with this pointer (the members' gate).
   * undefined on oss.
   */
  hubManaged?: { manageUrl: string } | undefined;
}

const err = (code: string, message: string) => ({ error: { code, message } });

const canManage = (principal: Principal) => principal.role === 'owner' || principal.role === 'admin';
const FORBIDDEN = err('forbidden', 'Only an owner or an admin manages teams');
const SLUG_TAKEN = err('slug_taken', 'Another team of this workspace already uses that slug');
const TEAM_NOT_FOUND = err('not_found', 'Team not found');
const MEMBER_NOT_FOUND = err('member_not_found', 'No active member of this workspace matches');
const NOT_SEATED = err('member_not_found', 'This person is not a member of the team');

/** The partial unique index of a local team's slug (Postgres reports the INDEX name as the constraint). */
const LOCAL_SLUG_INDEX = 'workspace_teams_workspace_slug_local_uniq';

/**
 * The slug a name yields when none is given: lowercased, accents folded,
 * every run of other characters one dash, no dash at either end, at most 60
 * characters. Null when nothing of the name survives (a name of symbols).
 */
export function slugFromName(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // the combining marks NFKD split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return teamSlugSchema.safeParse(slug).success ? slug : null;
}

/** The driver's error down drizzle's `cause` chain (the first link carrying a SQLSTATE), at most ten deep. */
function pgLink(e: unknown): { code: string; constraint?: unknown } | undefined {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 10; cur = cur.cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return cur as unknown as { code: string; constraint?: unknown };
    }
  }
  return undefined;
}

/** A Postgres unique violation on the given constraint or unique index. */
const isUniqueViolation = (e: unknown, constraint: string): boolean => {
  const link = pgLink(e);
  return link?.code === '23505' && link.constraint === constraint;
};

/** A Postgres foreign-key violation (a parent removed mid-flight). */
const isForeignKeyViolation = (e: unknown): boolean => pgLink(e)?.code === '23503';

type TeamRow = {
  id: string;
  slug: string;
  name: string;
  hubTeamId: string | null;
  membersCount: number;
  isMember: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const teamToWire = (t: TeamRow) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  membersCount: Number(t.membersCount),
  isMember: Boolean(t.isMember),
  hubTeamId: t.hubTeamId,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString()
});

type TeamMemberRow = {
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  isActive: boolean;
  addedAt: Date;
};

const memberToWire = (m: TeamMemberRow) => ({
  userId: m.userId,
  email: m.email,
  name: m.name,
  role: m.role,
  isActive: m.isActive,
  addedAt: m.addedAt.toISOString()
});

/**
 * The team's wire columns, with its member count and whether the caller sits
 * in it. The correlated subqueries spell their columns table-qualified by
 * hand: drizzle renders a one-table select's columns bare, and a bare "id"
 * inside the subquery would bind to the subquery's own table.
 */
const teamColumns = (principal: Principal) => ({
  id: workspaceTeams.id,
  slug: workspaceTeams.slug,
  name: workspaceTeams.name,
  hubTeamId: workspaceTeams.hubTeamId,
  membersCount: sql<number>`(SELECT count(*)::int FROM "workspace_team_members" "wtm_count" WHERE "wtm_count"."team_id" = "workspace_teams"."id")`,
  isMember: sql<boolean>`EXISTS (SELECT 1 FROM "workspace_team_members" "wtm_me" INNER JOIN "workspace_members" "wm_me" ON "wm_me"."id" = "wtm_me"."member_id" WHERE "wtm_me"."team_id" = "workspace_teams"."id" AND "wm_me"."user_id" = ${principal.userId} AND "wm_me"."workspace_id" = ${principal.workspaceId})`,
  createdAt: workspaceTeams.createdAt,
  updatedAt: workspaceTeams.updatedAt
});

// The members list pages with the value-carrying cursor (`keysetBeforeValue`):
// workspace_team_members HARD-deletes rows, so a cursor naming a seat removed
// between two pages must not end the roster early.
const memberSelection = {
  id: workspaceTeamMembers.id,
  createdAtText: createdAtText(workspaceTeamMembers.createdAt),
  userId: workspaceMembers.userId,
  email: userTable.email,
  name: userTable.name,
  role: workspaceMembers.role,
  isActive: workspaceMembers.isActive,
  addedAt: workspaceTeamMembers.createdAt
};

export function registerTeamRoutes(api: OpenAPIHono, deps: TeamRouteDeps): void {
  const { db, hubManaged } = deps;

  // The members' mount order: the hub-managed gate first (cloud only), so any
  // authenticated caller of a hub-origin workspace gets the truthful refusal
  // on a write; then the auth gate; then the guest refusal (teams are a
  // workspace-level surface, refused to a guest flat, on both editions).
  for (const path of ['/teams', '/teams/*']) {
    if (hubManaged) api.use(path, hubManagedMembershipGate(hubManaged.manageUrl, HUB_MANAGED_TEAMS_MESSAGE));
    api.use(path, requireAuth());
    api.use(path, requireNonGuest());
  }

  /** The refusal a write meets on a projected team (the second lock, beside the gate). */
  const PROJECTED = {
    error: {
      code: 'hub_managed',
      message: HUB_MANAGED_TEAMS_MESSAGE,
      details: { manageUrl: hubManaged?.manageUrl ?? null }
    }
  };

  /** One team of the principal's workspace, or undefined (another workspace's team reads as absent). */
  const loadTeam = async (principal: Principal, id: string): Promise<TeamRow | undefined> => {
    const [row] = await db
      .select(teamColumns(principal))
      .from(workspaceTeams)
      .where(and(eq(workspaceTeams.id, id), eq(workspaceTeams.workspaceId, principal.workspaceId)))
      .limit(1);
    return row;
  };

  /** The team's id and source when it belongs to the principal's workspace. */
  const teamInWorkspace = async (principal: Principal, id: string) => {
    const [row] = await db
      .select({ id: workspaceTeams.id, hubTeamId: workspaceTeams.hubTeamId })
      .from(workspaceTeams)
      .where(and(eq(workspaceTeams.id, id), eq(workspaceTeams.workspaceId, principal.workspaceId)))
      .limit(1);
    return row;
  };

  // ── List ─────────────────────────────────────────────────────────────────
  // The list pages with the value-carrying cursor, like the seats and the
  // project members: workspace_teams HARD-deletes rows, so an id-only cursor
  // naming a team deleted between two pages would end the list early
  // (verifier round 1, F3).
  api.openapi(teamsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const after = decodeKeysetCursor(cursor);
    const rows = await db
      .select({ ...teamColumns(principal), createdAtText: createdAtText(workspaceTeams.createdAt) })
      .from(workspaceTeams)
      .where(
        and(
          eq(workspaceTeams.workspaceId, principal.workspaceId),
          ...(after
            ? [
                keysetBeforeValue({
                  id: workspaceTeams.id,
                  createdAt: workspaceTeams.createdAt,
                  cursor: after
                })
              ]
            : [])
        )
      )
      .orderBy(desc(workspaceTeams.createdAt), desc(workspaceTeams.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return c.json({ teams: page.map(teamToWire), nextCursor: last ? encodeKeysetCursor(last) : null }, 200);
  });

  // ── Get ──────────────────────────────────────────────────────────────────
  api.openapi(teamGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const team = await loadTeam(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404);
    return c.json(teamToWire(team), 200);
  });

  // ── Create ───────────────────────────────────────────────────────────────
  api.openapi(teamCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const body = c.req.valid('json');
    const slug = body.slug ?? slugFromName(body.name);
    if (!slug) {
      return c.json(err('validation_error', 'The name yields no slug: give the team a slug'), 400);
    }

    let id: string;
    try {
      const [inserted] = await db
        .insert(workspaceTeams)
        .values({
          workspaceId: principal.workspaceId,
          hubTeamId: null,
          slug,
          name: body.name,
          createdBy: principal.userId
        })
        .returning({ id: workspaceTeams.id });
      id = inserted!.id;
    } catch (cause) {
      if (isUniqueViolation(cause, LOCAL_SLUG_INDEX)) return c.json(SLUG_TAKEN, 409);
      throw cause;
    }

    const team = await loadTeam(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404); // deleted between the two statements
    c.set('audit', {
      action: 'team.create',
      resourceType: 'team',
      resourceId: id,
      metadata: { slug, name: body.name }
    });
    return c.json(teamToWire(team), 201);
  });

  // ── Update ───────────────────────────────────────────────────────────────
  api.openapi(teamUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');

    const found = await teamInWorkspace(principal, id);
    if (!found) return c.json(TEAM_NOT_FOUND, 404);
    if (found.hubTeamId !== null) return c.json(PROJECTED, 403);

    let updated: { id: string } | undefined;
    try {
      [updated] = await db
        .update(workspaceTeams)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
          updatedAt: sql`now()`
        })
        .where(
          and(
            eq(workspaceTeams.id, id),
            eq(workspaceTeams.workspaceId, principal.workspaceId),
            isNull(workspaceTeams.hubTeamId)
          )
        )
        .returning({ id: workspaceTeams.id });
    } catch (cause) {
      if (isUniqueViolation(cause, LOCAL_SLUG_INDEX)) return c.json(SLUG_TAKEN, 409);
      throw cause;
    }
    if (!updated) return c.json(TEAM_NOT_FOUND, 404); // deleted between the two statements

    const team = await loadTeam(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404);
    c.set('audit', {
      action: 'team.update',
      resourceType: 'team',
      resourceId: id,
      metadata: { ...patch }
    });
    return c.json(teamToWire(team), 200);
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  // Seats and project entries go by the foreign keys' cascade.
  api.openapi(teamDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');

    // Snapshot first: the count needs the seat rows the cascade removes.
    const snapshot = await loadTeam(principal, id);
    if (!snapshot) return c.json(TEAM_NOT_FOUND, 404);
    if (snapshot.hubTeamId !== null) return c.json(PROJECTED, 403);
    const [deleted] = await db
      .delete(workspaceTeams)
      .where(
        and(
          eq(workspaceTeams.id, id),
          eq(workspaceTeams.workspaceId, principal.workspaceId),
          isNull(workspaceTeams.hubTeamId)
        )
      )
      .returning({ id: workspaceTeams.id });
    if (!deleted) return c.json(TEAM_NOT_FOUND, 404);

    c.set('audit', {
      action: 'team.delete',
      resourceType: 'team',
      resourceId: id,
      metadata: { slug: snapshot.slug, name: snapshot.name, membersCount: Number(snapshot.membersCount) }
    });
    return c.json(teamToWire(snapshot), 200);
  });

  // ── Members ──────────────────────────────────────────────────────────────
  // Every member of the workspace reads a team's members: no role check.
  api.openapi(teamMembersListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const team = await teamInWorkspace(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404);

    const after = decodeKeysetCursor(cursor);
    const rows = await db
      .select(memberSelection)
      .from(workspaceTeamMembers)
      .innerJoin(workspaceMembers, eq(workspaceMembers.id, workspaceTeamMembers.memberId))
      .innerJoin(userTable, eq(userTable.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceTeamMembers.teamId, team.id),
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          ...(after
            ? [
                keysetBeforeValue({
                  id: workspaceTeamMembers.id,
                  createdAt: workspaceTeamMembers.createdAt,
                  cursor: after
                })
              ]
            : [])
        )
      )
      .orderBy(desc(workspaceTeamMembers.createdAt), desc(workspaceTeamMembers.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return c.json(
      { members: page.map(memberToWire), nextCursor: last ? encodeKeysetCursor(last) : null },
      200
    );
  });

  api.openapi(teamMemberAddRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const team = await teamInWorkspace(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404);
    if (team.hubTeamId !== null) return c.json(PROJECTED, 403);

    // The target comes from THIS workspace's own roster, by user id or by
    // email, and nowhere else.
    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
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
    if (!target || !target.isActive) return c.json(MEMBER_NOT_FOUND, 404);
    // A guest membership exists for principal resolution only (D2): it never
    // sits in a team.
    if (target.origin === 'guest') {
      return c.json(
        err('guest_target', 'A guest cannot sit in a team: invite them to the workspace as a member first'),
        403
      );
    }

    // The insert runs while the team row is held FOR SHARE and re-read as the
    // tool's own: a team that turned out projected, or went, is never seated.
    let outcome: { createdAt: Date } | 'gone' | 'member_gone' | 'repeat';
    try {
      outcome = await db.transaction(async (tx) => {
        const [live] = await tx
          .select({ id: workspaceTeams.id })
          .from(workspaceTeams)
          .where(
            and(
              eq(workspaceTeams.id, team.id),
              eq(workspaceTeams.workspaceId, principal.workspaceId),
              isNull(workspaceTeams.hubTeamId)
            )
          )
          .for('share')
          .limit(1);
        if (!live) return 'gone' as const;
        // The read above builds the answer; this locked re-read is the one
        // that counts (`holdLiveMembership`): a removal that landed since is
        // seen here, one still running waits and takes the seat in its second pass.
        if (!(await holdLiveMembership(tx, principal.workspaceId, { memberId: target.id }))) {
          return 'member_gone' as const;
        }
        // A seat already there answers the repeat WITHOUT an insert (the
        // verifier's F4: 14 of 40 removals answered 500). Under the membership
        // share lock, a removal's uncommitted delete of this seat keeps the row
        // visible to a plain read, so the add answers 409 and never waits on
        // that delete, while the removal's update waits on the add's share
        // lock: an insert here would wait on the delete, a cycle.
        const [existing] = await tx
          .select({ id: workspaceTeamMembers.id })
          .from(workspaceTeamMembers)
          .where(and(eq(workspaceTeamMembers.teamId, team.id), eq(workspaceTeamMembers.memberId, target.id)))
          .limit(1);
        if (existing) return 'repeat' as const;
        const [row] = await tx
          .insert(workspaceTeamMembers)
          .values({ teamId: team.id, memberId: target.id, addedBy: principal.userId })
          .onConflictDoNothing({ target: [workspaceTeamMembers.teamId, workspaceTeamMembers.memberId] })
          .returning({ createdAt: workspaceTeamMembers.createdAt });
        return row ?? ('repeat' as const);
      });
    } catch (cause) {
      // The membership was removed between the check and the insert.
      if (isForeignKeyViolation(cause)) return c.json(MEMBER_NOT_FOUND, 404);
      throw cause;
    }
    if (outcome === 'gone') return c.json(TEAM_NOT_FOUND, 404);
    if (outcome === 'member_gone') return c.json(MEMBER_NOT_FOUND, 404);
    if (outcome === 'repeat') {
      return c.json(err('already_member', 'This person is already a member of the team'), 409);
    }

    // Built from the target row and the insert's own `createdAt`, never from a
    // re-read outside the transaction (a removal in between would 500 it).
    c.set('audit', {
      action: 'team.member_add',
      resourceType: 'team',
      resourceId: team.id,
      metadata: { targetUserId: target.userId }
    });
    return c.json(memberToWire({ ...target, addedAt: outcome.createdAt }), 201);
  });

  api.openapi(teamMemberRemoveRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id, userId } = c.req.valid('param');

    const team = await teamInWorkspace(principal, id);
    if (!team) return c.json(TEAM_NOT_FOUND, 404);
    if (team.hubTeamId !== null) return c.json(PROJECTED, 403);

    const [seat] = await db
      .select({ ...memberSelection, memberId: workspaceMembers.id })
      .from(workspaceTeamMembers)
      .innerJoin(workspaceMembers, eq(workspaceMembers.id, workspaceTeamMembers.memberId))
      .innerJoin(userTable, eq(userTable.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceTeamMembers.teamId, team.id),
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .limit(1);
    if (!seat) return c.json(NOT_SEATED, 404);

    const [removed] = await db
      .delete(workspaceTeamMembers)
      .where(
        and(
          eq(workspaceTeamMembers.id, seat.id),
          inArray(
            workspaceTeamMembers.teamId,
            db
              .select({ id: workspaceTeams.id })
              .from(workspaceTeams)
              .where(and(eq(workspaceTeams.id, team.id), isNull(workspaceTeams.hubTeamId)))
          )
        )
      )
      .returning({ id: workspaceTeamMembers.id });
    if (!removed) return c.json(NOT_SEATED, 404);

    c.set('audit', {
      action: 'team.member_remove',
      resourceType: 'team',
      resourceId: team.id,
      metadata: { targetUserId: userId }
    });
    return c.json(memberToWire(seat), 200);
  });
}
