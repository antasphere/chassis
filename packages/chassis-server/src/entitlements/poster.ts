import { Counter } from 'prom-client';
import {
  usageEventOccurrenceIssue,
  usageIngestResultSchema,
  type UsageBatchOutcome,
  type UsageDownstream,
  type UsageEvent
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import { HubMachineTokenError, type HubMachineToken } from './hub-machine-token.js';

/**
 * The cloud edition's usage downstream (the billing rail spec, §6): the
 * batches the durable queue drains are posted to the hub's
 * `POST /api/v1/usage/events` with the machine token. At-least-once stays
 * the posture — the hub dedupes by ULID and answers per event
 * (`accepted | duplicate | rejected`); anything that is not an answer is a
 * throw, which fails the batch back to the queue for its retry.
 *
 * What is retried and what is not:
 *  - unreachable, timeout, 404 (an older hub that has no ingest yet), 408,
 *    429, 5xx: an OUTAGE — thrown, retried by the queue, never data loss;
 *  - 401: the token is dead — invalidated and minted again ONCE, then an
 *    outage;
 *  - 400/422: the batch is malformed — a bug, never healed by a retry:
 *    logged at error level and dropped, per the events' ids;
 *  - 403 (a client without the scope): logged at error level and treated as
 *    an outage, so the events wait for the operator rather than vanish;
 *  - a 2xx whose body is not the hub's answer: an OUTAGE too (PRDCT-2629) —
 *    a proxy page or a hub regression must never read as delivery;
 *  - a `rejected` event in a 2xx answer: logged with the hub's reason and
 *    dropped (the hub judged it).
 *
 * The queue's retry budget never ends in a loss: a batch it gives up on is
 * held and re-driven hourly (jobs/pgboss.ts, PRDCT-2635). What the poster
 * saw is counted on /metrics (`usage_poster_events_total` per event
 * outcome, `usage_poster_batches_total` per batch outcome), so a rail that
 * rejects everything is one scrape away, not one log line nobody reads.
 *
 * The date window (PRDCT-2644): the hub refuses an event whose `occurredAt`
 * is more than seven days before, or more than five minutes after, the
 * moment it receives it (`usageEventOccurrenceIssue`, the hub's rule
 * mirrored in the contract), as `rejected(invalid_event)` and never clamped.
 * So the poster runs the same comparison against its own clock BEFORE
 * posting: an event outside the window is never posted, it is HELD, named in
 * the batch outcome (`{ held: [{ id, reason: 'occurred_at_window' }] }`),
 * logged at warn and counted (`outcome="held"`). The usage worker re-sends
 * each held event to the held queue (jobs/pgboss.ts), which re-drives it
 * after the hold, forever: a future-dated event is posted once its time has
 * come, a stale one stays held until an operator acts. An event the hub
 * would refuse on its date is handled where it was made, never counted as a
 * rejection at the hub.
 */
export interface HubUsagePosterOptions {
  issuerUrl: string;
  token: HubMachineToken;
  logger: Logger;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** The clock the date window is judged against (a test seam; `Date.now` by default). */
  now?: (() => number) | undefined;
}

/** The reason a held event carries when its `occurredAt` falls outside the hub's window. */
export const OCCURRED_AT_WINDOW = 'occurred_at_window';

export class HubUsagePostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUsagePostError';
  }
}

interface EventResult {
  /** null when the element did not parse at all (`invalid_event`). */
  id: string | null;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string | undefined;
  details?: unknown;
}

/** The sentinel `results()` answers for a batch the hub refused as malformed: dropped whole, never retried. */
const DROPPED: EventResult[] = [];

export class HubUsagePoster implements UsageDownstream {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** How many POSTs reached the hub — a test seam. */
  posts = 0;
  /** Per-event outcomes as the hub answered them (or as the poster dropped or held them). */
  readonly events: Counter<'outcome'>;
  /** Per-batch outcomes: delivered (a hub answer read), retried (an outage), dropped (malformed). */
  readonly batches: Counter<'outcome'>;
  /** The counters boot registers on the app's /metrics registry (cloud only: oss never builds a poster). */
  readonly promMetrics: Counter<string>[];

