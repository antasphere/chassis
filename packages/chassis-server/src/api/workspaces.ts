import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { ACTIVE_WORKSPACE_HEADER } from '@antasphere/chassis-contract';
import { workspaceCreateRoute, workspaceUpdateRoute } from '@antasphere/chassis-contract/routes';
import type { WorkspaceLook } from '@antasphere/chassis-contract';
import { workspaceMembers, workspaces, type Db, type DbConn } from '@antasphere/chassis-db';
import type { AuditService } from '../audit/service.js';
import type { Auth } from '../identity/better-auth.js';
import { projectOrgMembership } from '../identity/hub-projection.js';
import { requireRole } from '../middleware/auth-context.js';
import type { ReconcilePassOutcome } from '../identity/hub-reconcile.js';
import type { HubOrgCreator } from '../identity/hub-user-client.js';
import type { Logger } from '../logger.js';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { ClientIpFn } from '../middleware/rate-limit.js';
import type { PlatformRegistry } from '../platform/registry.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /workspaces — a signed-in person creates ANOTHER workspace from inside
 * the product (PRDCT-2444 self-hosted, PRDCT-2443 cloud). ADR 014 kept this
 * door shut in the template ("workspace creation is a product decision");
 * this module is that decision, taken.
 *
 * One route, two editions:
 *  - oss: `WorkspaceService.create` (the setup path) under a per-user
 *    advisory lock + the operator's `MAX_WORKSPACES_PER_USER` cap — the
 *    hub's `POST /orgs` model, mirrored.
 *  - cloud: the organization is created AT THE HUB as the caller (their own
 *    stored grant, ADR 019 — no service key, no target-user parameter), then
 *    the caller's reconcile is forced so the local projection and the
 *    `origin='hub'` owner membership exist before the answer. The answer
 *    carries the LOCAL workspace id.
 *
 * SESSIONS ONLY, twice: the path is deliberately UNLISTED in the fail-closed
 * machine scope allowlist (middleware/scopes.ts — never list it), and the
 * handler re-checks `via === 'session'` itself. /mcp carries no tool for it.
 *
 * A WORKSPACE NEVER LEARNS WHAT ITS MEMBERS DO ELSEWHERE: the route is
 * exempt from the generic audit middleware (which would attribute the event
 * to the workspace the person happened to be in) and writes its one genesis
 * row, `workspace.create`, into the NEW workspace's own trail — the setup
 * pattern. The idempotency claim is the only trace left in the caller's
 * current scope, and it is a sealed replay cache, never a readable surface.
 */

/**
 * Per-user creation lock, two-int advisory form `(classid, hashtext(userId))`.
 * 7432006 is free in this repository (7432001 migrations, 7432002/3 the
 * last-owner guards, 7432004 the grant refresh + pg-boss, 7432005 deck
 * uploads) and is, on purpose, the same number the hub uses for the same
 * job in ITS database.
 */
const WORKSPACE_CREATE_LOCK_NAMESPACE = 7432006;

/** Why this caller may not create a workspace right now — also the wire error code. */
export type WorkspaceCreationRefusal =
  | 'session_required'
  | 'workspace_creation_disabled'
  | 'guest_forbidden'
  | 'workspace_limit_reached'
  | 'hub_link_required';

export interface WorkspaceCreationPolicy {
  /** `MAX_WORKSPACES_PER_USER`. 0 closes creation for everyone, on both editions. */
  maxPerUser: number;
  /**
   * Cloud only: whether the user holds a LIVE hub link (a stored grant) —
   * the organization is created at the hub AS THEM, so without one there is
   * nothing to create it with. undefined on oss.
   */
  hasHubLink?: ((userId: string) => Promise<boolean>) | undefined;
}

