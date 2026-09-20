import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endPool } from '../../src/testing/helpers.js';

/**
 * `endPool`'s own guarantees (PRDCT-2547), without a container. The race it
 * closes only fires on a machine slow enough for the container to stop while
 * sockets are open, so the integration suite cannot tell the helper from a
 * broken variant of it; this file can.
 *
 * The fake is exactly what `endPool` reads of a `pg.Pool`: `totalCount`,
 * `end()`, and the `remove` and `error` events. It is a plain `EventEmitter`,
 * so an `error` emitted with no listener THROWS, which is how Node reports the
 * unhandled pool error the helper exists for.
 */
class FakePool extends EventEmitter {
  ended = false;
  constructor(public totalCount: number) {
    super();
  }
  /** pg-pool's `end()`: resolves at once, the sockets still open. */
  async end(): Promise<void> {
    this.ended = true;
  }
}

const asPool = (fake: FakePool) => fake as unknown as pg.Pool;
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Runs `endPool` and says, at any moment, whether it has resolved. */
function run(fake: FakePool, ceilingMs?: number) {
  const state = { resolved: false };
  const done = (ceilingMs === undefined ? endPool(asPool(fake)) : endPool(asPool(fake), ceilingMs)).then(
    () => {
      state.resolved = true;
    }
  );
  return { state, done };
}

/** Lets every pending microtask run (fake timers leave them alone). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('endPool', () => {
  it('resolves only after as many `remove` as the pool had clients', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakePool(3);
    const { state, done } = run(fake);

    await settle();
    expect(fake.ended).toBe(true);
    expect(state.resolved).toBe(false); // `pool.end()` has resolved, the sockets have not closed

    fake.emit('remove');
    fake.emit('remove');
    await settle();
    expect(state.resolved).toBe(false); // two of three

    fake.emit('remove');
    await done;
    expect(state.resolved).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves at once on a pool that has no client, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakePool(0);
    await run(fake).done;
    expect(fake.ended).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('absorbs a `57P01` emitted during the wait', async () => {
    const fake = new FakePool(1);
    const { state, done } = run(fake);
    await settle();

    // With no `error` listener this emit throws: the unhandled pool error.
    expect(() =>
      fake.emit('error', pgError('57P01', 'terminating connection due to administrator command'))
    ).not.toThrow();
    expect(state.resolved).toBe(false); // an absorbed error is not a closed socket

    fake.emit('remove');
    await done;
  });

  it('lets any other error code surface during the wait', async () => {
    const fake = new FakePool(1);
    const { done } = run(fake);
    await settle();

    const genuine = pgError('08006', 'a genuine connection failure');
    expect(() => fake.emit('error', genuine)).toThrow(genuine);
    const codeless = new Error('no code at all');
    expect(() => fake.emit('error', codeless)).toThrow(codeless);

    fake.emit('remove');
    await done;
  });

  it('with no `remove`, resolves at the ceiling and warns once with the count', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakePool(4);
    const { state, done } = run(fake, 50);
    await settle();

    fake.emit('remove'); // one of four closes, three never do
    await vi.advanceTimersByTimeAsync(49);
    expect(state.resolved).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('3 pool client(s) still open');
    expect(line).toContain('50 ms');

    // The listener stays the net under the expired wait: the late 57P01 is absorbed.
    expect(() => fake.emit('error', pgError('57P01', 'late'))).not.toThrow();
    // Sockets that close after the ceiling add no second warning.
    fake.emit('remove');
    fake.emit('remove');
    fake.emit('remove');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the default ceiling is 10 s: nothing resolves before it without the removes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakePool(2);
    const { state, done } = run(fake);
    await settle();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.resolved).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('2 pool client(s) still open');
    expect(String(warn.mock.calls[0]?.[0])).toContain('10000 ms');
  });

  it('a clean end clears the ceiling timer and leaves its listeners on the ended pool', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakePool(1);
    const { done } = run(fake);
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    fake.emit('remove');
    await done;

    // The timer is cleared: no warning can fire later on a pool that closed in time.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).not.toHaveBeenCalled();

    // What the code really does with its listeners: it removes neither. The
    // pool is ended and never used again, and the `error` one is the net for a
    // 57P01 that lands after the wait. One of each, so nothing accumulates.
    expect(fake.listenerCount('error')).toBe(1);
    expect(fake.listenerCount('remove')).toBe(1);
    expect(() => fake.emit('error', pgError('57P01', 'after the end'))).not.toThrow();
    expect(() => fake.emit('error', pgError('08006', 'after the end'))).toThrow();
  });
});
