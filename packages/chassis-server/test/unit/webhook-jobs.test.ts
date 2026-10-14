import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/logger.js';
import { webhookJobs } from '../../src/webhooks/jobs.js';
import {
  MAX_IN_FLIGHT_PER_ENDPOINT,
  WEBHOOK_DELIVERIES_HELD_QUEUE,
  WEBHOOK_DELIVERIES_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_PURGE_QUEUE,
  WebhookDeliveryDeferred,
  WebhookDeliveryFailed,
  type WebhookService
} from '../../src/webhooks/service.js';

/**
 * The webhooks' queue declarations (verifier round 2, MJ-R2-1): the two
 * queues that must drain a burst poll every half second, the delivery queue
 * runs eight pollers, and an attempt the per-endpoint bound defers goes back
 * in the queue with its retry budget untouched (the job completes), while a
 * failed attempt still throws so pg-boss retries it.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function fakeService(attempt: (id: string) => Promise<unknown>) {
  const requeue = vi.fn(async (_id: string, _inSeconds: number) => undefined);
  const service = {
    dials: { retryLimit: 2, retryDelaySeconds: 1 },
    attempt: vi.fn(async (id: string) => attempt(id)),
    requeue,
    fanOut: vi.fn(async () => 0),
    hold: vi.fn(async () => undefined),
    purge: vi.fn(async () => 0)
  } as unknown as WebhookService;
  return { service, requeue };
}

const jobOf = (service: WebhookService, queue: string) => {
  const job = webhookJobs(service, logger, 30).find((j) => j.queue === queue);
  expect(job, `no declaration for ${queue}`).toBeDefined();
  return job!;
};

const META = { id: 'job-1', queue: WEBHOOK_DELIVERIES_QUEUE, key: null };

describe('webhookJobs', () => {
  it('the fan-out and the delivery queues poll every half second; the held queue and the purge keep the default', () => {
    const { service } = fakeService(async () => null);
    const byQueue = new Map(webhookJobs(service, logger, 30).map((j) => [j.queue, j]));
    expect(byQueue.get(WEBHOOK_EVENTS_QUEUE)).toMatchObject({ concurrency: 2, pollingIntervalSeconds: 0.5 });
    expect(byQueue.get(WEBHOOK_DELIVERIES_QUEUE)).toMatchObject({
      concurrency: 8,
      pollingIntervalSeconds: 0.5
    });
    expect(byQueue.get(WEBHOOK_DELIVERIES_HELD_QUEUE)?.pollingIntervalSeconds).toBeUndefined();
    expect(byQueue.get(WEBHOOK_PURGE_QUEUE)?.pollingIntervalSeconds).toBeUndefined();
  });

  it('the bound leaves room for other endpoints: two per endpoint of the eight pollers', () => {
    expect(MAX_IN_FLIGHT_PER_ENDPOINT).toBe(2);
    const { service } = fakeService(async () => null);
    expect(jobOf(service, WEBHOOK_DELIVERIES_QUEUE).concurrency).toBeGreaterThan(MAX_IN_FLIGHT_PER_ENDPOINT);
  });

  it('a deferred attempt is put back in the queue two seconds later and the job completes', async () => {
    const { service, requeue } = fakeService(async (id) => {
      throw new WebhookDeliveryDeferred(id);
    });
    const job = jobOf(service, WEBHOOK_DELIVERIES_QUEUE);
    vi.mocked(logger.warn).mockClear();
    await expect(job.handler({ deliveryId: 'd-1' }, META)).resolves.toBeUndefined();
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith('d-1', 2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a failed attempt throws so pg-boss retries it, and is never requeued by hand', async () => {
    const { service, requeue } = fakeService(async (id) => {
      throw new WebhookDeliveryFailed(id, 'HTTP 500');
    });
    const job = jobOf(service, WEBHOOK_DELIVERIES_QUEUE);
    await expect(job.handler({ deliveryId: 'd-2' }, META)).rejects.toBeInstanceOf(WebhookDeliveryFailed);
    expect(requeue).not.toHaveBeenCalled();
  });

  it('a delivered attempt neither throws nor requeues', async () => {
    const { service, requeue } = fakeService(async () => ({ status: 'delivered' }));
    const job = jobOf(service, WEBHOOK_DELIVERIES_QUEUE);
    await expect(job.handler({ deliveryId: 'd-3' }, META)).resolves.toBeUndefined();
    expect(requeue).not.toHaveBeenCalled();
  });
});