/**
 * THE ONE eligibility rule, shared by the route (inside its locked
 * transaction) and by `/me.canCreateWorkspace` — so the flag can never
 * promise what the route refuses. Order = the order the refusals are
 * reported in.
 *
 *  - sessions only;
 *  - the operator's dial at 0 closes the door on both editions;
 *  - a GUEST-ONLY user (every active membership is `origin='guest'`) is an
 *    outsider invited to single decks (D2): refused like every other
 *    workspace-level act. One non-guest active membership anywhere lifts it
 *    — it is a fact about the PERSON, not about the workspace they are in;
 *  - oss: fewer ACTIVE OWNER memberships than the cap (setup's counts);
 *  - cloud: a live hub link. The count is the hub's own cap, asked there.
 */
export async function workspaceCreationRefusal(
  conn: DbConn,
  policy: WorkspaceCreationPolicy,
  caller: { userId: string; via: 'session' | 'api_key' | 'oauth' }
): Promise<WorkspaceCreationRefusal | null> {
  if (caller.via !== 'session') return 'session_required';
  if (policy.maxPerUser === 0) return 'workspace_creation_disabled';
  const rows = await conn
    .select({ origin: workspaceMembers.origin, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, caller.userId), eq(workspaceMembers.isActive, true)));
  if (rows.length > 0 && rows.every((r) => r.origin === 'guest')) return 'guest_forbidden';
  if (policy.hasHubLink) {
    return (await policy.hasHubLink(caller.userId)) ? null : 'hub_link_required';
  }
  const owned = rows.filter((r) => r.role === 'owner').length;
  return owned >= policy.maxPerUser ? 'workspace_limit_reached' : null;
}

const REFUSAL_MESSAGES: Record<WorkspaceCreationRefusal, string> = {
  session_required: 'Creating a workspace requires a browser session',
  workspace_creation_disabled: 'Workspace creation is closed on this instance',
  guest_forbidden: 'Guest access is limited to the decks you were invited to',
  workspace_limit_reached: 'This account already owns the maximum number of workspaces',
  hub_link_required: 'Sign in with Antasphere to create an organization'
};

/**
 * The creation rate wall. Two buckets, spent IN THE HANDLER once the caller
 * is identified — deliberately not a path-mounted middleware:
 *
 *  - a path mount counts every method (OPTIONS/HEAD/PUT on a path whose only
 *    handler is the POST) and every unauthenticated request, so anyone could
 *    spend an address's budget without a session and lock the people behind
 *    it out of a route they had never used;
 *  - here only an IDENTIFIED caller's POST costs anything. The person bucket
 *    is judged FIRST, and a person it refuses never reaches the address
 *    bucket — so one person can take at most their own share (a tenth) of
 *    the address's budget, and an office behind one NAT address is not
 *    locked out by one colleague. A single person still cannot hammer the
 *    hub: 60 attempts an hour, refused ones included, zero-membership cloud
 *    sessions included (they are identified by their session here, which a
 *    principal-keyed middleware could not do).
 *
 * An Idempotency-Key replay never reaches the handler and costs nothing.
 */
export interface WorkspaceCreateWall {
  /** Per person, key `u:<userId>`. */
  person: RateLimiterAbstract;
  /** Per address — larger than the person bucket, identified callers only. */
  address: RateLimiterAbstract;
}

const personKey = (userId: string) => `u:${userId}`;

async function bucketExhausted(limiter: RateLimiterAbstract, key: string): Promise<boolean> {
  // A backend read error fails open, like every other read of a limiter here.
  const state = await limiter.get(key).catch(() => null);
  return Boolean(state && state.remainingPoints <= 0 && state.msBeforeNext > 0);
}

/**
 * Read-only: would the wall refuse this person at this address right now?
 * `/me.canCreateWorkspace` asks it so the flag stays honest about the wall.
 */
export async function workspaceCreateWallClosed(
  wall: WorkspaceCreateWall,
  address: string,
  userId: string
): Promise<boolean> {
  return (
    (await bucketExhausted(wall.person, personKey(userId))) || (await bucketExhausted(wall.address, address))
  );
}

/** Spend one attempt. False = walled (429). */
async function spendCreationAttempt(
  wall: WorkspaceCreateWall,
  address: string,
  userId: string
): Promise<boolean> {
  // A walled ADDRESS refuses without charging the person for it.
  if (await bucketExhausted(wall.address, address)) return false;
  try {
    await wall.person.consume(personKey(userId));
  } catch {
    return false; // the person's own budget is spent: the address bucket is NOT touched
  }
  try {
    await wall.address.consume(address);
  } catch {
    return false;
  }
  return true;
}

