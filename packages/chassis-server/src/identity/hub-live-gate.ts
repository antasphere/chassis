import { and, eq } from 'drizzle-orm';
import { workspaceMembers, workspaces, type Db } from '@antasphere/chassis-db';
import type { Logger } from '../logger.js';
import type { PrincipalGate, PrincipalGateResult } from '../middleware/auth-context.js';
import type { HubOrgReconciler } from './hub-reconcile.js';

/**
 * The cloud edition's post-resolution principal gate (user-scoped
 * federation — the replacement for the retired master-key P4 gates): on
 * EVERY authenticated request into a PROJECTED workspace
 * (`principal.accountRef` set), hub truth is re-read AS THE USER via the
 * TTL'd reconciler, and the request is judged on the freshly reconciled
 * LOCAL rows. No service key, no cross-tenant surface — a user's requests
 * can only ever be gated by their OWN grant's view of the hub.
 *
 * Verdicts, in order:
 *  - grant dead → 401 `hub_grant_expired` (immediate, no stale window —
 *    Romain's decision 3; a browser SSO re-login heals the grant);
 *  - reconcile stale beyond the window AND the hub failing → 403
 *    `hub_unavailable` (fail closed after ~15 min of outage);
 *  - hub-origin membership row now inactive (this very pass may have swept
 *    it) → 401 `membership_revoked`;
 *  - workspace `hub_status='suspended'` → 403 `account_suspended`, EXCEPT
 *    `GET /api/v1/me` — suspended is VISIBLE-BUT-BLOCKED, and /me is how
 *    the dashboard shows the suspended badge instead of stranding the user
 *    (the reason the PrincipalGate seam carries the request);
 *  - a role delta from the reconciled row applies to THIS request (D11).
 *
 * Guest and local-origin rows in a projected workspace skip hub enforcement
 * entirely EXCEPT the org-level suspension read — and that reads the
 * LOCALLY MATERIALIZED `workspaces.hub_status` column only, never a hub
 * round-trip on a borrowed grant. ACCEPTED BOUND (documented): a guest's
 * own `/orgs` never includes the deck's org, so that column refreshes only
 * when a MEMBER's reconcile runs — a guest may keep deck access in a
 * hub-suspended org until a member next touches the tool. Every cheap fix
 * leaks (a public status probe = suspension oracle) or borrows credentials
 * (acting on a grant its holder didn't present). Same accepted-bound class
 * as ungated share-link viewing; suspension still cuts all MEMBERS within
 * seconds.
 */

const SUSPENDED_MESSAGE = 'This organization is suspended on Antasphere';
const UNAVAILABLE_MESSAGE =
  'The Antasphere hub has been unreachable for too long; requests are refused until it recovers';
const GRANT_EXPIRED_MESSAGE =
  'Your Antasphere grant on this instance has expired — sign in with Antasphere again to renew it';

/** The one suspension exemption: the dashboard's whoami read. */
function isMeRead(request: { path: string; method: string }): boolean {
  return request.method === 'GET' && request.path === '/api/v1/me';
}

export interface HubLiveGateDeps {
  db: Db;
  reconciler: HubOrgReconciler;
  logger: Logger;
}

export class HubLiveGate {
  constructor(private readonly deps: HubLiveGateDeps) {}

  readonly assert: PrincipalGate = async (principal, request) => {
    // Unprojected workspace: zero hub surface on this request.
    if (!principal.accountRef) return { ok: true };

    // Guest/local rows are the tool's own business (never hub truth): no
    // reconcile, no membership re-assertion, no grant requirement. Org-level
    // suspension still applies, read from the local column.
    if (principal.origin !== 'hub') {
      return this.assertOrgActive(principal.workspaceId, request);
    }

    const verdict = await this.deps.reconciler.reconcile(principal.userId);
    if (verdict.kind === 'grant_dead') {
      return { ok: false, status: 401, code: 'hub_grant_expired', message: GRANT_EXPIRED_MESSAGE };
    }
    if (verdict.kind === 'unavailable') {
      return { ok: false, status: 403, code: 'hub_unavailable', message: UNAVAILABLE_MESSAGE };
    }

    // Judge the FRESHLY RECONCILED local rows (the pass above may have
    // swept the membership, synced the role, or flipped hub_status).
    const [row] = await this.deps.db
      .select({
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        hubStatus: workspaces.hubStatus
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceMembers.userId, principal.userId),
          eq(workspaceMembers.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (!row || !row.isActive) {
      // Resolution saw an active row moments ago; the reconcile swept it —
      // the hub no longer asserts this membership. Every later request dies
      // at resolution itself (plain 401); THIS one carries the reason.
      return {
        ok: false,
        status: 401,
        code: 'membership_revoked',
        message: 'Your membership of this organization was removed on Antasphere'
      };
    }
    if (row.hubStatus === 'suspended' && !isMeRead(request)) {
      return { ok: false, status: 403, code: 'account_suspended', message: SUSPENDED_MESSAGE };
    }
    // A role delta from the reconciled row applies to THIS request (D11):
    // a demoted admin loses admin surfaces now, a promotion lands now.
    if (row.role !== principal.role) {
      return { ok: true, role: row.role };
    }
    return { ok: true };
  };

  private async assertOrgActive(
    workspaceId: string,
    request: { path: string; method: string }
  ): Promise<PrincipalGateResult> {
    const [ws] = await this.deps.db
      .select({ hubStatus: workspaces.hubStatus })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (ws?.hubStatus === 'suspended' && !isMeRead(request)) {
      return { ok: false, status: 403, code: 'account_suspended', message: SUSPENDED_MESSAGE };
    }
    return { ok: true };
  }
}
