import { describe, expect, it } from 'vitest';
import { createPerKeyQueue } from '../../src/api/workspaces.js';

/**
 * The per-person queue in front of the workspace-create transaction
 * (PRDCT-4441): one piece of work per key at a time, in arrival order; keys
 * independent; a failure releases the next waiter like a success; nothing
 * kept once a key's last piece of work is through. The integration half (one
 * pooled connection parked on the lock, the instance still served) is in
 * test/integration/workspace-create.test.ts.
 */

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createPerKeyQueue', () => {
  it('runs one piece of work per key at a time, in arrival order', async () => {
    const queue = createPerKeyQueue();
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const gates = [gate(), gate(), gate()];
    const runs = gates.map((g, i) =>
      queue.run('ada', async () => {
        running += 1;
        most = Math.max(most, running);
        log.push(`start ${i}`);
        await g.opened;
        log.push(`end ${i}`);
        running -= 1;
        return i;
      })
    );
    await tick();
    expect(log).toEqual(['start 0']);
    gates[2]!.open();
    gates[1]!.open();
    await tick();
    expect(log).toEqual(['start 0']);
    gates[0]!.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect(most).toBe(1);
  });

  it('never makes one key wait for another', async () => {
    const queue = createPerKeyQueue();
    const held = gate();
    const first = queue.run('ada', () => held.opened.then(() => 'ada'));
    expect(await queue.run('bob', async () => 'bob')).toBe('bob');
    held.open();
    expect(await first).toBe('ada');
  });

  it('a failure reaches its own caller only, and releases the next waiter', async () => {
    const queue = createPerKeyQueue();
    const held = gate();
    const failing = queue.run('ada', async () => {
      await held.opened;
      throw new Error('refused');
    });
    const next = queue.run('ada', async () => 'served');
    held.open();
    await expect(failing).rejects.toThrow('refused');
    expect(await next).toBe('served');
  });

  it('a request arriving while the second of a key runs still waits for it', async () => {
    // The first piece of work ends while a second is queued: the key is kept,
    // since the second is now the tail, and a third waits behind it.
    const queue = createPerKeyQueue();
    const [a, b] = [gate(), gate()];
    const log: string[] = [];
    const first = queue.run('ada', () => a.opened);
    const second = queue.run('ada', async () => {
      log.push('second starts');
      await b.opened;
      log.push('second ends');
    });
    a.open();
    await first;
    await tick();
    expect(log).toEqual(['second starts']);
    expect(queue.size()).toBe(1);
    const third = queue.run('ada', async () => {
      log.push('third starts');
    });
    await tick();
    expect(log).toEqual(['second starts']);
    b.open();
    await Promise.all([second, third]);
    expect(log).toEqual(['second starts', 'second ends', 'third starts']);
    expect(queue.size()).toBe(0);
  });

  it('forgets a key once its work is all through, success or failure', async () => {
    const queue = createPerKeyQueue();
    const held = gate();
    const runs = [queue.run('ada', () => held.opened), queue.run('ada', async () => undefined)];
    const other = queue.run('bob', () => held.opened);
    expect(queue.size()).toBe(2);
    held.open();
    await Promise.all([...runs, other]);
    expect(queue.size()).toBe(0);
    await expect(queue.run('ada', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(queue.size()).toBe(0);
  });

  it('a key whose work is all through starts at once next time', async () => {
    const queue = createPerKeyQueue();
    await queue.run('ada', async () => undefined);
    await expect(queue.run('ada', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    const log: string[] = [];
    const run = queue.run('ada', async () => {
      log.push('ran');
    });
    // Synchronously queued behind nothing: it starts on the next turn.
    await tick();
    expect(log).toEqual(['ran']);
    await run;
  });
});