/** Control-flow marker: a refusal decided inside the locked transaction. */
class CreationRefused extends Error {
  constructor(readonly refusal: WorkspaceCreationRefusal) {
    super(refusal);
  }
}

/** Cloud-only collaborators. Absent on oss: the route carries zero hub surface there. */
export interface WorkspaceCloudDeps {
  /** The ONE hub call, isolated (identity/hub-user-client.ts `createOrg`). */
  createOrg: HubOrgCreator;
  /** The login-grade, TTL-bypassing reconcile pass (identity/hub-reconcile.ts). */
  forceReconcile: (userId: string) => Promise<ReconcilePassOutcome>;
  hasHubLink: (userId: string) => Promise<boolean>;
  /** The hub console: where a hub-origin workspace is renamed (P7's pointer). */
  manageUrl: string;
}

export interface WorkspaceRouteDeps {
  db: Db;
  auth: Auth;
  audit: AuditService;
  registry: PlatformRegistry;
  logger: Logger;
  clientIp: ClientIpFn;
  wall: WorkspaceCreateWall;
  maxPerUser: number;
  cloud?: WorkspaceCloudDeps | undefined;
}

export function workspaceCreationPolicy(
  deps: Pick<WorkspaceRouteDeps, 'maxPerUser' | 'cloud'>
): WorkspaceCreationPolicy {
  return { maxPerUser: deps.maxPerUser, hasHubLink: deps.cloud?.hasHubLink };
}

