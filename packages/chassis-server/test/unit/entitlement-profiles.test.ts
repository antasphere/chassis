import { describe, expect, it } from 'vitest';
import type { ToolEntitlements } from '@antasphere/chassis-contract';
import { EntitlementProfiles, HubMachineToken } from '@antasphere/chassis-server';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * The per-account plan cache of the cloud edition (the billing rail, §7):
 * one hub read per account per TTL, the hub's overrides winning over the
 * tool's tier values, the last known plan kept through an outage for the
 * stale window and then `free`, a never-answered account `free` from the
 * start, and a failure cached like an answer so a storm stays one read.
 * The read is off the request path (PRDCT-2633): a stale entry is served at
 * once while the refresh runs behind it, a cold account waits at most the
 * cold budget. The hub's answer shape is mirrored verbatim, a boolean limit
 * included (PRDCT-2636), and since phase 2 the hub's upgrade page and its
 * features list as the truth once it serves limit rows (PRDCT-2664).
 */

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
const ISSUER = 'https://hub.test';
const TOOL: ToolEntitlements = {
  actions: [],
  limits: { 'files.maxBytes': { oss: 10, free: 100, pro: 500 }, seats: { oss: null, free: 3, pro: null } },
  features: { sso: { free: false, pro: true }, basic: { free: true, pro: true } }
};

/** The hub's whole answer (the shape the contract mirrors verbatim), with the test's fields over it. */
const answerOf = (over: Record<string, unknown>) =>
  Response.json({
    accountRef: '77777777-aaaa-4bbb-8ccc-000000000001',
    plan: 'free',
    planUntil: null,
    limits: {},
    features: [],
    ...over
  });

function profiles(
  answer: () => Response | Promise<Response>,
  clock: { now: number },
  dials: { coldWaitMs?: number } = {}
) {
  let reads = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/oauth2/token')) {
      return Response.json({ access_token: 'mach_1', expires_in: 3600 });
    }
    reads += 1;
    return answer();
  }) as typeof fetch;
  const token = new HubMachineToken({
    issuerUrl: ISSUER,
    clientId: 'tool-things',
    clientSecret: 's'.repeat(20),
    resource: `${ISSUER}/mcp`,
    logger,
    fetchImpl,
    now: () => clock.now
  });
  const p = new EntitlementProfiles({
    issuerUrl: ISSUER,
    token,
    logger,
    fetchImpl,
    now: () => clock.now,
    dials: { ttlMs: 30_000, staleMs: 15 * 60_000, ...dials }
  });
  return { p, reads: () => reads };
}

