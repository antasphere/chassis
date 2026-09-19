import type { MiddlewareHandler } from 'hono';
import { apiError } from '../api/errors.js';

/**
 * P7 (internal/federation.md "Hub-managed membership"): on the cloud edition,
 * membership of a HUB-ORIGIN (projected) workspace is the hub's source of
 * truth — invites, roles, and removals happen at the hub and flow in via
 * SSO login + the P4 re-assertion. A local membership mutation on such a
 * workspace would create divergence the next login/re-assertion fights, so
 * every mutation on the local /members + /invitations surfaces answers this
 * refusal instead. READS stay open: the projected roster is real.
 *
 * Why 403 (not 410): the member rows demonstrably exist (GET /members
 * serves them), so "the resource is gone" would be false — what is denied
 * is the OPERATION's local authority, for every caller, regardless of role
 * or credential. That is RFC 9110 403's "forbidden for reasons unrelated to
 * the credentials", and it keeps the platform's refusal vocabulary in one
 * register (guest_forbidden, endpoint_not_allowed, workspace_mismatch are
 * all 403). The `hub_managed` code + `details.manageUrl` carry the pointer.
 *
 * Fail-closed by construction:
 *  - Hub-origin detection keys on `principal.accountRef`, which every
 *    credential resolver (session: platform/local-identity.ts; API key:
 *    apikeys/service.ts; OAuth bearer: identity/oauth-jwt.ts) populates from
 *    a LIVE join on `workspaces.central_account_id` for the request's ONE
 *    workspace (ADR 014) — the same signal the live hub gate keys on
 *    (identity/hub-live-gate.ts). There is no principal-construction path
 *    that skips the join.
 *  - The gate is method-keyed, not route-enumerated, and mounted ONCE per
 *    subtree wildcard (`/members/*`, `/invitations/*` — in Hono the
 *    wildcard also matches the collection root): any FUTURE mutation
 *    registered anywhere under those surfaces is refused by default, with
 *    no per-path registration to remember.
 *  - It is registered only on EDITION=cloud (the `hubConfig` presence
 *    switch, like every cloud seam) — oss carries zero behavior change, and
 *    on oss `centralAccountId` is never set anyway (double cover).
 *
 * Principal-less requests pass through untouched: the public invitation
 * accept/lookup segments are explicitly SKIPPED where this is mounted (their
 * target workspace is the invitation's, not the caller's — the accept
 * handler runs its own hub-origin check on the invitation's workspace), and
 * every other gated route 401s in its requireAuth/requireRole gate.
 */
export function hubManagedMembershipGate(manageUrl: string): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const principal = c.get('principal');
    if (principal?.accountRef) {
      return apiError(
        c,
        403,
        'hub_managed',
        'Membership of this workspace is managed at the Antasphere hub — invite, remove, and change roles there',
        { manageUrl }
      );
    }
    return next();
  };
}
