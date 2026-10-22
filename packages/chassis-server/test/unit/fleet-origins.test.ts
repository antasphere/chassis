import { describe, expect, it } from 'vitest';
import { FleetOrigins } from '../../src/webhooks/fleet-origins.js';

/**
 * The fleet reader on its own (PRDCT-3772, the gaps of verifier round 1): an
 * answer off the hub's contract is a failed read; the retry interval follows
 * a failure and the refresh interval a success; the timer skips while
 * draining; concurrent refreshes share one read; a stop is final even with a
 * read in flight; no redirect is followed.
 */

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const GOOD = { tools: [{ clientId: 'tool-crm', name: 'CRM', origin: 'https://crm.example.com' }] };

type Answer = { status: number; body: unknown } | 'network' | { delayMs: number; body: unknown };

function reader(answers: Answer[] | (() => Answer), dials = {}) {
  const calls: RequestInit[] = [];
  const next = () =>
    typeof answers === 'function' ? answers() : (answers.shift() ?? { status: 200, body: GOOD });
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const a = next();
    if (a === 'network') throw new TypeError('fetch failed');
    if ('delayMs' in a) {
      await new Promise((r) => setTimeout(r, a.delayMs));
      return new Response(JSON.stringify(a.body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const fleet = new FleetOrigins({ issuerUrl: 'https://hub.example/', logger, fetchImpl, dials });
  return { fleet, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FleetOrigins', () => {
  it('reads the hub with no credential and no redirect followed, at <issuer>/api/v1/tool-origins', async () => {
    const { fleet, calls } = reader([{ status: 200, body: GOOD }]);
    expect(await fleet.refresh()).toEqual({ ok: true, count: 1 });
    expect(calls[0]!.redirect).toBe('error');
    expect((calls[0]!.headers as Record<string, string>).authorization).toBeUndefined();
    expect([...fleet.get()]).toEqual(['https://crm.example.com']);
  });

  it('an answer off the hub contract is a failed read: the list stays as it was', async () => {
    const { fleet } = reader([
      { status: 200, body: GOOD },
      { status: 200, body: { tools: [{ origin: 'https://x.example' }] } }
    ]);
    await fleet.refresh();
    const read = await fleet.refresh();
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/off the hub contract/);
    expect([...fleet.get()]).toEqual(['https://crm.example.com']);
    expect(fleet.lastError).toMatch(/off the hub contract/);
  });

  it('a 3xx, a 500 and a network failure are failed reads; the first success fills an empty list', async () => {
    const { fleet } = reader([
      { status: 302, body: {} },
      { status: 500, body: {} },
      'network',
      { status: 200, body: GOOD }
    ]);
    expect((await fleet.refresh()).ok).toBe(false);
    expect(await fleet.refresh()).toMatchObject({ ok: false, count: 0, error: 'Error: HTTP 500' });
    expect((await fleet.refresh()).error).toMatch(/fetch failed/);
    expect(fleet.fetchedAt).toBeNull();
    expect(await fleet.refresh()).toEqual({ ok: true, count: 1 });
    expect(fleet.lastError).toBeNull();
  });

  it('after a failure the timer waits retryMs, after a success refreshMs', async () => {
    const { fleet, calls } = reader(() => ({ status: 500, body: {} }), {
      refreshMs: 10_000,
      retryMs: 30,
      timeoutMs: 1000
    });
    fleet.start();
    await sleep(250);
    fleet.stop();
    expect(calls.length).toBeGreaterThanOrEqual(4);

    const ok = reader(() => ({ status: 200, body: GOOD }), {
      refreshMs: 10_000,
      retryMs: 30,
      timeoutMs: 1000
    });
    await ok.fleet.refresh();
    ok.fleet.start();
    await sleep(250);
    ok.fleet.stop();
    expect(ok.calls.length).toBe(1);
  });

  it('skips while draining', async () => {
    const { fleet, calls } = reader(() => ({ status: 200, body: GOOD }), {
      refreshMs: 20,
      retryMs: 20,
      timeoutMs: 1000
    });
    fleet.start({ isDraining: () => true });
    await sleep(150);
    fleet.stop();
    expect(calls.length).toBe(0);
  });

  it('concurrent refreshes share one read', async () => {
    const { fleet, calls } = reader(() => ({ delayMs: 50, body: GOOD }));
    const reads = await Promise.all([fleet.refresh(), fleet.refresh(), fleet.refresh()]);
    expect(calls.length).toBe(1);
    expect(reads.every((r) => r.ok)).toBe(true);
  });

  it('a stop with a read in flight is final: the read’s continuation re-arms nothing', async () => {
    const { fleet, calls } = reader(() => ({ delayMs: 100, body: GOOD }), {
      refreshMs: 150,
      retryMs: 150,
      timeoutMs: 1000
    });
    fleet.start();
    await sleep(200); // the timer fired at 150 ms; its read is in flight
    expect(calls.length).toBe(1);
    fleet.stop();
    await sleep(500);
    expect(calls.length).toBe(1);
  });
});
