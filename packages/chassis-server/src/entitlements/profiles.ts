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
  limits: Record<string, number | null>;
  features: ReadonlySet<string>;
  /** Where the plan came from: the hub, the last known answer, or the default. */
  source: 'hub' | 'stale' | 'default';
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
  /** Hub request budget. */
  timeoutMs: number;
}

export const DEFAULT_PROFILE_DIALS: EntitlementProfileDials = {
  ttlMs: 30_000,
  staleMs: 15 * 60_000,
  timeoutMs: 5_000
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
  hubLimits: Record<string, number | null>;
  hubFeatures: string[] | null;
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
    await flight;
    return this.cache.get(accountRef) ?? null;
  }

  private async refresh(accountRef: string, previous: CacheEntry | null): Promise<void> {
    this.hubReads += 1;
    const answered = await this.read(accountRef);
    const now = this.now();
    if (answered) {
      this.cache.set(accountRef, {
        plan: answered.plan,
        hubLimits: answered.limits ?? {},
        hubFeatures: answered.features ?? null,
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
            answeredAtMs: 0,
            freshUntilMs: now + this.dials.ttlMs
          }
    );
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
    limits[key] = override !== undefined ? override : tiers[plan];
  }
  const features = new Set<string>();
  const hubFeatures = known && !stale ? entry.hubFeatures : null;
  for (const [key, tiers] of Object.entries(tool.features)) {
    if (hubFeatures ? hubFeatures.includes(key) : tiers[plan]) features.add(key);
  }
  return { plan, limits, features, source };
}

/** The profile of an account nobody asked the hub about: the tool's `free` tier. */
export function defaultProfile(tool: ToolEntitlements): ResolvedProfile {
  return resolve(tool, null, 0, 0);
}
