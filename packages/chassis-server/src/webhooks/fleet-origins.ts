import { toolOriginsSchema } from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';

/**
 * The fleet (PRDCT-3772): the origins of the hub's registry tools, read from
 * the hub's public `GET /api/v1/tool-origins` (the hub's contract,
 * `toolOriginsSchema`), kept in memory, refreshed on a timer. The webhook
 * delivery policy reads it LIVE (`SafeFetchPolicy.fleetOrigins`): a webhook
 * whose URL's origin is one of these names a sibling of the same hub and
 * passes the scheme, port and address rules the public-only rule would
 * refuse inside a shared network (the team stack's Caddy aliases resolve a
 * sibling's public name to a private address).
 *
 * The rules of the list:
 *  - read once at boot (bounded by `timeoutMs`, never fatal: a hub that does
 *    not answer leaves the list EMPTY, and nothing is opened), then every
 *    `refreshMs` after a success and every `retryMs` after a failure;
 *  - a failed read keeps the LAST list: a hub outage never closes a sibling
 *    the guard already knew, and never opens anything new;
 *  - an answer off the hub's contract is a failed read (the list stays);
 *  - no credential: the route is public, and the worker has no user;
 *  - the timer never holds the process open and skips while draining.
 *  An oss boot constructs none of this.
 */
export interface FleetOriginsDials {
  /** After a successful read, the next read waits this long. */
  refreshMs: number;
  /** After a failed read, the next read waits this long. */
  retryMs: number;
  /** One read's budget: the connection, the answer, the body. */
  timeoutMs: number;
}

export const DEFAULT_FLEET_ORIGINS_DIALS: FleetOriginsDials = {
  refreshMs: 60 * 60_000,
  retryMs: 60_000,
  timeoutMs: 5_000
};

export interface FleetOriginsOptions {
  /** The hub's issuer URL (`HUB_ISSUER_URL`); the route is `<issuer>/api/v1/tool-origins`. */
  issuerUrl: string;
  logger: Logger;
  dials?: Partial<FleetOriginsDials> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface FleetOriginsRead {
  ok: boolean;
  /** How many origins the list holds AFTER the read (the last list on a failure). */
  count: number;
  /** Why the read failed, when it did. */
  error?: string;
}

export class FleetOrigins {
  private origins: ReadonlySet<string> = new Set();
  private readonly url: string;
  private readonly dials: FleetOriginsDials;
  private readonly fetchImpl: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  /** Set by `stop()`: a read in flight never re-arms the timer afterwards (verifier round 1, F1). */
  private stopped = false;
  private inFlight: Promise<FleetOriginsRead> | null = null;
  private isDraining: () => boolean = () => false;
  /** When the list was last read successfully; null until the first success. */
  fetchedAt: Date | null = null;
  /** The last failed read's reason; cleared by the next success. */
  lastError: string | null = null;

  constructor(private readonly opts: FleetOriginsOptions) {
    this.url = `${opts.issuerUrl.replace(/\/+$/, '')}/api/v1/tool-origins`;
    this.dials = { ...DEFAULT_FLEET_ORIGINS_DIALS, ...opts.dials };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The current list: what the policy reads at every check. */
  get(): ReadonlySet<string> {
    return this.origins;
  }

  /**
   * One read, single-flight: a concurrent caller shares the one in flight.
   * On success the list is replaced whole (an origin the hub dropped is
   * dropped here); on any failure the last list stays.
   */
  refresh(): Promise<FleetOriginsRead> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(): Promise<FleetOriginsRead> {
    try {
      // No redirect followed, like the delivery itself: a 3xx is a failed read, the list stays.
      const res = await this.fetchImpl(this.url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.dials.timeoutMs)
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const parsed = toolOriginsSchema.safeParse(await res.json());
      if (!parsed.success)
        throw new Error(`off the hub contract: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      const next = new Set<string>();
      for (const tool of parsed.data.tools) next.add(new URL(tool.origin).origin);
      this.origins = next;
      this.fetchedAt = new Date();
      this.lastError = null;
      this.opts.logger.info({ origins: next.size }, 'webhooks: the fleet origins were read from the hub');
      return { ok: true, count: next.size };
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.lastError = error;
      this.opts.logger.warn(
        { error, kept: this.origins.size },
        'webhooks: the fleet origins could not be read from the hub, the last list is kept'
      );
      return { ok: false, count: this.origins.size, error };
    }
  }

  /** The timer: `refreshMs` after a success, `retryMs` after a failure; never holding the process open. */
  start(opts: { isDraining?: () => boolean } = {}): void {
    if (opts.isDraining) this.isDraining = opts.isDraining;
    this.stopped = false;
    this.schedule(this.fetchedAt ? this.dials.refreshMs : this.dials.retryMs);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isDraining()) return;
      void this.refresh().then((read) => this.schedule(read.ok ? this.dials.refreshMs : this.dials.retryMs));
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
