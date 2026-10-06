import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPlatform, type BootResult, type ToolDefinition } from '../../src/index.js';
import { TimerError, type TimerJob, type Timers } from '../../src/jobs/index.js';
import type { JobDeclaration } from '../../src/jobs/pgboss.js';
import { createDatabase, makeCreateTestApp, startPostgres, type TestApp } from '../../src/testing/index.js';
import { minimalTool } from '../host/minimal-tool.js';

/**
 * One-off timers on a real pg-boss (PRDCT-3254): a tool declares a queue with
 * no schedule, a service arms a timer on it, the handler runs once with the
 * payload, the job's id and its key. A key replaces the pending timer under
 * the per-key lock, a cancel withdraws it, an undeclared queue is named, a
 * timer survives a restart, and an api-role replica schedules and cancels.
 *
 * The file carries its own tool (two queues: a timer queue and a nightly
 * cron), so it runs in the chassis package only: the tool's integration run
 * excludes it, like `empty-tool.test.ts`.
 *
 * pg-boss polls every two seconds: every wait below is a poll of the
 * recorded runs or of `pgboss.job`, with a deadline, never a bare sleep but
 * where the point is that something does NOT happen.
 */

const TIMER_QUEUE = 'things-timer';
const NIGHTLY_QUEUE = 'things-nightly';
const NIGHTLY_CRON = '0 3 * * *';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEADLINE_MS = 15_000;
const STEP_MS = 200;

interface TimerData {
  n: number | string;
  fail?: boolean;
  /** How long the handler holds the run, in ms (a running timer for the replace and cancel cases). */
  holdMs?: number;
}

interface Run {
  data: TimerData | null;
  job: TimerJob;
  at: number;
}

const runs: Run[] = [];
const nightlyRuns: Array<{ data: object | null; job: TimerJob }> = [];
const failedOnce = new Set<string>();

const timerJob: JobDeclaration<TimerData> = {
  queue: TIMER_QUEUE,
  async handler(data, job) {
    runs.push({ data, job, at: Date.now() });
    if (data?.holdMs) await sleep(data.holdMs);
    if (data?.fail === true) {
      const n = String(data.n);
      if (!failedOnce.has(n)) {
        failedOnce.add(n);
        throw new Error(`timer ${n}: the first run fails on purpose`);
      }
    }
  }
};

