import { describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';
import type pg from 'pg';
import type { Logger } from '@antasphere/chassis-server/logger';
import {
  MAX_IN_SECONDS,
  PgBossTimers,
  TIMER_KEY_LOCK_CLASS,
  TimerError,
  startAfterOf,
  type TimerOptions,
  type TimerRef
} from '../../src/jobs/timers.js';

/**
 * The one-off timers' validation and their mapping onto pg-boss (PRDCT-3254),
 * with no database: a fake boss records `send`, a fake pool records
 * `connect` and `query`. A malformed call is refused before ANY of them is
 * touched. The statements themselves run against a real pg-boss in
 * `test/integration/timers.test.ts`.
 */

const JOB_ID = '0b9a3c8e-1f2d-4e5a-9b6c-7d8e9f0a1b2c';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function fakes(sendAnswer: string | null = JOB_ID) {
  const send = vi.fn(async (_queue: string, _data: object, _options: PgBoss.SendOptions) => sendAnswer);
  const client: FakeClient = {
    query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rowCount: 0, rows: [] })),
    release: vi.fn()
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rowCount: 0 as number | null, rows: [] }))
  };
  const timers = new PgBossTimers({ send } as unknown as PgBoss, pool as unknown as pg.Pool, logger);
  return { send, pool, client, timers };
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TimerError);
  expect((err as TimerError).code).toBe('invalid_argument');
}

function expectInvalidSync(fn: () => unknown): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TimerError);
  expect((caught as TimerError).code).toBe('invalid_argument');
}

