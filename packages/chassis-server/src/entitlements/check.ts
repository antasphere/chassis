import { Counter, Gauge } from 'prom-client';
import { usageCheckSchema, type UsageCheck } from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import type { HubMachineToken } from './hub-machine-token.js';

/**
 * The cloud edition's credit check (the billing rail spec, §7 steps 3 and 4;
 * PRDCT-2664): before a metered action runs, the hub's `POST
 * /api/v1/usage/check` prices THIS quantity against the organization's
 * balance, with the machine token. The answer is advisory at the hub (no
 * side effect): the debit happens at ingest, from the usage event the gate
 * emits after a 2xx.
 *
 * The cache, per account per action. The price is non-decreasing in the
 * quantity, which is what makes an answer reusable for a DIFFERENT quantity:
 * a fresh allowed answer serves any request asking for no more than it was
 * asked for (kept `allowTtlMs`), a fresh denial refuses any request asking
 * for at least as much (kept `denyTtlMs`, shorter: a top-up must be felt
 * soon); every other case asks the hub. The cache is consulted BEFORE the
 * hub always, so a fresh answer serves through an outage too.
 *
 * What the hub's answer means:
 *  - 200 that parses: the verdict (a success clears the failure clock);
 *  - 401: the token is dead, invalidated and minted again ONCE, then an outage;
 *  - 404 `unknown_account`: no organization holds this id at the hub, so
 *    nothing can be charged: allowed, logged at warn, not an outage;
 *  - 400: our request is malformed, a bug no waiting heals: allowed, logged
 *    at ERROR, not an outage;
 *  - 403: the client lacks the scope, an outage logged at error (the
 *    operator must see it);
 *  - anything else (another 404, 408, 429, 5xx, a network error, a timeout,
 *    a 200 that is not the hub's answer, no machine token): an OUTAGE.
 *
 * An outage fails OPEN for `failOpenMs` from its first failure (the
 * federation gate's own posture: fifteen minutes), then CLOSED
 * (`hub_unavailable`) until the hub answers again. Every verdict is counted
 * on /metrics and sets the posture gauge.
 */

export interface CreditCheckDials {
  /** How long an allowed answer is reused (for a quantity ≤ the one asked). */
  allowTtlMs: number;
  /** How long a denial is reused (for a quantity ≥ the one asked). */
  denyTtlMs: number;
  /** How long an outage fails open, from its first failure, before it closes. */
  failOpenMs: number;
  /** Hub request budget per call. */
  timeoutMs: number;
  /**
   * How long the hub is left alone after a failed call: every request in
   * that window takes the outage's verdict at once (open, then closed)
   * instead of paying the hub budget again. Without it, a hub that times out
   * would cost every metered request five seconds for fifteen minutes; with
   * it, one probe per window for the whole instance, the machine token's
   * own posture.
   */
  outageHoldMs: number;
}

export const DEFAULT_CREDIT_CHECK_DIALS: CreditCheckDials = {
  allowTtlMs: 30_000,
  denyTtlMs: 5_000,
  failOpenMs: 15 * 60_000,
  timeoutMs: 5_000,
  outageHoldMs: 5_000
};

export interface CreditCheckRequest {
  /** The paying account: the hub organization id. */
  accountRef: string;
  actionKey: string;
  /** The quantity of THIS request, in the meter's unit. */
  quantity: number;
  /** The meter's unit, compared against the price row's (a mismatch is logged once per action). */
  unit: string;
}

export type CreditVerdict =
  | {
      allowed: true;
      source: 'hub' | 'cache' | 'fail_open' | 'unknown_account' | 'malformed';
      check: UsageCheck | null;
    }
  | {
      allowed: false;
      reason: 'insufficient_credits' | 'account_suspended' | 'hub_unavailable';
      source: 'hub' | 'cache' | 'closed';
      check: UsageCheck | null;
    };

/** What the entitlement gate depends on: a unit test stubs it. */
export interface CreditCheck {
  check(req: CreditCheckRequest): Promise<CreditVerdict>;
}

