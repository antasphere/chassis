import { Counter } from 'prom-client';
import { and, eq, inArray, isNotNull, ne, notInArray } from 'drizzle-orm';
import { projectMembers, workspaceMembers, workspaces, type Db } from '@antasphere/chassis-db';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import { projectOrgMembership } from './hub-projection.js';
import type { HubUserClient, LoginAccessToken } from './hub-user-client.js';

/**
 * Live org reconciliation (internal/federation.md, user-scoped federation): org
 * and membership truth live ONLY at the hub, and the tool reflects it by
 * reading the hub's caller-scoped `GET /orgs` AS THE USER (hub-user-client)
 * — every SSO login runs the TTL-bypassing `forceReconcile()` (fail-CLOSED:
 * a login whose pass fails is revoked — reconcile IS the projection), and
 * the live gate (hub-live-gate.ts) runs the cached `reconcile()` on every
 * request into a projected workspace. One pass fetches the user's full hub
 * org list and makes the local projections match: project missing orgs,
 * sync names/roles, sync `workspaces.hub_status` and the user's
 * `workspace_members.is_default`, deactivate `origin='hub'` memberships the
 * hub no longer asserts.
 *
 * Failure posture: a pass mutates state ONLY on a definitive 200 list.
 * Transient hub errors keep local state serving (nothing deactivated) —
 * the ENFORCEMENT of prolonged staleness is the gate's, via the windowed
 * `reconcile()` verdict (fresh ≤ staleMaxMs → serve; beyond it, failing →
 * `hub_unavailable`). A definitive `grant_dead` is its own verdict — the
 * gate answers 401 `hub_grant_expired` immediately, no stale window.
 *
 * Cost discipline: per-user TTL cache (~10 s) + single-flight, so N
 * concurrent requests cost one hub fetch; a pass on an expired cache IS
 * awaited (freshness at request time is the whole point) but is bounded by
 * the client's tight fetch timeout; failures re-probe at most once per
 * `retryMs`. An oss boot never constructs this class.
 */

/** Every dial of the live federation loop — one override surface for tests. */
export interface HubFederationDials {
  /** Per-user reconcile TTL (the identity-path freshness bound). */
  reconcileTtlMs: number;
  /** Definitive-pass staleness bound; beyond it a failing hub gates fail-closed. */
  reconcileStaleMaxMs: number;
  /** Failed-pass re-probe throttle: at most one hub attempt per user per interval. */
  retryMs: number;
  /** GET /orgs fetch timeout (awaited in the identity path — keep tight). */
  orgsTimeoutMs: number;
  /** Token-endpoint fetch timeout (hub-grant.ts). */
  tokenTimeoutMs: number;
  /** Serve cached access tokens only to exp − this (hub-grant.ts). */
  accessSkewMs: number;
  /** Watchdog cutting a wedged refresh's dedicated lock connection (hub-grant.ts). */
  lockWatchdogMs: number;
}

export const DEFAULT_FEDERATION_DIALS: HubFederationDials = {
  reconcileTtlMs: 10_000,
  reconcileStaleMaxMs: 15 * 60_000,
  retryMs: 15_000,
  orgsTimeoutMs: 1_500,
  tokenTimeoutMs: 5_000,
  accessSkewMs: 60_000,
  // Must cover probe + presentation under the refresh lock (hub-grant.ts
  // clamps it up if not): 5 s + 5 s + 2 s headroom.
  lockWatchdogMs: 12_000
};

/**
 * One pass's own outcome (what the metric labels count):
 *  - 'ok': definitive list applied;
 *  - 'no_link': the user holds no hub identity — nothing to reconcile,
 *    cached like a success;
 *  - 'grant_dead': the user's hub grant is definitively dead (cached like a
 *    success — the answer is real; a browser login heals it);
 *  - 'inconclusive': transient hub error, fail open;
 *  - 'error': unexpected local failure, fail open.
 */
export type ReconcilePassOutcome = 'ok' | 'no_link' | 'grant_dead' | 'inconclusive' | 'error';

/**
 * The gate's windowed verdict:
 *  - 'ok': definitive data within the stale window — serve on local rows;
 *  - 'grant_dead': the grant is dead — the gate refuses immediately;
 *  - 'unavailable': no definitive pass within the window and the hub keeps
 *    failing — the gate fails closed.
 */
export type ReconcileVerdict = { kind: 'ok' } | { kind: 'grant_dead' } | { kind: 'unavailable' };

