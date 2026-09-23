import {
  entitlementProfileSchema,
  type EntitlementProfile,
  type EntitlementTier,
  type ToolEntitlements
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import type { HubMachineToken } from './hub-machine-token.js';

/**
 * An account's entitlement profile, resolved: the plan, every declared limit
 * with the value that applies (the hub's override when it sent one, the
 * tool's declared value for the tier otherwise), and the features on.
 */
export interface ResolvedProfile {
  plan: EntitlementTier;
  /** null = unlimited (a tier's null, or a hub `true`); 0 = nothing allowed (a hub `false`). */
  limits: Record<string, number | null>;
  features: ReadonlySet<string>;
  /** Where the plan came from: the hub, the last known answer, or the default. */
  source: 'hub' | 'stale' | 'default';
  /**
   * The hub's upgrade page for the organization (`org`, `tool`, `plan` on it),
   * when the hub sent one with the plan served here; null when the plan is
   * the default (never answered, or past the stale window) or the hub is
   * older than phase 2. The gate appends `key` and `requiredPlan`.
   */
  upgradeUrl: string | null;
}

export interface EntitlementProfileDials {
  /** How long a hub answer is served without asking again (§7: 30 s per account). */
  ttlMs: number;
  /**
   * How long the LAST KNOWN plan is kept when the hub stops answering, before
   * falling to `free` (the federation gate's own posture on hub_unavailable:
   * 15 minutes). A pro account is not refused above the free cap on every
   * hub blip.
   */
  staleMs: number;
  /** Hub request budget (the read runs off the request path; this bounds the background fetch). */
  timeoutMs: number;
  /**
   * How long a request waits for the FIRST read of an account nobody asked
   * the hub about yet (PRDCT-2633). A warm cache never waits: a fresh entry
   * is served, a stale one is served while a refresh runs behind it. A cold
   * account waits at most this long, then gets the default (`free`) while the
   * read finishes in the background — so a pro account is judged right on
   * its first request whenever the hub answers in time. Every request for a
   * cold account that arrives while that first read is in flight waits up
   * to this budget too (each against the one flight), bounded overall by
   * `timeoutMs`, after which the miss is cached and served at once.
   */
  coldWaitMs: number;
}

export const DEFAULT_PROFILE_DIALS: EntitlementProfileDials = {
  ttlMs: 30_000,
  staleMs: 15 * 60_000,
  timeoutMs: 5_000,
  coldWaitMs: 1_500
};

export interface EntitlementProfilesOptions {
  issuerUrl: string;
  token: HubMachineToken;
  logger: Logger;
  dials?: Partial<EntitlementProfileDials> | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

interface CacheEntry {
  plan: EntitlementTier;
  /** The hub's overrides as sent: a number, or a boolean switch (`true` unlimited, `false` nothing). */
  hubLimits: Record<string, number | boolean>;
  hubFeatures: string[] | null;
  /** The hub's upgrade page for the organization, when it sent one. */
  hubUpgradeUrl: string | null;
  /** When the hub last answered. */
  answeredAtMs: number;
  /** Until when this entry is served without a hub call. */
  freshUntilMs: number;
}

/**
 * The per-account plan on the cloud edition, read from the hub's
 * `GET /usage/entitlements?accountRef=` with the machine token and cached
 * 30 s per account. Resolution against the tool's declared tier values
 * (`resolve`): the hub's rows win over the defaults whenever it sent them.
 *
 * The read is OFF the request path (PRDCT-2633, stale-while-revalidate):
 * a fresh entry is served as it is; an entry past its TTL is served at once
 * and refreshed behind the request, single-flight per account; only an
 * account the cache has never seen waits, and at most `coldWaitMs`. A hub
 * that is slow but alive therefore costs a metered request nothing once the
 * account is known.
 *
 * Failure posture: a hub that does not answer (a 404 from an older hub, a
 * 5xx, a timeout) keeps the last known plan for `staleMs`, then `free`; an
 * account the hub never answered for is `free` from the start. Every failure
 * is cached for `ttlMs` too, so a request storm never becomes a hub storm.
 */
export class EntitlementProfiles {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly dials: EntitlementProfileDials;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** How many reads reached the hub — a test seam. */
  hubReads = 0;

  constructor(private readonly opts: EntitlementProfilesOptions) {
    this.url = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/usage/entitlements';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.dials = { ...DEFAULT_PROFILE_DIALS, ...opts.dials };
  }

  /** The account's profile, resolved against what the tool declares. */
  async get(accountRef: string, tool: ToolEntitlements): Promise<ResolvedProfile> {
    const entry = await this.entry(accountRef);
    return resolve(tool, entry, this.now(), this.dials.staleMs);
  }

  /** Forget every cached answer (a test seam). */
  clear(): void {
    this.cache.clear();
  }

  /** Wait for every background refresh in flight (a test seam). */
  async settle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private async entry(accountRef: string): Promise<CacheEntry | null> {
    const cached = this.cache.get(accountRef);
    if (cached && cached.freshUntilMs > this.now()) return cached;
    let flight = this.inflight.get(accountRef);
    if (!flight) {
      flight = this.refresh(accountRef, cached ?? null).finally(() => {
        this.inflight.delete(accountRef);
      });
      this.inflight.set(accountRef, flight);
    }
    // Stale: served now, the refresh runs behind the request.
    if (cached) return cached;
    // Cold: wait for the first read, but never longer than the cold budget.
    await withinBudget(flight, this.dials.coldWaitMs);
    return this.cache.get(accountRef) ?? null;
  }

  private async refresh(accountRef: string, previous: CacheEntry | null): Promise<void> {
    this.hubReads += 1;
    this.sweep();
    const answered = await this.read(accountRef);
    const now = this.now();
    if (answered) {
      // Which features list is the truth. A hub that answers at least one
      // limit key serves its real rows for this tool (phase 2, PRDCT-2663):
      // its `features` is then authoritative AS IT IS, an empty list
      // included, so a per-account override that switches a feature off is
      // felt. A hub that answers no limit at all is a phase-1 hub (or a tool
      // it has not seeded yet), whose empty lists mean "the tool applies its
      // own tier defaults for the plan named here": there a non-empty list
      // still overrides and an empty one leaves the declared tier values.
      const authoritative = Object.keys(answered.limits).length > 0;
      this.cache.set(accountRef, {
        plan: answered.plan,
        hubLimits: answered.limits,
        hubFeatures: authoritative || answered.features.length > 0 ? answered.features : null,
        hubUpgradeUrl: answered.upgradeUrl ?? null,
        answeredAtMs: now,
        freshUntilMs: now + this.dials.ttlMs
      });
      return;
    }
    // Keep the last answer (its `answeredAtMs` decides staleness), or record
    // a miss so the next request within the TTL does not ask again.
    this.cache.set(
      accountRef,
      previous
        ? { ...previous, freshUntilMs: now + this.dials.ttlMs }
        : {
            plan: 'free',
            hubLimits: {},
            hubFeatures: null,
            hubUpgradeUrl: null,
            answeredAtMs: 0,
            freshUntilMs: now + this.dials.ttlMs
          }
    );
  }

  /**
   * Keep the cache bounded on a long-lived replica: once it holds more than
   * `SWEEP_ABOVE` accounts, drop every entry that is neither fresh nor
   * inside its stale window (nothing would be served from it any more).
   */
  private sweep(): void {
    if (this.cache.size <= SWEEP_ABOVE) return;
    const now = this.now();
    for (const [key, entry] of this.cache) {
      const servable =
        entry.freshUntilMs > now || (entry.answeredAtMs > 0 && entry.answeredAtMs + this.dials.staleMs > now);
      if (!servable) this.cache.delete(key);
    }
  }

  /** One hub read; null on any failure (logged, never thrown). */
  private async read(accountRef: string): Promise<EntitlementProfile | null> {
    let token: string;
    try {
      token = await this.opts.token.get();
    } catch (err) {
      this.opts.logger.warn({ err }, 'entitlements: no machine token — the last known plan applies');
      return null;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}?accountRef=${encodeURIComponent(accountRef)}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.dials.timeoutMs)
      });
    } catch (err) {
      this.opts.logger.warn({ err }, 'entitlements: hub unreachable — the last known plan applies');
      return null;
    }
    if (res.status === 401) this.opts.token.invalidate();
    if (!res.ok) {
      this.opts.logger.warn(
        { status: res.status },
        'entitlements: hub answered non-2xx — the last known plan applies'
      );
      return null;
    }
    const parsed = entitlementProfileSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      this.opts.logger.warn('entitlements: hub answered a malformed profile — the last known plan applies');
      return null;
    }
    return parsed.data;
  }
}

