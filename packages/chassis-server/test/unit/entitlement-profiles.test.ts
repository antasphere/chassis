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
 */

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
const ISSUER = 'https://hub.test';
const TOOL: ToolEntitlements = {
  actions: [],
  limits: { 'files.maxBytes': { oss: 10, free: 100, pro: 500 }, seats: { oss: null, free: 3, pro: null } },
  features: { sso: { free: false, pro: true }, basic: { free: true, pro: true } }
};

function profiles(answer: () => Response | Promise<Response>, clock: { now: number }) {
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
    dials: { ttlMs: 30_000, staleMs: 15 * 60_000 }
  });
  return { p, reads: () => reads };
}

describe('EntitlementProfiles', () => {
  it('reads once per account per TTL, single-flight, and resolves the tier values', async () => {
    const clock = { now: 1_000_000 };
    const { p, reads } = profiles(() => Response.json({ plan: 'pro' }), clock);
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
    await p.get('acct', TOOL);
    expect(reads()).toBe(2);
  });

  it('the hub’s overrides win over the tier’s values, features included', async () => {
    const clock = { now: 1_000_000 };
    const { p } = profiles(
      () => Response.json({ plan: 'free', limits: { 'files.maxBytes': 250 }, features: ['sso'] }),
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
      () => (mode === 'ok' ? Response.json({ plan: 'pro' }) : Response.json({ error: {} }, { status: 500 })),
      clock
    );
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
    mode = 'down';
    clock.now += 31_000;
    const stale = await p.get('acct', TOOL);
    expect(reads()).toBe(2);
    expect(stale.plan).toBe('pro');
    expect(stale.source).toBe('hub'); // freshly re-cached from the last answer for another TTL
    clock.now += 14 * 60_000; // 14.5 min after the answer: still inside the window
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
    clock.now += 61_000; // past 15 min
    const fallen = await p.get('acct', TOOL);
    expect(fallen.plan).toBe('free');
    expect(fallen.source).toBe('default');
    expect(fallen.limits['files.maxBytes']).toBe(100);
    mode = 'ok';
    clock.now += 31_000;
    expect((await p.get('acct', TOOL)).plan).toBe('pro');
  });

  it('a malformed profile and an unreachable hub read as a miss', async () => {
    const clock = { now: 1_000_000 };
    let kind: 'malformed' | 'network' = 'malformed';
    const { p } = profiles(() => {
      if (kind === 'network') throw new TypeError('fetch failed');
      return Response.json({ plan: 'platinum' });
    }, clock);
    expect((await p.get('a', TOOL)).plan).toBe('free');
    kind = 'network';
    expect((await p.get('b', TOOL)).plan).toBe('free');
  });
});