describe('startAfterOf', () => {
  it('answers the same Date for `at`', () => {
    const at = new Date('2030-01-02T03:04:05.000Z');
    expect(startAfterOf({ at })).toBe(at);
  });

  it('answers the seconds for `inSeconds`', () => {
    expect(startAfterOf({ inSeconds: 30 })).toBe(30);
    expect(startAfterOf({ inSeconds: 0 })).toBe(0);
  });

  it('refuses neither and both', () => {
    expectInvalidSync(() => startAfterOf({} as TimerOptions));
    expectInvalidSync(() => startAfterOf({ at: new Date(), inSeconds: 3 } as unknown as TimerOptions));
  });

  it('refuses an invalid Date and a value that is not a Date', () => {
    expectInvalidSync(() => startAfterOf({ at: new Date('not a date') }));
    expectInvalidSync(() => startAfterOf({ at: '2030-01-01T00:00:00Z' } as unknown as TimerOptions));
  });

  it('refuses a negative, NaN, infinite or over-a-century delay; takes the cap itself', () => {
    expectInvalidSync(() => startAfterOf({ inSeconds: -1 }));
    expectInvalidSync(() => startAfterOf({ inSeconds: Number.NaN }));
    expectInvalidSync(() => startAfterOf({ inSeconds: Number.POSITIVE_INFINITY }));
    expectInvalidSync(() => startAfterOf({ inSeconds: MAX_IN_SECONDS + 1 }));
    expect(startAfterOf({ inSeconds: MAX_IN_SECONDS })).toBe(MAX_IN_SECONDS);
  });

  it('takes a payload with a null prototype and nested Dates (JSON takes them)', async () => {
    const { send, timers } = fakes();
    await timers.schedule('things-timer', Object.create(null) as object, { inSeconds: 1 });
    await timers.schedule('things-timer', { at: new Date() }, { inSeconds: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('schedule refuses a malformed call before any IO', () => {
  const cases: Array<[string, (t: PgBossTimers) => Promise<unknown>]> = [
    ['a queue name with a space', (t) => t.schedule('things timer', {}, { inSeconds: 1 })],
    ['an empty queue name', (t) => t.schedule('', {}, { inSeconds: 1 })],
    ['a null payload', (t) => t.schedule('things-timer', null as unknown as object, { inSeconds: 1 })],
    ['a string payload', (t) => t.schedule('things-timer', 'x' as unknown as object, { inSeconds: 1 })],
    ['a number payload', (t) => t.schedule('things-timer', 42 as unknown as object, { inSeconds: 1 })],
    ['an array payload', (t) => t.schedule('things-timer', [1, 2] as unknown as object, { inSeconds: 1 })],
    ['a Date payload', (t) => t.schedule('things-timer', new Date(), { inSeconds: 1 })],
    ['a bigint inside the payload', (t) => t.schedule('things-timer', { n: 1n }, { inSeconds: 1 })],
    [
      'a circular payload',
      (t) => {
        const data: Record<string, unknown> = {};
        data.self = data;
        return t.schedule('things-timer', data, { inSeconds: 1 });
      }
    ],
    ['a delay over a hundred years', (t) => t.schedule('things-timer', {}, { inSeconds: 1e21 })],
    ['no `at` and no `inSeconds`', (t) => t.schedule('things-timer', {}, {} as TimerOptions)],
    ['an empty key', (t) => t.schedule('things-timer', {}, { inSeconds: 1, key: '' })],
    [
      'a key carrying the unit separator',
      (t) => t.schedule('things-timer', {}, { inSeconds: 1, key: 'a\u001fb' })
    ],
    ['retry.limit -1', (t) => t.schedule('things-timer', {}, { inSeconds: 1, retry: { limit: -1 } })],
    ['retry.limit 1.5', (t) => t.schedule('things-timer', {}, { inSeconds: 1, retry: { limit: 1.5 } })],
    [
      'retry.delaySeconds -1',
      (t) => t.schedule('things-timer', {}, { inSeconds: 1, retry: { limit: 1, delaySeconds: -1 } })
    ],
    [
      'retry.limit -1 on a keyed call',
      (t) => t.schedule('things-timer', {}, { inSeconds: 1, key: 'k', retry: { limit: -1 } })
    ]
  ];

  it.each(cases)('%s → invalid_argument, no send, no connect', async (_label, call) => {
    const { send, pool, timers } = fakes();
    await expectInvalid(call(timers));
    expect(send).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('schedule without a key maps onto pg-boss send', () => {
  it('`at` → startAfter the Date, no retry options, no singletonKey, no db', async () => {
    const { send, pool, timers } = fakes();
    const at = new Date(Date.now() + 60_000);
    await expect(timers.schedule('things-timer', { n: 1 }, { at })).resolves.toBe(JOB_ID);
    expect(send).toHaveBeenCalledTimes(1);
    const [queue, data, options] = send.mock.calls[0] as unknown as [string, object, PgBoss.SendOptions];
    expect(queue).toBe('things-timer');
    expect(data).toEqual({ n: 1 });
    expect(options).toEqual({ startAfter: at });
    expect(options.startAfter).toBe(at);
    for (const absent of ['retryLimit', 'retryDelay', 'retryBackoff', 'singletonKey', 'db']) {
      expect(options).not.toHaveProperty(absent);
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('`inSeconds` → startAfter the seconds', async () => {
    const { send, timers } = fakes();
    await timers.schedule('things-timer', { n: 2 }, { inSeconds: 30 });
    expect(send.mock.calls[0]?.[2]).toEqual({ startAfter: 30 });
  });

  it('`retry` → retryLimit, retryDelay, retryBackoff', async () => {
    const { send, timers } = fakes();
    await timers.schedule(
      'things-timer',
      {},
      { inSeconds: 5, retry: { limit: 3, delaySeconds: 10, backoff: true } }
    );
    expect(send.mock.calls[0]?.[2]).toEqual({
      startAfter: 5,
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true
    });
  });

  it('`retry` with the limit alone → delay 0, no backoff', async () => {
    const { send, timers } = fakes();
    await timers.schedule('things-timer', {}, { inSeconds: 5, retry: { limit: 0 } });
    expect(send.mock.calls[0]?.[2]).toEqual({
      startAfter: 5,
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false
    });
  });

  it('a send that answers null is an unknown queue', async () => {
    const { timers } = fakes(null);
    const err = await timers.schedule('no-such-queue', {}, { inSeconds: 1 }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TimerError);
    expect((err as TimerError).code).toBe('unknown_queue');
  });
});

describe('schedule with a key runs one transaction on a client of its own', () => {
  it('BEGIN, the per-key lock, the withdraw, the insert on the same client, COMMIT, release', async () => {
    const { send, pool, client, timers } = fakes();
    await expect(timers.schedule('things-timer', { n: 3 }, { inSeconds: 7, key: 'k1' })).resolves.toBe(
      JOB_ID
    );
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const statements = client.query.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
    // The disarm of a running timer (its retries taken away) FIRST, then the withdraw of the pending one:
    // in that order pg-boss's fail path cannot slip its retry row between the two (verifier round 2, F7).
    expect(statements).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT']);
    expect(client.query.mock.calls[1]?.[1]).toEqual([TIMER_KEY_LOCK_CLASS, 'things-timer\u001fk1']);
    expect(client.query.mock.calls[2]?.[1]).toEqual(['things-timer', 'k1']);
    expect(String(client.query.mock.calls[2]?.[0])).toContain('SET retry_limit = retry_count');
    expect(String(client.query.mock.calls[2]?.[0])).toContain("state = 'active'");
    expect(client.query.mock.calls[3]?.[1]).toEqual(['things-timer', 'k1']);
    expect(String(client.query.mock.calls[3]?.[0])).toContain("state IN ('created', 'retry')");
    const options = send.mock.calls[0]?.[2] as unknown as PgBoss.SendOptions & {
      db: { executeSql: (t: string, v: unknown[]) => Promise<unknown> };
    };
    expect(options.singletonKey).toBe('k1');
    expect(options.startAfter).toBe(7);
    // The insert's executor is the transaction's client.
    await options.db.executeSql('SELECT 1', []);
    expect(client.query).toHaveBeenLastCalledWith('SELECT 1', []);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an unknown queue rolls the transaction back and releases the client', async () => {
    const { client, timers } = fakes(null);
    const err = await timers.schedule('no-such-queue', {}, { inSeconds: 1, key: 'k' }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as TimerError).code).toBe('unknown_queue');
    const statements = client.query.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('cancel refuses a malformed call before any IO', () => {
  const cases: Array<[string, string, TimerRef]> = [
    ['both id and key', 'things-timer', { id: JOB_ID, key: 'k' } as unknown as TimerRef],
    ['neither id nor key', 'things-timer', {} as TimerRef],
    ['an id that is not a UUID', 'things-timer', { id: 'not-a-uuid' }],
    ['an id with SQL in it', 'things-timer', { id: `${JOB_ID}' OR '1'='1` }],
    ['an empty key', 'things-timer', { key: '' }],
    ['a queue name with a space', 'things timer', { id: JOB_ID }]
  ];

  it.each(cases)('%s → invalid_argument, no query', async (_label, queue, ref) => {
    const { pool, timers } = fakes();
    await expectInvalid(timers.cancel(queue, ref));
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('a well-formed cancel disarms a running timer first, then answers the PENDING rows withdrawn', async () => {
    const { pool, timers } = fakes();
    pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(timers.cancel('things-timer', { id: JOB_ID })).resolves.toBe(1);
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['things-timer', JOB_ID]);
    expect(String(pool.query.mock.calls[0]?.[0])).toContain('SET retry_limit = retry_count');
    expect(pool.query.mock.calls[1]?.[1]).toEqual(['things-timer', JOB_ID]);
    expect(String(pool.query.mock.calls[1]?.[0])).toContain("state IN ('created', 'retry')");
    // The disarm's row count is not the answer: a running timer is not withdrawn.
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(timers.cancel('things-timer', { key: 'k1' })).resolves.toBe(0);
    expect(pool.query.mock.calls[2]?.[1]).toEqual(['things-timer', 'k1']);
    expect(pool.query.mock.calls[3]?.[1]).toEqual(['things-timer', 'k1']);
  });
});