  constructor(private readonly opts: HubUsagePosterOptions) {
    this.url = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/usage/events';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    // registers: [] — boot attaches these to the app registry; a test builds
    // a poster without one.
    this.events = new Counter({
      name: 'usage_poster_events_total',
      help: 'Usage events by outcome: accepted, duplicate, rejected (the hub judged it), dropped (malformed batch), held (outside the hub’s occurredAt window, never posted)',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.batches = new Counter({
      name: 'usage_poster_batches_total',
      help: 'Usage batches by outcome: delivered, retried (an outage, the queue retries), dropped (malformed)',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.promMetrics = [this.events, this.batches];
  }

  async emit(event: UsageEvent): Promise<void> {
    await this.emitBatch([event]);
  }

  async emitBatch(all: readonly UsageEvent[]): Promise<UsageBatchOutcome> {
    const held: Array<{ id: string; reason: string }> = [];
    const events: UsageEvent[] = [];
    const receivedAt = new Date(this.now());
    for (const e of all) {
      const issue = usageEventOccurrenceIssue(new Date(e.occurredAt), receivedAt);
      if (issue === null) {
        events.push(e);
        continue;
      }
      held.push({ id: e.id, reason: OCCURRED_AT_WINDOW });
      this.opts.logger.warn(
        { id: e.id, occurredAt: e.occurredAt, issue: issue.message },
        'usage poster: the event’s occurredAt is outside the hub’s window — held, never posted (counted on usage_poster_events_total{outcome="held"})'
      );
    }
    // Counted once the batch is settled: a post that throws fails the whole
    // batch (the held events' jobs included) back to the queue, whose retry
    // judges them again, and would count them twice if the count came first.
    const outcome = (): UsageBatchOutcome => {
      if (held.length > 0) this.events.inc({ outcome: 'held' }, held.length);
      return { held };
    };
    if (events.length === 0) return outcome();
    let results: EventResult[];
    try {
      const res = await this.post(events, true);
      results = await this.results(res, events);
    } catch (err) {
      this.batches.inc({ outcome: 'retried' });
      throw err;
    }
    if (results === DROPPED) {
      this.batches.inc({ outcome: 'dropped' });
      this.events.inc({ outcome: 'dropped' }, events.length);
      return outcome();
    }
    this.batches.inc({ outcome: 'delivered' });
    for (const r of results) {
      this.events.inc({ outcome: r.status });
      if (r.status === 'rejected') {
        this.opts.logger.error(
          { id: r.id, reason: r.reason, details: r.details },
          'usage poster: the hub rejected an event — dropped (the hub judged it; counted on usage_poster_events_total{outcome="rejected"})'
        );
      }
    }
    return outcome();
  }

  private async post(events: readonly UsageEvent[], retryOn401: boolean): Promise<Response> {
    let token: string;
    try {
      token = await this.opts.token.get();
    } catch (err) {
      if (err instanceof HubMachineTokenError && err.kind === 'invalid_client') {
        this.opts.logger.error(
          'usage poster: the hub refuses this instance’s client — events wait in the queue'
        );
      }
      throw new HubUsagePostError('no machine token');
    }
    this.posts += 1;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      this.opts.logger.warn(
        { err, count: events.length },
        'usage poster: hub unreachable — the batch is retried'
      );
      throw new HubUsagePostError('hub unreachable');
    }
    if (res.status === 401 && retryOn401) {
      this.opts.token.invalidate();
      return this.post(events, false);
    }
    return res;
  }

  private async results(res: Response, events: readonly UsageEvent[]): Promise<EventResult[]> {
    if (res.ok) {
      const parsed = usageIngestResultSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        // Not the hub's answer (a proxy page, a hub regression): an outage,
        // never a delivery — the batch is retried (PRDCT-2629).
        this.opts.logger.warn(
          { status: res.status },
          'usage poster: the hub answered 2xx without readable results — the batch is retried'
        );
        throw new HubUsagePostError('hub answered 2xx without readable results');
      }
      // One answer per posted element, in the batch's order (the hub's
      // contract): a shorter or longer answer is not the hub's, and a tail
      // it does not name would otherwise be neither counted nor retried.
      if (parsed.data.results.length !== events.length) {
        this.opts.logger.warn(
          { answered: parsed.data.results.length, posted: events.length },
          'usage poster: the hub answered for a different number of events than posted — the batch is retried'
        );
        throw new HubUsagePostError('hub answered a different number of events than posted');
      }
      return parsed.data.results;
    }
    if (res.status === 400 || res.status === 422) {
      const body = await res.text().catch(() => '');
      this.opts.logger.error(
        { status: res.status, ids: events.map((e) => e.id), body: body.slice(0, 500) },
        'usage poster: the hub refused the batch as malformed — dropped (a bug, never healed by a retry; counted on usage_poster_events_total{outcome="dropped"})'
      );
      return DROPPED;
    }
    if (res.status === 403) {
      this.opts.logger.error(
        { status: res.status },
        'usage poster: the hub refuses this client (403) — check the client’s usage:write scope; the batch is retried'
      );
      throw new HubUsagePostError('hub answered 403');
    }
    if (res.status === 404) {
      this.opts.logger.warn(
        'usage poster: the hub has no usage ingest yet (404) — the batch is retried; the hub deploys first'
      );
      throw new HubUsagePostError('hub answered 404');
    }
    this.opts.logger.warn(
      { status: res.status },
      'usage poster: the hub answered non-2xx — the batch is retried'
    );
    throw new HubUsagePostError(`hub answered ${res.status}`);
  }
}