export function registerWorkspaceRoutes(api: OpenAPIHono, deps: WorkspaceRouteDeps): void {
  const { db, auth, audit, registry, logger, cloud } = deps;
  const policy = workspaceCreationPolicy(deps);

  api.openapi(workspaceCreateRoute, async (c) => {
    const principal = c.get('principal');
    // Defense in depth: the scope allowlist already 403s every machine
    // principal (POST /workspaces is unlisted, fail-closed); this explicit
    // check stays so a future allowlist edit cannot silently hand workspace
    // creation to an API key or an OAuth bearer.
    if (principal && principal.via !== 'session') {
      return c.json(err('session_required', REFUSAL_MESSAGES.session_required), 403);
    }

    // The caller. A resolved principal is a session by now. WITHOUT one, the
    // cloud edition still serves the ZERO-MEMBERSHIP session (the /me zero
    // state: a hub user whose last organization was removed creates their
    // next one here) — resolved route-locally, the /me pattern, and ONLY
    // for the selector-less request. On oss no principal means no active
    // membership of this instance: not someone who may create here.
    let userId: string;
    if (principal) {
      userId = principal.userId;
    } else {
      // A request that NAMED a workspace and failed its membership check keeps
      // the fail-closed 401 (no oracle about that workspace) — /me's rule.
      if (c.req.header(ACTIVE_WORKSPACE_HEADER)?.trim()) {
        return c.json(err('unauthenticated', 'Authentication required'), 401);
      }
      const session = cloud ? await auth.api.getSession({ headers: c.req.raw.headers }) : null;
      if (!session?.user) return c.json(err('unauthenticated', 'Authentication required'), 401);
      userId = session.user.id;
    }
    const actor = { userId, via: 'session' as const };

    // The rate wall, now that the caller is a known person (see
    // WorkspaceCreateWall): nothing above this line spends a point.
    if (!(await spendCreationAttempt(deps.wall, deps.clientIp(c), userId))) {
      return c.json(err('rate_limited', 'Too many requests, slow down'), 429);
    }

    const body = c.req.valid('json');
    const name = body.name.trim();
    if (!name) return c.json(err('validation_error', 'The workspace needs a name'), 400);
    // The look the person picked in the dialog: written on the row the
    // moment it exists (oss) or once it is projected (cloud), so the
    // workspace opens with it on every member's screen, not just this browser's.
    const look: WorkspaceLook = {
      theme: body.look?.theme ?? null,
      pattern: body.look?.pattern ?? null,
      field: body.look?.field ?? null,
      grain: body.look?.grain ?? null
    };

    let workspaceId: string;
    let workspaceName = name;
    if (!cloud) {
      // ── oss: local creation under the per-user lock ─────────────────────
      try {
        workspaceId = await db.transaction(async (tx) => {
          // Serializes THIS user's creations: two concurrent requests can
          // never both count "one under the cap". Transaction-scoped — it
          // cannot leak.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${WORKSPACE_CREATE_LOCK_NAMESPACE}, hashtext(${userId}))`
          );
          const refusal = await workspaceCreationRefusal(tx, policy, actor);
          if (refusal) throw new CreationRefused(refusal);
          // The registry's WorkspaceService (ADR 014), joined to this
          // transaction exactly as setup does: workspace + ACTIVE OWNER
          // membership (origin defaults to 'local') or nothing.
          const created = await registry.workspaces.create(name, userId, tx);
          await tx
            .update(workspaces)
            .set({
              lookTheme: look.theme,
              lookPattern: look.pattern,
              lookField: look.field,
              lookGrain: look.grain
            })
            .where(eq(workspaces.id, created.workspaceId));
          return created.workspaceId;
        });
      } catch (cause) {
        if (cause instanceof CreationRefused) {
          return c.json(err(cause.refusal, REFUSAL_MESSAGES[cause.refusal]), 403);
        }
        throw cause;
      }
    } else {
      // ── cloud: create at the hub as the caller, then project ────────────
      const refusal = await workspaceCreationRefusal(db, policy, actor);
      if (refusal) return c.json(err(refusal, REFUSAL_MESSAGES[refusal]), 403);

      const created = await cloud.createOrg(userId, name);
      switch (created.kind) {
        case 'created':
          break;
        case 'limit_reached':
          return c.json(
            err('workspace_limit_reached', 'This account already owns the maximum number of organizations'),
            403
          );
        case 'invalid':
          return c.json(err('validation_error', 'Antasphere refused this organization name'), 400);
        case 'no_link':
          return c.json(err('hub_link_required', REFUSAL_MESSAGES.hub_link_required), 403);
        case 'grant_dead':
          // The existing live-gate verdict, verbatim: a browser SSO re-login heals it.
          return c.json(
            err(
              'hub_grant_expired',
              'Your Antasphere grant on this instance has expired — sign in with Antasphere again to renew it'
            ),
            401
          );
        case 'reauth_required':
          // The grant is alive but predates `orgs:create` (or a CLI connect
          // replaced it). Same status and same cure as hub_grant_expired — a
          // browser sign-in — under its own code, so it is never mistaken
          // for a refusal that signing in again would not lift.
          return c.json(err('hub_reauth_required', 'Sign in again to create a workspace, then retry'), 401);
        case 'refused':
          return c.json(
            err('hub_refused', 'Antasphere did not accept the creation of this organization'),
            403
          );
        case 'inconclusive':
          // The existing live-gate verdict's code. Never retried here: the
          // hub commits before it answers, so the organization may exist —
          // if it does, the caller's next reconcile pass projects it.
          return c.json(
            err('hub_unavailable', 'Antasphere could not be reached — the organization was not confirmed'),
            403
          );
      }

      // The reconcile IS the projection (the login path's rule): force the
      // caller's pass so the workspace row and the origin='hub' membership
      // are written by the same code every other hub org goes through.
      const pass = await cloud.forceReconcile(userId);
      const find = () =>
        db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .innerJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, workspaces.id),
              eq(workspaceMembers.userId, userId),
              eq(workspaceMembers.isActive, true)
            )
          )
          .where(eq(workspaces.centralAccountId, created.org.id))
          .limit(1);
      let [local] = await find();
      if (!local && created.org.role !== null) {
        // The pass right after the 201 was inconclusive (a hub blip). The
        // 201 itself is hub truth read AS THE USER about THIS org — the same
        // standing as one entry of their GET /orgs list — so project that
        // one entry through the same primitive rather than answer an error
        // for an organization that exists (a retry would create a second).
        // Never from a token, never for anyone but the caller.
        logger.warn(
          { userId, pass },
          'workspace create: forced reconcile did not project the new org — projecting from the hub 201'
        );
        await projectOrgMembership(db, {
          localUserId: userId,
          hubWorkspaceId: created.org.id,
          hubWorkspaceName: created.org.name,
          role: created.org.role
        });
        [local] = await find();
      }
      if (!local) {
        logger.error({ userId, pass }, 'workspace create: hub org created but no local projection');
        return c.json(
          err('hub_unavailable', 'The organization was created at Antasphere and will appear shortly'),
          403
        );
      }
      workspaceId = local.id;
      workspaceName = local.name;
      // The look is a LOCAL fact of the projection (the hub reconcile writes
      // the name and the status, never the look's columns).
      await db
        .update(workspaces)
        .set({
          lookTheme: look.theme,
          lookPattern: look.pattern,
          lookField: look.field,
          lookGrain: look.grain
        })
        .where(eq(workspaces.id, workspaceId));
    }

    // Genesis row in the NEW workspace's own trail — and nowhere else.
    await audit.write({
      workspaceId,
      principal: actor,
      action: 'workspace.create',
      resourceType: 'workspace',
      resourceId: workspaceId,
      requestId: c.get('requestId'),
      ip: deps.clientIp(c),
      metadata: { name: workspaceName }
    });
    registry.events.emit('workspace.created', { workspaceId, ownerUserId: userId });

    return c.json({ workspace: { id: workspaceId, name: workspaceName, look } }, 201);
  });

  // ── PATCH /workspace: the active workspace's own settings ───────────────
  // Owners and admins, from a browser session (unlisted in the machine scope
  // allowlist like the create; re-checked here). The route names no id: the
  // request's one workspace is the one edited (ADR 014). A guest never
  // holds admin, so requireRole covers D2 too.
  api.use('/workspace', requireRole('admin'));
  api.openapi(workspaceUpdateRoute, async (c) => {
    const principal = c.get('principal');
    if (!principal) return c.json(err('unauthenticated', 'Authentication required'), 401);
    if (principal.via !== 'session') {
      return c.json(err('session_required', 'Changing a workspace requires a browser session'), 403);
    }
    const body = c.req.valid('json');
    const patch: Partial<{
      name: string;
      lookTheme: string | null;
      lookPattern: string | null;
      lookField: number | null;
      lookGrain: number | null;
    }> = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return c.json(err('validation_error', 'The workspace needs a name'), 400);
      // P7: a hub-origin workspace's name is the hub's — renamed there, and
      // the next reconcile pass would overwrite a local rename anyway.
      if (principal.accountRef) {
        return c.json(
          {
            error: {
              code: 'hub_managed',
              message: 'This workspace is an Antasphere organization — rename it at Antasphere',
              details: { manageUrl: cloud?.manageUrl ?? null }
            }
          },
          403
        );
      }
      patch.name = name;
    }
    if (body.look?.theme !== undefined) patch.lookTheme = body.look.theme;
    if (body.look?.pattern !== undefined) patch.lookPattern = body.look.pattern;
    if (body.look?.field !== undefined) patch.lookField = body.look.field;
    if (body.look?.grain !== undefined) patch.lookGrain = body.look.grain;

    const [row] = await db
      .update(workspaces)
      .set(patch)
      .where(eq(workspaces.id, principal.workspaceId))
      .returning({
        id: workspaces.id,
        name: workspaces.name,
        lookTheme: workspaces.lookTheme,
        lookPattern: workspaces.lookPattern,
        lookField: workspaces.lookField,
        lookGrain: workspaces.lookGrain
      });
    // The principal's workspace exists by construction (a live join built
    // it); a missing row here is a race with a deletion, refused like a gate.
    if (!row) return c.json(err('forbidden', 'Workspace not found'), 403);
    return c.json(
      {
        workspace: {
          id: row.id,
          name: row.name,
          look: { theme: row.lookTheme, pattern: row.lookPattern, field: row.lookField, grain: row.lookGrain }
        }
      },
      200
    );
  });
}