/** The plan a fresh instance assumes, and the resolution every edition path shares. */
export function resolve(
  tool: ToolEntitlements,
  entry: CacheEntry | null,
  nowMs: number,
  staleMs: number
): ResolvedProfile {
  const known = entry && entry.answeredAtMs > 0;
  const stale = known && entry.answeredAtMs + staleMs <= nowMs;
  const plan: EntitlementTier = known && !stale ? entry.plan : 'free';
  const source: ResolvedProfile['source'] =
    !known || stale ? 'default' : entry.freshUntilMs > nowMs ? 'hub' : 'stale';
  const limits: Record<string, number | null> = {};
  for (const [key, tiers] of Object.entries(tool.limits)) {
    const override = known && !stale ? entry.hubLimits[key] : undefined;
    limits[key] = override !== undefined ? limitValue(override) : tiers[plan];
  }
  const features = new Set<string>();
  const hubFeatures = known && !stale ? entry.hubFeatures : null;
  for (const [key, tiers] of Object.entries(tool.features)) {
    if (hubFeatures ? hubFeatures.includes(key) : tiers[plan]) features.add(key);
  }
  const upgradeUrl = known && !stale ? entry.hubUpgradeUrl : null;
  return { plan, limits, features, source, upgradeUrl };
}

/**
 * A hub limit value as the gate compares it (PRDCT-2636): the hub's contract
 * allows a boolean beside a number — `true` switches the limit off
 * (unlimited, null), `false` allows nothing (0).
 */
function limitValue(value: number | boolean): number | null {
  if (value === true) return null;
  if (value === false) return 0;
  return value;
}

/** How many accounts the cache may hold before a refresh sweeps the unservable entries. */
const SWEEP_ABOVE = 5_000;

/** Resolve when `flight` settles or `ms` elapse, whichever first; the timer never outlives the wait. */
function withinBudget(flight: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // a pending wait must never keep the process alive
    void flight.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The profile of an account nobody asked the hub about: the tool's `free` tier. */
export function defaultProfile(tool: ToolEntitlements): ResolvedProfile {
  return resolve(tool, null, 0, 0);
}