interface CacheEntry {
  /** Timestamp of the last DEFINITIVE pass (the TTL + stale window anchor here). */
  fetchedAt: number;
  /** Timestamp of the last attempt, success or failure (outage throttle). */
  lastAttemptAt: number;
  /** The last DEFINITIVE outcome ('ok' | 'no_link' | 'grant_dead'). */
  lastDefinitive: Extract<ReconcilePassOutcome, 'ok' | 'no_link' | 'grant_dead'> | null;
}

/** Bound the cache — a user-id flood must never balloon memory. */
const MAX_CACHE_ENTRIES = 10_000;

export interface HubOrgReconcilerDeps {
  db: Db;
  client: HubUserClient;
  audit: AuditService;
  logger: Logger;
  dials: HubFederationDials;
  /** Test seam. */
  now?: () => number;
}

export class HubOrgReconciler {
  /** local userId → pass freshness. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ReconcilePassOutcome>>();
  private readonly now: () => number;
  readonly dials: HubFederationDials;

  /** Registered into the Prometheus registry by boot (cloud only). */
  readonly promMetrics: Counter[];
  private readonly passes: Counter;

  constructor(private readonly deps: HubOrgReconcilerDeps) {
    this.now = deps.now ?? Date.now;
    this.dials = deps.dials;
    // registers: [] — boot attaches this to the app registry on cloud; an
    // oss boot never constructs this class, so the metric never exists there.
    this.passes = new Counter({
      name: 'hub_reconcile_passes_total',
      help: 'Hub org-list reconciliation passes by outcome',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.promMetrics = [this.passes];
  }

  /**
   * The identity-path read-through: cached per user (~10 s), single-flight,
   * retry-throttled after failures. Awaits one pass on expiry — the request
   * that triggered it observes the reconciled state — and NEVER throws.
   * Returns the windowed verdict the live gate enforces.
   */
  async reconcile(localUserId: string): Promise<ReconcileVerdict> {
    const now = this.now();
    const entry = this.cache.get(localUserId);
    if (!entry || now - entry.fetchedAt >= this.dials.reconcileTtlMs) {
      let flight = this.inFlight.get(localUserId);
      if (!flight) {
        // Outage throttle: after a FAILED pass (lastAttemptAt advanced past
        // the last success), at most one re-probe per retryMs — a down hub
        // costs each user one bounded timeout per window. A successful pass
        // is never throttled beyond its own TTL.
        const throttled =
          entry !== undefined &&
          entry.lastAttemptAt > entry.fetchedAt &&
          now - entry.lastAttemptAt < this.dials.retryMs;
        if (!throttled) {
          flight = this.startPass(localUserId);
        }
      }
      if (flight) await flight;
    }
    return this.verdict(localUserId);
  }

  /**
   * The login-time pass (assertLogin step 3): TTL and throttle deliberately
   * bypassed — a login is the freshest signal there is, and `login` carries
   * the callback access token so no refresh is needed. Returns the PASS'S
   * OWN outcome (not the windowed verdict): the fail-CLOSED login requires
   * this very pass to have succeeded, never a recent cached one.
   */
  async forceReconcile(localUserId: string, login?: LoginAccessToken): Promise<ReconcilePassOutcome> {
    const flight = this.runPass(localUserId, login).finally(() => {
      if (this.inFlight.get(localUserId) === flight) this.inFlight.delete(localUserId);
    });
    // Concurrent cached reconciles join this pass instead of doubling it.
    this.inFlight.set(localUserId, flight);
    return flight;
  }

  private startPass(localUserId: string): Promise<ReconcilePassOutcome> {
    const flight = this.runPass(localUserId, undefined).finally(() => {
      if (this.inFlight.get(localUserId) === flight) this.inFlight.delete(localUserId);
    });
    this.inFlight.set(localUserId, flight);
    return flight;
  }

  private verdict(localUserId: string): ReconcileVerdict {
    const entry = this.cache.get(localUserId);
    const now = this.now();
    if (entry && entry.lastDefinitive && now - entry.fetchedAt < this.dials.reconcileStaleMaxMs) {
      // Definitive data within the window. A definitive DEAD grant refuses
      // immediately (no stale grace — Romain's decision 3); 'ok'/'no_link'
      // serve on local rows.
      return entry.lastDefinitive === 'grant_dead' ? { kind: 'grant_dead' } : { kind: 'ok' };
    }
    // No definitive pass within the window (or ever, e.g. a replica that
    // restarted mid-outage) and the hub keeps failing: fail closed.
    return { kind: 'unavailable' };
  }

  private async runPass(localUserId: string, login?: LoginAccessToken): Promise<ReconcilePassOutcome> {
    try {
      const result = await this.deps.client.orgs(localUserId, login);
      if (result.kind === 'no_link') {
        // A purely local user: the hub asserts nothing about them, and that
        // IS the definitive answer. Nothing is swept.
        //
        // EXCEPT (CLOUD-1, PRDCT-1356) when the user HOLDS origin='hub'
        // membership rows: those rows exist only because a hub link once
        // projected them, so "no link" means the link was SEVERED (an
        // unlinked account row, a partial cleanup) — and treating that as
        // the fail-open definitive answer, cached like a success, was the
        // one way to switch cloud enforcement off permanently. It fails
        // CLOSED instead, as a dead grant: the gate answers 401
        // hub_grant_expired, and a browser SSO re-login (which re-links)
        // heals it. Local/guest rows are untouched — they never reconcile.
        const [hubRow] = await this.deps.db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.userId, localUserId), eq(workspaceMembers.origin, 'hub')))
          .limit(1);
        if (hubRow) {
          this.deps.logger.warn(
            { userId: localUserId },
            'hub org reconcile: no hub link but hub-origin memberships exist — link severed; failing CLOSED'
          );
          this.remember(localUserId, 'grant_dead');
          this.passes.inc({ outcome: 'link_severed' });
          return 'grant_dead';
        }
        this.remember(localUserId, 'no_link');
        this.passes.inc({ outcome: 'no_link' });
        return 'no_link';
      }
      if (result.kind === 'grant_dead') {
        // Definitive: the grant family is gone. Freshness-wise a real
        // answer (cached); enforcement is the gate's 401 hub_grant_expired.
        // Nothing is swept — org truth was not read, only the grant state.
        this.remember(localUserId, 'grant_dead');
        this.passes.inc({ outcome: 'grant_dead' });
        return 'grant_dead';
      }
      if (result.kind === 'inconclusive') {
        // Loudly logged by the client already; retry at the next window.
        this.remember(localUserId, null);
        this.passes.inc({ outcome: 'inconclusive' });
        return 'inconclusive';
      }

      // Definitive 200 list — the ONLY thing that may ever mutate state.
      // Every listed org is kept, suspended ones included (visible but
      // blocked: the synced hub_status is what refuses their requests);
      // role-null entries are kept but not projected/synced.
      const keep = new Set(result.orgs.map((o) => o.id));

      // Deactivation sweep FIRST (removal must win over projection within
      // one pass): ONE conditional UPDATE covering exactly the rows the hub
      // no longer asserts — origin='hub' AND active AND the workspace IS a
      // projection whose hub org is off the keep-set. local/guest rows and
      // rows in non-projected workspaces are structurally out of scope.
      // `is_active = true` in the WHERE makes the flip observable: only the
      // pass that actually flipped a row audits it — one logical removal
      // writes ONE member.deactivate row.
      const keepIds = [...keep];
      const sweptWorkspaces = this.deps.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          keepIds.length > 0
            ? and(isNotNull(workspaces.centralAccountId), notInArray(workspaces.centralAccountId, keepIds))
            : isNotNull(workspaces.centralAccountId)
        );
      // The project grants that rode on a swept membership go WITH it, in the
      // same transaction. The sweep deactivates the row and never deletes it
      // (a re-add at the hub reactivates the very same row), so the foreign
      // key's cascade never fires here: without this delete, a person removed
      // at the hub and added back later would find every old project grant
      // waiting. A removal is a removal: a re-add starts with none. (A LOCAL
      // deactivation by an admin is a pause, not a removal, and keeps them.)
      const deactivated = await this.deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(workspaceMembers)
          .set({ isActive: false })
          .where(
            and(
              eq(workspaceMembers.userId, localUserId),
              eq(workspaceMembers.origin, 'hub'),
              eq(workspaceMembers.isActive, true),
              inArray(workspaceMembers.workspaceId, sweptWorkspaces)
            )
          )
          .returning({ id: workspaceMembers.id, workspaceId: workspaceMembers.workspaceId });
        if (rows.length > 0) {
          await tx.delete(projectMembers).where(
            inArray(
              projectMembers.memberId,
              rows.map((row) => row.id)
            )
          );
        }
        return rows;
      });
      for (const row of deactivated) {
        await this.deps.audit.write({
          workspaceId: row.workspaceId,
          principal: null,
          action: 'member.deactivate',
          resourceType: 'member',
          resourceId: localUserId,
          metadata: { reason: 'hub_reconcile' }
        });
        this.deps.logger.info(
          { userId: localUserId, workspaceId: row.workspaceId },
          'hub reconcile: membership no longer asserted by the hub — local membership deactivated'
        );
      }

      // Then project/upsert every well-formed entry (role upserts are
      // deliberately NOT audited — the login-projection precedent), and
      // sync the org-level hub_status. One failing entry logs and moves on:
      // a single bad org must never starve the others.
      for (const org of result.orgs) {
        try {
          if (org.role !== null) {
            await projectOrgMembership(this.deps.db, {
              localUserId,
              hubWorkspaceId: org.id,
              hubWorkspaceName: org.name,
              role: org.role
            });
          }
          // Org-level suspension is LOCALLY MATERIALIZED truth: the gate
          // (and guests' requests — the accepted staleness bound) read this
          // column, never a hub round-trip of their own. A role-null entry
          // still syncs it when the projection already exists.
          await this.deps.db
            .update(workspaces)
            .set({ hubStatus: org.status })
            .where(and(eq(workspaces.centralAccountId, org.id), ne(workspaces.hubStatus, org.status)));
        } catch (err) {
          this.deps.logger.error(
            { err, userId: localUserId, hubOrgId: org.id },
            'hub reconcile: projecting one org failed — continuing with the rest'
          );
        }
      }

      // Materialize the hub-level default org on the user's membership rows
      // (selection happens inside the resolvers, before any gate — the flag
      // must live locally). Clear-then-set in ONE transaction: the partial
      // unique index (user_id WHERE is_default) forbids two trues even
      // transiently, so a single both-ways UPDATE could trip it on row
      // order. A cross-replica race still can — the violation aborts only
      // this step and self-heals next pass.
      try {
        const defaultOrgId = result.orgs.find((o) => o.isDefault)?.id ?? null;
        let defaultWorkspaceId: string | null = null;
        if (defaultOrgId) {
          const [ws] = await this.deps.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.centralAccountId, defaultOrgId))
            .limit(1);
          defaultWorkspaceId = ws?.id ?? null;
        }
        await this.deps.db.transaction(async (tx) => {
          await tx
            .update(workspaceMembers)
            .set({ isDefault: false })
            .where(
              and(
                eq(workspaceMembers.userId, localUserId),
                eq(workspaceMembers.isDefault, true),
                ...(defaultWorkspaceId ? [ne(workspaceMembers.workspaceId, defaultWorkspaceId)] : [])
              )
            );
          if (defaultWorkspaceId) {
            await tx
              .update(workspaceMembers)
              .set({ isDefault: true })
              .where(
                and(
                  eq(workspaceMembers.userId, localUserId),
                  eq(workspaceMembers.workspaceId, defaultWorkspaceId),
                  eq(workspaceMembers.isDefault, false)
                )
              );
          }
        });
      } catch (err) {
        this.deps.logger.warn(
          { err, userId: localUserId },
          'hub reconcile: default-org sync failed — selection falls back to oldest-active until the next pass'
        );
      }

      this.remember(localUserId, 'ok');
      this.passes.inc({ outcome: 'ok' });
      return 'ok';
    } catch (err) {
      // Fail open, always: reconciliation is freshness; enforcement lives
      // in the gate's windowed verdict.
      this.remember(localUserId, null);
      this.passes.inc({ outcome: 'error' });
      this.deps.logger.error(
        { err, userId: localUserId },
        'hub org reconcile pass failed — serving local state'
      );
      return 'error';
    }
  }

  private remember(
    localUserId: string,
    definitive: Extract<ReconcilePassOutcome, 'ok' | 'no_link' | 'grant_dead'> | null
  ): void {
    const now = this.now();
    pruneOversized(this.cache, (entry) => now - entry.fetchedAt >= this.dials.reconcileTtlMs);
    const prev = this.cache.get(localUserId);
    this.cache.set(localUserId, {
      fetchedAt: definitive ? now : (prev?.fetchedAt ?? 0),
      lastAttemptAt: now,
      lastDefinitive: definitive ?? prev?.lastDefinitive ?? null
    });
  }
}

/** Keep a cache under MAX_CACHE_ENTRIES: drop expired entries first, then oldest-inserted. */
export function pruneOversized<V>(cache: Map<string, V>, expired: (value: V) => boolean): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, value] of cache) {
    if (expired(value)) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
