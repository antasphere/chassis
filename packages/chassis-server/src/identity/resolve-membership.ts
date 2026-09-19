import { and, asc, desc, eq } from 'drizzle-orm';
import { user as userTable, workspaceMembers, workspaces, type Db } from '@antasphere/chassis-db';

/**
 * The ONE membership-selection rule of the user-scoped credential model
 * (ADR 014 as amended): every credential — session, API key, OAuth bearer —
 * identifies a USER, and each request resolves exactly ONE target workspace
 * for that user:
 *
 *  - `requested` non-null (the X-Workspace-Id header, or an API key's pin):
 *    an ACTIVE membership of that workspace is required, else null — fail
 *    closed, so an unknown workspace and a workspace the user does not
 *    belong to are indistinguishable (no oracle).
 *  - `requested` null: the user's DEFAULT membership (`is_default`, at most
 *    one per user), else the deterministic fallback — the OLDEST active
 *    membership (created_at, then id). While no row carries `is_default`
 *    (nothing sets it on oss; the cloud reconcile materializes the hub-level
 *    default), the ordering is inert and selection is byte-identical to the
 *    pre-default behavior.
 *
 * All three resolvers share THIS query so the selection rule can never fork
 * per credential path.
 */

/** Strict UUID shape — a malformed selector must never reach Postgres' uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Well-formed-selector check, shared with the cloud miss-retry hook: only a
 * plausibly-real workspace id ever triggers a hub reconcile — a garbage
 * header can never buy a hub round-trip (the reconciler's TTL/throttle
 * bounds even well-formed ones).
 */
export function isWorkspaceSelector(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The cloud edition's unknown-workspace retry hook (internal/federation.md):
 * a verified credential naming a workspace the local join cannot see MAY be
 * a hub org granted since the last reconcile pass — "invited at the hub,
 * clicks a deep link". Boot wires ONE cached reconcile; the resolver then
 * re-runs the SAME lookup once, no recursion. undefined on oss.
 */
export type OnWorkspaceMiss = (userId: string, requested: string) => Promise<void>;

export interface ResolvedMembership {
  workspaceId: string;
  role: 'owner' | 'admin' | 'member';
  origin: 'local' | 'hub' | 'guest';
  /** The workspace's centralAccountId — null outside hub projections. */
  accountRef: string | null;
  /** Live user row fields, for the machine paths that carry no session. */
  email: string;
  name: string;
}

export async function resolveMembership(
  db: Db,
  userId: string,
  requested: string | null
): Promise<ResolvedMembership | null> {
  if (requested !== null && !UUID_RE.test(requested)) return null; // fail closed, no uuid-cast 500

  const [row] = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      origin: workspaceMembers.origin,
      accountRef: workspaces.centralAccountId,
      email: userTable.email,
      name: userTable.name
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.isActive, true),
        ...(requested ? [eq(workspaceMembers.workspaceId, requested)] : [])
      )
    )
    // Selector-less default: the default membership first, then the
    // deterministic oldest. With a selector the filter pins a single row and
    // the order is inert.
    .orderBy(desc(workspaceMembers.isDefault), asc(workspaceMembers.createdAt), asc(workspaceMembers.id))
    .limit(1);
  return row ?? null;
}