const nightlyJob: JobDeclaration = {
  queue: NIGHTLY_QUEUE,
  schedule: { cron: NIGHTLY_CRON },
  async handler(data, job) {
    nightlyRuns.push({ data, job });
  }
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoEnv = {};
interface TimersDomain {
  timers: Timers;
}

/** The minimal test tool, its domain the `Timers` its services slot received, its jobs the two queues. */
const tool: ToolDefinition<NoEnv, TimersDomain> = {
  identity: minimalTool.identity,
  runtime: minimalTool.runtime,
  db: minimalTool.db,
  scopes: minimalTool.scopes,
  services: (core) => ({ timers: core.timers }),
  jobs: () => [timerJob, nightlyJob],
  api: {
    // A tool with no domain references no blob (the empty tool's policy); no file is uploaded here.
    filePolicy: () => ({ blobInUse: async () => false, blobReadScope: () => undefined })
  },
  mcp: minimalTool.mcp,
  copy: minimalTool.copy
};

type TimersApp = TestApp<BootResult<NoEnv, TimersDomain>>;

const createTestApp = makeCreateTestApp(createPlatform(tool).boot);

let container: StartedPostgreSqlContainer;
let mainUrl: string;
let app: TimersApp;
const extraApps: TimersApp[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${DEADLINE_MS} ms waiting for ${label}`);
    await sleep(STEP_MS);
  }
}

const runsOf = (n: TimerData['n']) => runs.filter((r) => r.data?.n === n);

async function rowOf(
  target: TimersApp,
  id: string
): Promise<{ state: string; start_after: Date; keep_until: Date } | undefined> {
  const { rows } = await target.db.pool.query(
    'SELECT state, start_after, keep_until FROM pgboss.job WHERE id = $1',
    [id]
  );
  return rows[0];
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await rowOf(app, id))?.state;
}

async function countByKey(key: string, states: string[]): Promise<number> {
  const { rows } = await app.db.pool.query(
    'SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND singleton_key = $2 AND state = ANY($3)',
    [TIMER_QUEUE, key, states]
  );
  return rows[0].n as number;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e
  );
}

beforeAll(async () => {
  container = await startPostgres();
  mainUrl = await createDatabase(container, 'timers_main');
  app = await createTestApp(mainUrl);
}, 240_000);

afterAll(async () => {
  for (const extra of extraApps) await extra.stop().catch(() => {});
  await app?.stop().catch(() => {});
  await container?.stop();
});

describe('one-off timers on a declared queue', () => {
  it('the services slot receives the same Timers as the boot result', () => {
    expect(app.tool.timers).toBe(app.jobs.timers);
  });

  it('a. inSeconds: the handler runs once with the payload, the id, the queue, no key', async () => {
    const id = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 1 }, { inSeconds: 1 });
    expect(id).toMatch(UUID);
    const run = await waitFor('the run of n=1', () => runsOf(1)[0]);
    expect(run.data).toEqual({ n: 1 });
    expect(run.job).toEqual({ id, queue: TIMER_QUEUE, key: null });
    await waitFor('n=1 completed', async () => ((await stateOf(id)) === 'completed' ? true : undefined));
    expect(runsOf(1)).toHaveLength(1);
  });

  it('b. at: the handler runs once at the instant', async () => {
    const id = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'b' }, { at: new Date(Date.now() + 1000) });
    expect(id).toMatch(UUID);
    const run = await waitFor('the run of n=b', () => runsOf('b')[0]);
    expect(run.data).toEqual({ n: 'b' });
    expect(run.job).toEqual({ id, queue: TIMER_QUEUE, key: null });
    await waitFor('n=b completed', async () => ((await stateOf(id)) === 'completed' ? true : undefined));
    expect(runsOf('b')).toHaveLength(1);
  });

  it('c. a key replaces the pending timer: the first is cancelled, only the second runs', async () => {
    const first = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'first' }, { inSeconds: 120, key: 'k1' });
    const second = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'second' }, { inSeconds: 1, key: 'k1' });
    expect(second).not.toBe(first);
    expect(await stateOf(first)).toBe('cancelled');
    expect(await countByKey('k1', ['created', 'retry'])).toBe(1);

    const run = await waitFor('the run of key k1', () => runs.find((r) => r.job.key === 'k1'));
    expect(run.data).toEqual({ n: 'second' });
    expect(run.job).toEqual({ id: second, queue: TIMER_QUEUE, key: 'k1' });
    await sleep(4000);
    expect(runs.filter((r) => r.job.key === 'k1')).toHaveLength(1);
    expect(runsOf('first')).toHaveLength(0);
    expect(await stateOf(first)).toBe('cancelled');
  }, 40_000);

  it('d. cancel by id withdraws the timer; a second cancel answers 0', async () => {
    const startedAt = Date.now();
    const id = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'd' }, { inSeconds: 2 });
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { id })).resolves.toBe(1);
    expect(await stateOf(id)).toBe('cancelled');
    await sleep(Math.max(0, startedAt + 5000 - Date.now()));
    expect(runsOf('d')).toHaveLength(0);
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { id })).resolves.toBe(0);
  });

  it('e. cancel by key withdraws the pending keyed timer; an unknown key answers 0', async () => {
    const id = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'e' }, { inSeconds: 120, key: 'k-e' });
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'k-e' })).resolves.toBe(1);
    expect(await stateOf(id)).toBe('cancelled');
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'never' })).resolves.toBe(0);
  });

  it('f. an undeclared queue is named, nothing is inserted, the keyed path rolls back', async () => {
    const countNoSuch = async () =>
      (await app.db.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'no-such-queue'"))
        .rows[0].n as number;

    const plain = await rejection(app.jobs.timers.schedule('no-such-queue', {}, { inSeconds: 1 }));
    expect(plain).toBeInstanceOf(TimerError);
    expect((plain as TimerError).code).toBe('unknown_queue');
    expect(await countNoSuch()).toBe(0);

    const keyed = await rejection(
      app.jobs.timers.schedule('no-such-queue', {}, { inSeconds: 1, key: 'k-f' })
    );
    expect(keyed).toBeInstanceOf(TimerError);
    expect((keyed as TimerError).code).toBe('unknown_queue');
    expect(await countNoSuch()).toBe(0);

    // The client went back to the pool outside a transaction: the next keyed schedule works.
    const id = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'f-after' }, { inSeconds: 120, key: 'k-f' });
    expect(id).toMatch(UUID);
    expect(await stateOf(id)).toBe('created');
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'k-f' })).resolves.toBe(1);
  });

  it('g. a timer 40 days ahead is kept until after its start', async () => {
    const id = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'g' },
      { at: new Date(Date.now() + 40 * 24 * 3600 * 1000) }
    );
    const row = await rowOf(app, id);
    expect(row).toBeDefined();
    expect(row!.keep_until.getTime()).toBeGreaterThan(row!.start_after.getTime());
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { id })).resolves.toBe(1);
  });

  it('h. retry: limit 1 runs twice and completes; limit 0 runs once and fails', async () => {
    const retried = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'h1', fail: true },
      { inSeconds: 0, retry: { limit: 1 } }
    );
    const once = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'h0', fail: true },
      { inSeconds: 0, retry: { limit: 0 } }
    );
    await waitFor('h1 completed', async () => ((await stateOf(retried)) === 'completed' ? true : undefined));
    await waitFor('h0 failed', async () => ((await stateOf(once)) === 'failed' ? true : undefined));
    expect(runsOf('h1')).toHaveLength(2);
    expect(runsOf('h1').every((r) => r.job.id === retried)).toBe(true);
    expect(runsOf('h0')).toHaveLength(1);
  }, 40_000);

  it('i. twelve concurrent schedules under one key leave exactly one pending timer', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.jobs.timers.schedule(TIMER_QUEUE, { n: `race-${i}` }, { inSeconds: 120, key: 'race' })
      )
    );
    expect(new Set(ids).size).toBe(12);
    expect(await countByKey('race', ['created', 'retry'])).toBe(1);
    expect(await countByKey('race', ['cancelled'])).toBe(11);
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'race' })).resolves.toBe(1);
  });

  it("j. a cron's run hands the handler null, and the cron is still declared", async () => {
    // What the cron does: a send with no payload.
    await app.jobs.boss.send({ name: NIGHTLY_QUEUE });
    const run = await waitFor('the nightly run', () => nightlyRuns[0]);
    expect(run.data).toBeNull();
    expect(run.job.key).toBeNull();
    expect(run.job.queue).toBe(NIGHTLY_QUEUE);
    const schedules = await app.jobs.boss.getSchedules();
    expect(schedules.find((s) => s.name === NIGHTLY_QUEUE)).toMatchObject({
      name: NIGHTLY_QUEUE,
      cron: NIGHTLY_CRON
    });
  });

  it('k. a timer survives a restart: scheduled on A, run by B after A stopped', async () => {
    const restartUrl = await createDatabase(container, 'timers_restart');
    const a = await createTestApp(restartUrl);
    extraApps.push(a);
    const id = await a.jobs.timers.schedule(TIMER_QUEUE, { n: 'k' }, { inSeconds: 4 });
    await a.stop();
    const stoppedAt = Date.now();
    expect(runsOf('k')).toHaveLength(0);

    const b = await createTestApp(restartUrl);
    extraApps.push(b);
    const run = await waitFor('the run of n=k on B', () => runsOf('k')[0]);
    expect(run.job.id).toBe(id);
    expect(run.at).toBeGreaterThan(stoppedAt);
    expect(runsOf('k')).toHaveLength(1);
  }, 120_000);

  it('m. a replace during a RUNNING keyed timer whose run then fails: the old run ends failed, never retry; one pending under the key', async () => {
    // retry: one more attempt a minute later, which the replace must take away.
    const first = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'm-old', fail: true, holdMs: 3000 },
      { inSeconds: 0, key: 'k-m', retry: { limit: 1, delaySeconds: 60 } }
    );
    await waitFor('m-old running', async () => ((await stateOf(first)) === 'active' ? true : undefined));
    const second = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'm-new' },
      { inSeconds: 120, key: 'k-m' }
    );
    await waitFor('m-old failed', async () => ((await stateOf(first)) === 'failed' ? true : undefined));
    expect(await countByKey('k-m', ['created', 'retry'])).toBe(1);
    expect(await stateOf(second)).toBe('created');
    expect(runsOf('m-old')).toHaveLength(1);
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'k-m' })).resolves.toBe(1);
  }, 40_000);

  it('n. a cancel during a RUNNING timer withdraws nothing (0, still active), then the run completes; a cancel by id takes a failing run’s retry away', async () => {
    const running = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'n-run', holdMs: 4000 },
      { inSeconds: 0, key: 'k-n' }
    );
    await waitFor('n-run running', async () => ((await stateOf(running)) === 'active' ? true : undefined));
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { id: running })).resolves.toBe(0);
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { key: 'k-n' })).resolves.toBe(0);
    expect(await stateOf(running)).toBe('active');
    await waitFor('n-run completed', async () =>
      (await stateOf(running)) === 'completed' ? true : undefined
    );
    expect(runsOf('n-run')).toHaveLength(1);

    const failing = await app.jobs.timers.schedule(
      TIMER_QUEUE,
      { n: 'n-fail', fail: true, holdMs: 3000 },
      { inSeconds: 0, retry: { limit: 2, delaySeconds: 60 } }
    );
    await waitFor('n-fail running', async () => ((await stateOf(failing)) === 'active' ? true : undefined));
    await expect(app.jobs.timers.cancel(TIMER_QUEUE, { id: failing })).resolves.toBe(0);
    await waitFor('n-fail failed', async () => ((await stateOf(failing)) === 'failed' ? true : undefined));
    expect(runsOf('n-fail')).toHaveLength(1);
  }, 40_000);

  it('l. an api-role replica schedules and cancels; the all-role replica runs the timer', async () => {
    const api = await createTestApp(mainUrl, { SERVICE_ROLE: 'api' });
    extraApps.push(api);
    expect(api.tool.timers).toBe(api.jobs.timers);

    const id = await api.jobs.timers.schedule(TIMER_QUEUE, { n: 'l' }, { inSeconds: 1 });
    expect(id).toMatch(UUID);
    const run = await waitFor('the run of n=l', () => runsOf('l')[0]);
    expect(run.job).toEqual({ id, queue: TIMER_QUEUE, key: null });

    const pending = await app.jobs.timers.schedule(TIMER_QUEUE, { n: 'l-pending' }, { inSeconds: 120 });
    await expect(api.jobs.timers.cancel(TIMER_QUEUE, { id: pending })).resolves.toBe(1);
    expect(await stateOf(pending)).toBe('cancelled');
  }, 120_000);
});