export interface HubCreditCheckOptions {
  issuerUrl: string;
  token: HubMachineToken;
  logger: Logger;
  dials?: Partial<CreditCheckDials> | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

interface CacheEntry {
  answer: UsageCheck;
  /** The quantity the hub was asked for (the larger one, when an allowed answer replaced another). */
  quantity: number;
  until: number;
}

type HubOutcome =
  | { kind: 'answer'; answer: UsageCheck }
  | { kind: 'unknown_account' }
  | { kind: 'malformed' }
  | { kind: 'outage' };

type Outcome =
  | 'allowed'
  | 'denied'
  | 'suspended'
  | 'cached_allowed'
  | 'cached_denied'
  | 'fail_open'
  | 'closed'
  | 'unknown_account'
  | 'malformed';

/** How many entries the cache may hold before an insert sweeps the expired ones. */
const SWEEP_ABOVE = 5_000;

export class HubCreditCheck implements CreditCheck {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly dials: CreditCheckDials;
  private readonly cache = new Map<string, CacheEntry>();
  /** The first failure of the current outage, or null when the hub answers. */
  private failingSinceMs: number | null = null;
  /** When the hub last failed to answer: the hold window starts here. */
  private lastFailureMs = 0;
  /** Whether the flip to closed was logged for the current outage. */
  private closedLogged = false;
  /** The action keys whose unit mismatch was already logged. */
  private readonly unitWarned = new Set<string>();
  /** How many calls reached the hub — a test seam. */
  hubCalls = 0;

  readonly verdicts: Counter<'outcome'>;
  readonly posture: Gauge;
  readonly failingSince: Gauge;
  readonly cacheEntries: Gauge;
  /** The metrics boot registers on the app's /metrics registry (cloud only). */
  readonly promMetrics: Array<Counter<string> | Gauge<string>>;

