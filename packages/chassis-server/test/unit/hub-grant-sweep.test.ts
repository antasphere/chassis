import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRANT_SWEEP_DIALS, HubGrantService } from '../../src/identity/hub-grant.js';
import type { Logger } from '../../src/logger.js';

/**
 * PRDCT-3584. A person back after a coffee used to meet the hub's token
 * endpoint inside their first request. The sweep renews, off any request,
 * the token of every recently seen person whose token is about to expire,
 * through `refresh()` alone, and forgets the people not seen for an hour.
 */

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function service(nowRef: { t: number }) {
  // The constructor only stores its options; nothing here touches the db
  // (the refresh is stubbed below), so the dummies never run.
  const svc = new HubGrantService({
    db: {} as never,
    issuerUrl: 'http://hub.test',
    clientId: 'tool-x',
    clientSecret: 'secret',
    tokenResource: null,
    key: async () => 'k',
    connectionString: 'postgres://unused',
    logger: silent,
    dials: {
      accessSkewMs: 60_000,
      tokenTimeoutMs: 5_000,
      introspectTimeoutMs: 5_000,
      lockWatchdogMs: 12_000
    },
    now: () => nowRef.t
  });
  const refresh = vi.spyOn(svc, 'refresh').mockResolvedValue({ kind: 'ok', accessToken: 'renewed' });
  return { svc, refresh };
}

const MIN = 60_000;

describe('HubGrantService.sweepExpiring', () => {
  it('renews a recently seen person whose cached token expires within the window', async () => {
    const now = { t: 1_000_000 };
    const { svc, refresh } = service(now);
    svc.prime('alice', 'tok', new Date(now.t + 15 * MIN));
    await svc.accessToken('alice'); // seen
    now.t += 13 * MIN; // 2 min left: inside renewAheadMs (3 min)
    expect(await svc.sweepExpiring()).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('alice');
  });

  it('leaves a token that still has time, and a person it never saw', async () => {
    const now = { t: 1_000_000 };
    const { svc, refresh } = service(now);
    svc.prime('alice', 'tok', new Date(now.t + 15 * MIN));
    await svc.accessToken('alice');
    svc.prime('bob', 'tok', new Date(now.t + 1 * MIN)); // primed, never read: not seen
    now.t += 5 * MIN; // alice: 10 min left
    expect(await svc.sweepExpiring()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('forgets a person not seen within the active window instead of renewing them', async () => {
    const now = { t: 1_000_000 };
    const { svc, refresh } = service(now);
    svc.prime('alice', 'tok', new Date(now.t + 15 * MIN));
    await svc.accessToken('alice');
    now.t += 61 * MIN; // seen 61 min ago, token long expired
    expect(await svc.sweepExpiring()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    // and she is gone: a later pass with a fresh token in cache still skips her
    svc.prime('alice', 'tok2', new Date(now.t + 2 * MIN));
    expect(await svc.sweepExpiring()).toBe(0);
  });

  it('never throws when a renewal fails, and says so', async () => {
    const now = { t: 1_000_000 };
    const { svc, refresh } = service(now);
    refresh.mockRejectedValueOnce(new Error('boom'));
    svc.prime('alice', 'tok', new Date(now.t + 2 * MIN));
    await svc.accessToken('alice');
    expect(await svc.sweepExpiring()).toBe(1);
    expect(silent.warn).toHaveBeenCalled();
  });

  it('runs on a timer that skips while draining and can be stopped', async () => {
    vi.useFakeTimers();
    try {
      const now = { t: 1_000_000 };
      const { svc, refresh } = service(now);
      svc.prime('alice', 'tok', new Date(now.t + 2 * MIN));
      await svc.accessToken('alice');
      let draining = true;
      const stop = svc.startSweep({ isDraining: () => draining, dials: { intervalMs: 1_000 } });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(refresh).not.toHaveBeenCalled();
      draining = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      stop();
      svc.prime('alice', 'tok', new Date(now.t + 2 * MIN));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the default dials readable', () => {
    expect(DEFAULT_GRANT_SWEEP_DIALS).toEqual({
      intervalMs: 60_000,
      renewAheadMs: 180_000,
      activeWithinMs: 3_600_000
    });
  });
});