describe('EntitlementProfiles', () => {
  it('reads once per account per TTL, single-flight, and resolves the tier values', async () => {
    const clock = { now: 1_000_000 };
    const { p, reads } = profiles(() => answerOf({ plan: 'pro' }), clock);
    const [a, b] = await Promise.all([p.get('acct', TOOL), p.get('acct', TOOL)]);
    expect(reads()).toBe(1);
    expect(a).toEqual(b);
    expect(a.plan).toBe('pro');
    expect(a.source).toBe('hub');
    expect(a.limits).toEqual({ 'files.maxBytes': 500, seats: null });
    expect([...a.features].sort()).toEqual(['basic', 'sso']);
    clock.now += 29_000;
    await p.get('acct', TOOL);
    expect(reads()).toBe(1);
    clock.now += 2_000;
    // Past the TTL: served at once from the last answer, the refresh behind it.
    const served = await p.get('acct', TOOL);
    expect(served.plan).toBe('pro');
    expect(served.source).toBe('stale');
    await p.settle();
    expect(reads()).toBe(2);
    expect((await p.get('acct', TOOL)).source).toBe('hub');
  });

  it('the hub’s overrides win over the tier’s values, features included', async () => {
    const clock = { now: 1_000_000 };
    const { p } = profiles(
      () => answerOf({ plan: 'free', limits: { 'files.maxBytes': 250 }, features: ['sso'] }),
      clock
    );
    const profile = await p.get('acct', TOOL);
    expect(profile.plan).toBe('free');
    expect(profile.limits).toEqual({ 'files.maxBytes': 250, seats: 3 });
    expect([...profile.features]).toEqual(['sso']);
  });

  it('an account the hub never answered for is free, and the miss is cached for the TTL', async () => {
    const clock = { now: 1_000_000 };
    const { p, reads } = profiles(
      () => Response.json({ error: { code: 'not_found' } }, { status: 404 }),
      clock
    );
    const a = await p.get('acct', TOOL);
    expect(a.plan).toBe('free');
    expect(a.source).toBe('default');
    expect(a.limits['files.maxBytes']).toBe(100);
    await p.get('acct', TOOL);
    expect(reads()).toBe(1);
  });

  it('keeps the last known plan through an outage for the stale window, then falls to free', async () => {
    const clock = { now: 1_000_000 };
    let mode: 'ok' | 'down' = 'ok';
    const { p, reads } = profiles(
      () => (mode === 'ok' ? answerOf({ plan: 'pro' }) : Response.json({ error: {} }, { status: 500 })),
      clock
    );
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
    mode = 'down';
    clock.now += 31_000;
    const stale = await p.get('acct', TOOL);
    expect(stale.plan).toBe('pro');
    expect(stale.source).toBe('stale'); // served now, the refresh behind it
    await p.settle();
    expect(reads()).toBe(2);
    expect((await p.get('acct', TOOL)).source).toBe('hub'); // re-cached from the last answer for another TTL
    clock.now += 14 * 60_000; // 14.5 min after the answer: still inside the window
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
    await p.settle();
    clock.now += 61_000; // past 15 min
    const fallen = await p.get('acct', TOOL);
    expect(fallen.plan).toBe('free');
    expect(fallen.source).toBe('default');
    expect(fallen.limits['files.maxBytes']).toBe(100);
    await p.settle(); // the miss the fallen read started, behind the request
    mode = 'ok';
    clock.now += 31_000;
    await p.get('acct', TOOL);
    await p.settle();
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
  });

  it('a slow hub costs a warm request nothing (PRDCT-2633): the stale plan is served at once, the refresh lands behind it', async () => {
    const clock = { now: 1_000_000 };
    let release: (() => void) | null = null;
    let slow = false;
    const { p, reads } = profiles(async () => {
      if (slow) await new Promise<void>((r) => (release = r));
      return answerOf({ plan: 'pro' });
    }, clock);
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
    slow = true;
    clock.now += 31_000;
    const started = Date.now();
    const served = await p.get('acct', TOOL);
    expect(Date.now() - started).toBeLessThan(200);
    expect(served.plan).toBe('pro');
    expect(served.source).toBe('stale');
    expect(reads()).toBe(2); // the refresh is in flight, single-flight
    await p.get('acct', TOOL);
    expect(reads()).toBe(2);
    release!();
    await p.settle();
    expect((await p.get('acct', TOOL)).source).toBe('hub');
  });

  it('a cold account waits for its first read up to the cold budget, then is served the default while the read finishes', async () => {
    const clock = { now: 1_000_000 };
    let release: (() => void) | null = null;
    const { p, reads } = profiles(
      async () => {
        await new Promise<void>((r) => (release = r));
        return answerOf({ plan: 'pro' });
      },
      clock,
      { coldWaitMs: 50 }
    );
    const started = Date.now();
    const cold = await p.get('acct', TOOL);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(cold.plan).toBe('free');
    expect(cold.source).toBe('default');
    expect(reads()).toBe(1);
    release!();
    await p.settle();
    const warm = await p.get('acct', TOOL);
    expect(warm.plan).toBe('pro');
    expect(warm.source).toBe('hub');
    expect(reads()).toBe(1);
  });

  it('a cold read that answers within the budget is judged right on the first request', async () => {
    const clock = { now: 1_000_000 };
    const { p } = profiles(() => answerOf({ plan: 'pro' }), clock, { coldWaitMs: 1_000 });
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
  });

  it('every shape the hub’s contract allows parses, a boolean limit included (PRDCT-2636)', async () => {
    const clock = { now: 1_000_000 };
    const shapes: Array<[Record<string, unknown>, Record<string, number | null>]> = [
      [
        { plan: 'pro', planUntil: '2026-12-31T00:00:00.000Z', limits: {}, features: [] },
        { 'files.maxBytes': 500, seats: null }
      ],
      [
        { plan: 'free', limits: { 'files.maxBytes': true }, features: [] },
        { 'files.maxBytes': null, seats: 3 }
      ],
      [
        { plan: 'pro', limits: { seats: false, 'files.maxBytes': 42 }, features: ['sso'] },
        { 'files.maxBytes': 42, seats: 0 }
      ],
      [
        { plan: 'free', limits: { unknown: true }, features: ['sso', 'basic'] },
        { 'files.maxBytes': 100, seats: 3 }
      ]
    ];
    for (const [over, limits] of shapes) {
      const { p } = profiles(() => answerOf(over), clock);
      const profile = await p.get('acct', TOOL);
      expect(profile.source, JSON.stringify(over)).toBe('hub');
      expect(profile.plan).toBe(over.plan);
      expect(profile.limits, JSON.stringify(over)).toEqual(limits);
    }
    // A shape the hub's contract does NOT allow reads as a miss: the mirror is verbatim.
    for (const bad of [
      { plan: 'pro', limits: { seats: 'many' } },
      { plan: 'pro', limits: undefined },
      { plan: 'pro', accountRef: 'not-a-uuid' }
    ]) {
      const { p } = profiles(() => answerOf(bad as Record<string, unknown>), clock);
      expect((await p.get('acct', TOOL)).source, JSON.stringify(bad)).toBe('default');
    }
  });

  it('carries the hub’s upgrade page through resolve, and none when the hub sent none or the plan is the default', async () => {
    const clock = { now: 1_000_000 };
    const page = `${ISSUER}/billing/upgrade?org=acct&tool=things&plan=pro`;
    const { p } = profiles(() => answerOf({ plan: 'pro', upgradeUrl: page }), clock);
    expect((await p.get('acct', TOOL)).upgradeUrl).toBe(page);
    const older = profiles(() => answerOf({ plan: 'pro' }), clock);
    expect((await older.p.get('acct', TOOL)).upgradeUrl).toBeNull();
    const missing = profiles(() => Response.json({ error: {} }, { status: 500 }), clock);
    expect((await missing.p.get('acct', TOOL)).upgradeUrl).toBeNull();
  });

  it('a hub that answers limits is authoritative on features, an empty list included; one that answers none leaves the tier’s features', async () => {
    const clock = { now: 1_000_000 };
    // Phase 2: the hub serves its rows, and switches every feature off for this pro account.
    const phase2 = profiles(() => answerOf({ plan: 'pro', limits: { seats: 10 }, features: [] }), clock);
    const off = await phase2.p.get('acct', TOOL);
    expect(off.plan).toBe('pro');
    expect([...off.features]).toEqual([]);
    // Phase 1 (no limit key): an empty list means "the declared tier values apply".
    const phase1 = profiles(() => answerOf({ plan: 'pro', limits: {}, features: [] }), clock);
    expect([...(await phase1.p.get('acct', TOOL)).features].sort()).toEqual(['basic', 'sso']);
    // And a non-empty list still overrides there.
    const listed = profiles(() => answerOf({ plan: 'pro', limits: {}, features: ['basic'] }), clock);
    expect([...(await listed.p.get('acct', TOOL)).features]).toEqual(['basic']);
  });

  it('a malformed profile and an unreachable hub read as a miss', async () => {
    const clock = { now: 1_000_000 };
    let kind: 'malformed' | 'network' = 'malformed';
    const { p } = profiles(() => {
      if (kind === 'network') throw new TypeError('fetch failed');
      return answerOf({ plan: 'platinum' });
    }, clock);
    expect((await p.get('a', TOOL)).plan).toBe('free');
    kind = 'network';
    expect((await p.get('b', TOOL)).plan).toBe('free');
  });
});