  constructor(private readonly opts: HubCreditCheckOptions) {
    this.url = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/usage/check';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.dials = { ...DEFAULT_CREDIT_CHECK_DIALS, ...opts.dials };
    // registers: [] — boot attaches these to the app registry; a test builds
    // a check without one.
    this.verdicts = new Counter({
      name: 'usage_check_total',
      help: 'Credit check verdicts by outcome: allowed, denied, suspended, cached_allowed, cached_denied, fail_open, closed, unknown_account, malformed',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.posture = new Gauge({
      name: 'usage_check_posture',
      help: 'The credit check posture: 0 healthy, 1 failing open (the hub is unreachable), 2 closed (hub_unavailable)',
      registers: []
    });
    this.failingSince = new Gauge({
      name: 'usage_check_failing_since_seconds',
      help: 'Unix seconds of the first failure of the current hub outage, 0 when healthy',
      registers: []
    });
    this.cacheEntries = new Gauge({
      name: 'usage_check_cache_entries',
      help: 'Credit check answers held in the per-account per-action cache',
      registers: []
    });
    this.promMetrics = [this.verdicts, this.posture, this.failingSince, this.cacheEntries];
  }

  /** How many answers the cache holds (the gauge's value). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Forget every cached answer (a test seam). */
  clear(): void {
    this.cache.clear();
    this.cacheEntries.set(0);
  }

  async check(req: CreditCheckRequest): Promise<CreditVerdict> {
    const key = `${req.accountRef}\u0000${req.actionKey}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) {
      if (cached.answer.allowed && req.quantity <= cached.quantity) {
        return this.verdict('cached_allowed', { allowed: true, source: 'cache', check: cached.answer });
      }
      if (!cached.answer.allowed && req.quantity >= cached.quantity) {
        return this.verdict('cached_denied', {
          allowed: false,
          reason: cached.answer.reason ?? 'insufficient_credits',
          source: 'cache',
          check: cached.answer
        });
      }
    }

    // Inside the hold after a failed call, the hub is left alone: the
    // outage's verdict at once, no second budget paid per request.
    if (this.failingSinceMs !== null && this.now() - this.lastFailureMs < this.dials.outageHoldMs) {
      return this.outage();
    }
    const outcome = await this.ask(req, true);
    switch (outcome.kind) {
      case 'answer': {
        this.failingSinceMs = null;
        this.closedLogged = false;
        const { answer } = outcome;
        if (
          typeof answer.unit === 'string' &&
          answer.unit !== req.unit &&
          !this.unitWarned.has(req.actionKey)
        ) {
          this.unitWarned.add(req.actionKey);
          this.opts.logger.warn(
            { actionKey: req.actionKey, meterUnit: req.unit, priceUnit: answer.unit },
            'usage check: the hub prices this action in another unit than the route meters it — check the price book'
          );
        }
        this.store(key, req.quantity, answer);
        if (answer.allowed) return this.verdict('allowed', { allowed: true, source: 'hub', check: answer });
        const reason = answer.reason ?? 'insufficient_credits';
        return this.verdict(reason === 'account_suspended' ? 'suspended' : 'denied', {
          allowed: false,
          reason,
          source: 'hub',
          check: answer
        });
      }
      case 'unknown_account':
        return this.verdict('unknown_account', { allowed: true, source: 'unknown_account', check: null });
      case 'malformed':
        return this.verdict('malformed', { allowed: true, source: 'malformed', check: null });
      case 'outage':
        this.lastFailureMs = this.now();
        return this.outage();
    }
  }

  /** Keep an answer; an allowed answer over a fresh allowed entry keeps the larger quantity. */
  private store(key: string, quantity: number, answer: UsageCheck): void {
    const now = this.now();
    const previous = this.cache.get(key);
    const kept =
      answer.allowed && previous && previous.answer.allowed && previous.until > now
        ? Math.max(previous.quantity, quantity)
        : quantity;
    this.cache.set(key, {
      answer,
      quantity: kept,
      until: now + (answer.allowed ? this.dials.allowTtlMs : this.dials.denyTtlMs)
    });
    if (this.cache.size > SWEEP_ABOVE) this.sweep(now);
  }

  /** Keep the cache bounded on a long-lived replica: drop every entry past its `until`. */
  private sweep(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.until <= now) this.cache.delete(key);
    }
  }

  private outage(): CreditVerdict {
    const now = this.now();
    const first = this.failingSinceMs === null;
    if (first) this.failingSinceMs = now;
    if (now - this.failingSinceMs! <= this.dials.failOpenMs) {
      if (first) {
        this.opts.logger.warn(
          'usage check: the hub does not answer — metered actions are allowed (failing open) for fifteen minutes'
        );
      } else {
        this.opts.logger.debug('usage check: the hub still does not answer — failing open');
      }
      return this.verdict('fail_open', { allowed: true, source: 'fail_open', check: null });
    }
    if (!this.closedLogged) {
      this.closedLogged = true;
      this.opts.logger.error(
        { failingSince: new Date(this.failingSinceMs!).toISOString() },
        'usage check: the hub has not answered past the fail-open window — metered actions are refused (hub_unavailable) until it recovers'
      );
    }
    return this.verdict('closed', {
      allowed: false,
      reason: 'hub_unavailable',
      source: 'closed',
      check: null
    });
  }

  /** Count the verdict, set the gauges, return it. */
  private verdict(outcome: Outcome, verdict: CreditVerdict): CreditVerdict {
    this.verdicts.inc({ outcome });
    const since = this.failingSinceMs;
    this.posture.set(since === null ? 0 : this.now() - since <= this.dials.failOpenMs ? 1 : 2);
    this.failingSince.set(since === null ? 0 : Math.floor(since / 1000));
    this.cacheEntries.set(this.cache.size);
    return verdict;
  }

  /** One hub call (and one retry on a dead token); never throws. */
  private async ask(req: CreditCheckRequest, retryOn401: boolean): Promise<HubOutcome> {
    let token: string;
    try {
      token = await this.opts.token.get();
    } catch (err) {
      this.opts.logger.debug({ err }, 'usage check: no machine token');
      return { kind: 'outage' };
    }
    this.hubCalls += 1;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          accountRef: req.accountRef,
          actionKey: req.actionKey,
          quantity: req.quantity,
          unit: req.unit
        }),
        signal: AbortSignal.timeout(this.dials.timeoutMs)
      });
    } catch (err) {
      this.opts.logger.debug({ err }, 'usage check: hub unreachable');
      return { kind: 'outage' };
    }
    if (res.status === 401) {
      if (!retryOn401) return { kind: 'outage' };
      this.opts.token.invalidate();
      return this.ask(req, false);
    }
    if (res.ok) {
      const parsed = usageCheckSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        this.opts.logger.warn(
          { status: res.status },
          'usage check: the hub answered 2xx without a readable check — treated as an outage'
        );
        return { kind: 'outage' };
      }
      return { kind: 'answer', answer: parsed.data };
    }
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      if (body?.error?.code === 'unknown_account') {
        this.opts.logger.warn(
          { accountRef: req.accountRef, actionKey: req.actionKey },
          'usage check: no organization holds this account at the hub — nothing can be charged, the action is allowed'
        );
        return { kind: 'unknown_account' };
      }
      return { kind: 'outage' };
    }
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      this.opts.logger.error(
        { accountRef: req.accountRef, actionKey: req.actionKey, body: body.slice(0, 500) },
        'usage check: the hub refused the check as malformed — a bug, the action is allowed (counted on usage_check_total{outcome="malformed"})'
      );
      return { kind: 'malformed' };
    }
    if (res.status === 403) {
      this.opts.logger.error(
        { status: res.status },
        'usage check: the hub refuses this client (403) — check the client’s usage:write scope; treated as an outage'
      );
      return { kind: 'outage' };
    }
    this.opts.logger.debug({ status: res.status }, 'usage check: the hub answered non-2xx');
    return { kind: 'outage' };
  }
}
