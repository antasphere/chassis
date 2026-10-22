import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/logger.js';
import { connectionJobs } from '../../src/connections/jobs.js';
import {
  CONNECTION_DELIVERIES_PURGE_QUEUE,
  type AnyConnectionService
} from '../../src/connections/service.js';

/**
 * The connections' queue declaration (PRDCT-3773): one nightly purge of the
 * deliveries log, armed only when the retention is positive, whose run asks
 * the service to purge on that retention and logs how many rows went.
 */

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeService(deleted = 0) {
  const purge = vi.fn(async (_retentionDays: number) => deleted);
  return { service: { purge } as unknown as AnyConnectionService, purge };
}

const META = { id: 'job-1', queue: CONNECTION_DELIVERIES_PURGE_QUEUE, key: null };

describe('connectionJobs', () => {
  it('declares one queue, the deliveries purge, on a cron', () => {
    const { service } = fakeService();
    const jobs = connectionJobs(service, fakeLogger(), 30);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queue).toBe(CONNECTION_DELIVERIES_PURGE_QUEUE);
    expect(CONNECTION_DELIVERIES_PURGE_QUEUE).toBe('connection-deliveries-purge');
    expect(jobs[0]!.schedule?.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  it('the schedule is enabled when the retention is positive and disabled at 0', () => {
    const { service } = fakeService();
    expect(connectionJobs(service, fakeLogger(), 30)[0]!.schedule?.enabled).toBe(true);
    expect(connectionJobs(service, fakeLogger(), 1)[0]!.schedule?.enabled).toBe(true);
    expect(connectionJobs(service, fakeLogger(), 0)[0]!.schedule?.enabled).toBe(false);
  });

  it('the handler purges on the retention and logs the count', async () => {
    const { service, purge } = fakeService(7);
    const logger = fakeLogger();
    const [job] = connectionJobs(service, logger, 14);
    await expect(job!.handler({}, META)).resolves.toBeUndefined();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(14);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]![0]).toMatchObject({ retentionDays: 14, deleted: 7 });
  });
});
