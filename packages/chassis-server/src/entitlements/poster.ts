import { usageIngestResultSchema, type UsageDownstream, type UsageEvent } from '@antasphere/chassis-contract';
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
 *  - a `rejected` event in a 2xx answer: logged with the hub's reason and
 *    dropped (the hub judged it).
 */
export interface HubUsagePosterOptions {
  issuerUrl: string;
  token: HubMachineToken;
  logger: Logger;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

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

export class HubUsagePoster implements UsageDownstream {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** How many POSTs reached the hub — a test seam. */
  posts = 0;

  constructor(private readonly opts: HubUsagePosterOptions) {
    this.url = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/usage/events';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async emit(event: UsageEvent): Promise<void> {
    await this.emitBatch([event]);
  }

  async emitBatch(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    const res = await this.post(events, true);
    const results = await this.results(res, events);
    for (const r of results) {
      if (r.status === 'rejected') {
        this.opts.logger.error(
          { id: r.id, reason: r.reason, details: r.details },
          'usage poster: the hub rejected an event — dropped'
        );
      }
    }
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
        this.opts.logger.warn(
          'usage poster: the hub answered 2xx without readable results — treated as accepted'
        );
        return events.map((e) => ({ id: e.id, status: 'accepted' as const }));
      }
      return parsed.data.results;
    }
    if (res.status === 400 || res.status === 422) {
      const body = await res.text().catch(() => '');
      this.opts.logger.error(
        { status: res.status, ids: events.map((e) => e.id), body: body.slice(0, 500) },
        'usage poster: the hub refused the batch as malformed — dropped (a bug, never healed by a retry)'
      );
      return [];
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
