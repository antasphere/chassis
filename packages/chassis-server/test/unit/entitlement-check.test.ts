import { describe, expect, it } from 'vitest';
import type { UsageCheck } from '@antasphere/chassis-contract';
import {
  HubCreditCheck,
  HubMachineToken,
  type CreditCheckDials,
  type CreditCheckRequest
} from '../../src/entitlements/index.js';
import type { Logger } from '../../src/logger.js';

/**
 * The cloud edition's credit check against a scripted hub (the billing rail
 * spec, §7 steps 3 and 4; PRDCT-2664): the cache per account per action and
 * its reuse rule (an allowed answer for a smaller or equal quantity, a
 * denial for a larger or equal one), the dead token minted again once, the
 * answers that are not outages (400, 404 unknown_account), the outage that
 * fails open for fifteen minutes and then closes, the posture on /metrics,
 * the sweep of a large cache, and every outcome counted.
 */

const ISSUER = 'https://hub.test';
const ACCOUNT = '77777777-aaaa-4bbb-8ccc-000000000001';

type Log = { level: string; msg: string };

function makeLogger(logs: Log[]): Logger {
  const at = (level: string) => (ctx: unknown, msg?: string) =>
    logs.push({ level, msg: msg ?? (typeof ctx === 'string' ? ctx : '') });
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') } as unknown as Logger;
}

function answer(req: CreditCheckRequest, over: Partial<UsageCheck> = {}): UsageCheck {
  return {
    accountRef: req.accountRef,
    actionKey: req.actionKey,
    quantity: req.quantity,
    allowed: true,
    credits: 5,
    balance: 5_000,
    unit: req.unit,
    priced: true,
    plan: 'free',
    reason: null,
    topUpUrl: `${ISSUER}/billing/top-up?org=${req.accountRef}`,
    ...over
  };
}

type Script = (req: CreditCheckRequest) => Response | Promise<Response>;

function hub(
  script: Script,
  opts: {
    tokenDown?: () => boolean;
    dials?: Partial<CreditCheckDials>;
  } = {}
) {
  const clock = { now: 1_700_000_000_000 };
  const logs: Log[] = [];
  const logger = makeLogger(logs);
  let mints = 0;
  const asked: CreditCheckRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/oauth2/token')) {
      if (opts.tokenDown?.()) return Response.json({ error: 'server_error' }, { status: 500 });
      mints += 1;
      return Response.json({ access_token: `mach_${mints}`, expires_in: 3600 });
    }
    expect(url).toBe(`${ISSUER}/api/v1/usage/check`);
    expect(init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer mach_/) });
    const body = JSON.parse(String(init?.body)) as CreditCheckRequest;
    asked.push(body);
    return script(body);
  }) as typeof fetch;
  const token = new HubMachineToken({
    issuerUrl: ISSUER,
    clientId: 'tool-things',
    clientSecret: 's'.repeat(20),
    resource: `${ISSUER}/mcp`,
    logger,
    fetchImpl,
    now: () => clock.now,
    failureHoldMs: 0
  });
  // The hold after a failed call is off by default here so every case below
  // reaches the scripted hub on each call; the hold has its own case.
  const check = new HubCreditCheck({
    issuerUrl: ISSUER,
    token,
    logger,
    fetchImpl,
    now: () => clock.now,
    dials: { outageHoldMs: 0, ...opts.dials }
  });
  const req = (quantity: number, actionKey = 'files.upload', accountRef = ACCOUNT): CreditCheckRequest => ({
    accountRef,
    actionKey,
    quantity,
    unit: 'bytes'
  });
  const gauge = async (name: 'posture' | 'failingSince' | 'cacheEntries') =>
    (await check[name].get()).values[0]?.value ?? 0;
  const outcome = async (name: string) =>
    (await check.verdicts.get()).values.find((v) => v.labels.outcome === name)?.value ?? 0;
  return { clock, logs, check, asked, req, gauge, outcome, mints: () => mints };
}

describe('HubCreditCheck: the cache and its reuse rule', () => {
  it('an allowed answer is kept 30 s and reused for a smaller or equal quantity; a larger one asks again', async () => {
    const h = hub((r) => Response.json(answer(r)));
    expect(await h.check.check(h.req(100))).toMatchObject({ allowed: true, source: 'hub' });
    const cached = await h.check.check(h.req(100));
    expect(cached).toMatchObject({ allowed: true, source: 'cache' });
    expect(cached.check).toMatchObject({ quantity: 100 });
    expect(await h.check.check(h.req(40))).toMatchObject({ source: 'cache' });
    expect(h.check.hubCalls).toBe(1);
    expect(await h.check.check(h.req(101))).toMatchObject({ allowed: true, source: 'hub' });
    expect(h.check.hubCalls).toBe(2);
    // Another action or another account is another entry.
    await h.check.check(h.req(1, 'things.make'));
    await h.check.check(h.req(1, 'files.upload', '77777777-aaaa-4bbb-8ccc-000000000002'));
    expect(h.check.hubCalls).toBe(4);
    expect(h.check.cacheSize).toBe(3);
    h.clock.now += 29_000;
    expect(await h.check.check(h.req(101))).toMatchObject({ source: 'cache' });
    h.clock.now += 2_000;
    expect(await h.check.check(h.req(101))).toMatchObject({ source: 'hub' });
    expect(h.check.hubCalls).toBe(5);
  });

  it('an allowed answer over a fresh allowed entry keeps the larger quantity', async () => {
    let delay = true;
    const h = hub(async (r) => {
      if (delay && r.quantity === 10) await new Promise((res) => setTimeout(res, 20));
      return Response.json(answer(r));
    });
    // Two requests in flight at once: the larger lands first, the smaller after.
    await Promise.all([h.check.check(h.req(10)), h.check.check(h.req(500))]);
    delay = false;
    expect(await h.check.check(h.req(500))).toMatchObject({ source: 'cache' });
    expect(h.check.hubCalls).toBe(2);
  });

  it('a denial is kept 5 s and reused for a larger or equal quantity; a smaller one asks again', async () => {
    const h = hub((r) =>
      Response.json(
        r.quantity >= 100
          ? answer(r, { allowed: false, reason: 'insufficient_credits', balance: 3 })
          : answer(r)
      )
    );
    expect(await h.check.check(h.req(100))).toMatchObject({
      allowed: false,
      reason: 'insufficient_credits',
      source: 'hub'
    });
    const cached = await h.check.check(h.req(200));
    expect(cached).toMatchObject({ allowed: false, reason: 'insufficient_credits', source: 'cache' });
    expect(cached.check).toMatchObject({ balance: 3 });
    expect(h.check.hubCalls).toBe(1);
    expect(await h.check.check(h.req(99))).toMatchObject({ allowed: true, source: 'hub' });
    expect(h.check.hubCalls).toBe(2);
    // The allowed answer replaced the denial; after the denial's window a large quantity asks again.
    h.clock.now += 5_001;
    expect(await h.check.check(h.req(150))).toMatchObject({ allowed: false, source: 'hub' });
    expect(h.check.hubCalls).toBe(3);
  });

  it('a suspended organization is refused as account_suspended', async () => {
    const h = hub((r) => Response.json(answer(r, { allowed: false, reason: 'account_suspended' })));
    expect(await h.check.check(h.req(1))).toMatchObject({ allowed: false, reason: 'account_suspended' });
    expect(await h.outcome('suspended')).toBe(1);
  });

  it('sweeps the expired entries once the cache grows above 5,000', async () => {
    const h = hub((r) => Response.json(answer(r)));
    for (let i = 0; i < 5_001; i += 1) await h.check.check(h.req(1, `a.${i}`));
    expect(h.check.cacheSize).toBe(5_001); // nothing expired yet: nothing swept
    h.clock.now += 31_000;
    await h.check.check(h.req(1, 'fresh'));
    expect(h.check.cacheSize).toBe(1);
    expect(await h.gauge('cacheEntries')).toBe(1);
  });
});

describe('HubCreditCheck: the hub’s answers', () => {
  it('a 401 re-mints the token once; a second 401 is an outage', async () => {
    let refuse = 1;
    const h = hub((r) => (refuse-- > 0 ? new Response('{}', { status: 401 }) : Response.json(answer(r))));
    expect(await h.check.check(h.req(1))).toMatchObject({ allowed: true, source: 'hub' });
    expect(h.mints()).toBe(2);
    expect(h.check.hubCalls).toBe(2);
    const dead = hub(() => new Response('{}', { status: 401 }));
    expect(await dead.check.check(dead.req(1))).toMatchObject({ allowed: true, source: 'fail_open' });
    expect(dead.check.hubCalls).toBe(2);
    expect(dead.mints()).toBe(2);
  });

  it('a 400 is our bug: allowed, logged at error, never an outage', async () => {
    const h = hub(() => Response.json({ error: { code: 'validation_error' } }, { status: 400 }));
    expect(await h.check.check(h.req(1))).toEqual({ allowed: true, source: 'malformed', check: null });
    expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('malformed'))).toBe(true);
    expect(await h.gauge('posture')).toBe(0);
    expect(await h.gauge('failingSince')).toBe(0);
    expect(await h.outcome('malformed')).toBe(1);
  });

  it('a 404 unknown_account is allowed and starts no failure clock; another 404 is an outage', async () => {
    let code = 'unknown_account';
    const h = hub(() =>
      Response.json({ error: { code, message: 'no organization holds this id' } }, { status: 404 })
    );
    expect(await h.check.check(h.req(1))).toEqual({ allowed: true, source: 'unknown_account', check: null });
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('no organization'))).toBe(true);
    expect(await h.gauge('posture')).toBe(0);
    expect(await h.outcome('unknown_account')).toBe(1);
    code = 'not_found';
    expect(await h.check.check(h.req(2))).toMatchObject({ source: 'fail_open' });
    expect(await h.gauge('posture')).toBe(1);
  });

  it('a unit the hub prices in differs from the meter: one warning per action key', async () => {
    const h = hub((r) => Response.json(answer(r, { unit: 'megabytes' })));
    await h.check.check(h.req(1));
    await h.check.check(h.req(2));
    await h.check.check(h.req(3));
    expect(h.check.hubCalls).toBe(3);
    const warned = h.logs.filter((l) => l.level === 'warn' && l.msg.includes('another unit'));
    expect(warned).toHaveLength(1);
    // An unpriced action (unit null) is no mismatch.
    const unpriced = hub((r) => Response.json(answer(r, { unit: null, priced: false, credits: 0 })));
    await unpriced.check.check(unpriced.req(1));
    expect(unpriced.logs.filter((l) => l.msg.includes('another unit'))).toEqual([]);
  });

  it('every other failure is an outage: 403 (logged at error), 5xx, 429, a network error, a 2xx that is not the hub’s answer, no token', async () => {
    const cases: Array<[string, Script]> = [
      ['403', () => new Response('{}', { status: 403 })],
      ['500', () => new Response('{}', { status: 500 })],
      ['429', () => new Response('{}', { status: 429 })],
      [
        'network',
        () => {
          throw new TypeError('fetch failed');
        }
      ],
      ['2xx', () => Response.json({ hello: 'world' })]
    ];
    for (const [name, script] of cases) {
      const h = hub(script);
      expect(await h.check.check(h.req(1)), name).toMatchObject({ allowed: true, source: 'fail_open' });
      expect(await h.gauge('posture'), name).toBe(1);
      if (name === '403') expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('403'))).toBe(true);
    }
    const noToken = hub((r) => Response.json(answer(r)), { tokenDown: () => true });
    expect(await noToken.check.check(noToken.req(1))).toMatchObject({ source: 'fail_open' });
    expect(noToken.check.hubCalls).toBe(0);
  });
});

describe('HubCreditCheck: what the verifier found (round 1)', () => {
  it('a denial is reused for the SAME quantity too: an identical retry costs no hub call', async () => {
    const h = hub((r) => Response.json(answer(r, { allowed: false, reason: 'insufficient_credits' })));
    expect(await h.check.check(h.req(100))).toMatchObject({ allowed: false, source: 'hub' });
    expect(await h.check.check(h.req(100))).toMatchObject({ allowed: false, source: 'cache' });
    expect(h.check.hubCalls).toBe(1);
  });

  it('a hub that ANSWERS 400 or unknown_account after a blip ends the outage: the clock clears, the next blip fails open again', async () => {
    let mode: 'down' | 'bad' | 'unknown' | 'ok' = 'down';
    const h = hub((r) => {
      if (mode === 'bad') return Response.json({ error: { code: 'validation_error' } }, { status: 400 });
      if (mode === 'unknown') return Response.json({ error: { code: 'unknown_account' } }, { status: 404 });
      if (mode === 'ok') return Response.json(answer(r));
      return new Response('{}', { status: 503 });
    });
    expect(await h.check.check(h.req(1))).toMatchObject({ source: 'fail_open' });
    expect(await h.gauge('posture')).toBe(1);
    mode = 'bad';
    expect(await h.check.check(h.req(2))).toMatchObject({ source: 'malformed' });
    expect(await h.gauge('posture')).toBe(0);
    expect(await h.gauge('failingSince')).toBe(0);
    // Fifteen minutes of 400s later, one blip is a NEW outage: open, not closed.
    h.clock.now += 16 * 60_000;
    mode = 'down';
    expect(await h.check.check(h.req(3))).toMatchObject({ allowed: true, source: 'fail_open' });
    expect(await h.gauge('posture')).toBe(1);
    mode = 'unknown';
    expect(await h.check.check(h.req(4))).toMatchObject({ source: 'unknown_account' });
    expect(await h.gauge('posture')).toBe(0);
    h.clock.now += 16 * 60_000;
    mode = 'down';
    expect(await h.check.check(h.req(5))).toMatchObject({ allowed: true, source: 'fail_open' });
    expect(h.logs.filter((l) => l.level === 'error' && l.msg.includes('hub_unavailable'))).toHaveLength(0);
  });
});

describe('HubCreditCheck: the outage posture', () => {
  it('fails open for fifteen minutes from the first failure, then closes; a success clears it', async () => {
    let down = false;
    const h = hub((r) => (down ? new Response('{}', { status: 503 }) : Response.json(answer(r))));
    expect(await h.check.check(h.req(10))).toMatchObject({ source: 'hub' });
    expect(await h.gauge('posture')).toBe(0);
    down = true;
    // A fresh cached answer serves through the outage without asking.
    expect(await h.check.check(h.req(5))).toMatchObject({ source: 'cache' });
    expect(h.check.hubCalls).toBe(1);
    const firstFailure = h.clock.now;
    expect(await h.check.check(h.req(50))).toEqual({ allowed: true, source: 'fail_open', check: null });
    expect(await h.gauge('posture')).toBe(1);
    expect(await h.gauge('failingSince')).toBe(Math.floor(firstFailure / 1000));
    expect(h.logs.filter((l) => l.level === 'warn' && l.msg.includes('failing open'))).toHaveLength(1);
    h.clock.now += 5 * 60_000;
    expect(await h.check.check(h.req(60))).toMatchObject({ source: 'fail_open' });
    expect(h.logs.filter((l) => l.level === 'warn' && l.msg.includes('failing open'))).toHaveLength(1);
    expect(await h.gauge('failingSince')).toBe(Math.floor(firstFailure / 1000));
    h.clock.now = firstFailure + 15 * 60_000;
    expect(await h.check.check(h.req(70))).toMatchObject({ source: 'fail_open' });
    h.clock.now += 1;
    expect(await h.check.check(h.req(80))).toEqual({
      allowed: false,
      reason: 'hub_unavailable',
      source: 'closed',
      check: null
    });
    expect(await h.gauge('posture')).toBe(2);
    await h.check.check(h.req(90));
    expect(h.logs.filter((l) => l.level === 'error' && l.msg.includes('hub_unavailable'))).toHaveLength(1);
    down = false;
    expect(await h.check.check(h.req(100))).toMatchObject({ allowed: true, source: 'hub' });
    expect(await h.gauge('posture')).toBe(0);
    expect(await h.gauge('failingSince')).toBe(0);
    // A new outage starts a new clock, and warns again.
    down = true;
    expect(await h.check.check(h.req(1_000))).toMatchObject({ source: 'fail_open' });
    expect(await h.gauge('failingSince')).toBe(Math.floor(h.clock.now / 1000));
    expect(h.logs.filter((l) => l.level === 'warn' && l.msg.includes('failing open'))).toHaveLength(2);
  });

  it('after a failed call the hub is left alone for the hold: the outage’s verdict at once, one probe per window', async () => {
    let down = true;
    const h = hub((r) => (down ? new Response('{}', { status: 503 }) : Response.json(answer(r))), {
      dials: { outageHoldMs: 5_000 }
    });
    expect(await h.check.check(h.req(1))).toMatchObject({ source: 'fail_open' });
    expect(h.check.hubCalls).toBe(1);
    // Inside the hold: fails open without a call, even for another account and action.
    h.clock.now += 1_000;
    expect(
      await h.check.check(h.req(2, 'other.action', '77777777-aaaa-4bbb-8ccc-000000000002'))
    ).toMatchObject({
      source: 'fail_open'
    });
    expect(h.check.hubCalls).toBe(1);
    // The hold over: the hub is probed again, and a failure re-arms the hold from now.
    h.clock.now += 4_001;
    expect(await h.check.check(h.req(3))).toMatchObject({ source: 'fail_open' });
    expect(h.check.hubCalls).toBe(2);
    h.clock.now += 4_999;
    expect(await h.check.check(h.req(4))).toMatchObject({ source: 'fail_open' });
    expect(h.check.hubCalls).toBe(2);
    // A hold never extends itself: a held request does not push the window.
    h.clock.now += 2;
    down = false;
    expect(await h.check.check(h.req(5))).toMatchObject({ allowed: true, source: 'hub' });
    expect(h.check.hubCalls).toBe(3);
    expect(await h.gauge('posture')).toBe(0);
    // Past the fail-open window the held verdict is closed, still without a call.
    down = true;
    h.clock.now += 60_000;
    expect(await h.check.check(h.req(6))).toMatchObject({ source: 'fail_open' });
    expect(h.check.hubCalls).toBe(4);
    h.clock.now += 15 * 60_000 + 1;
    expect(await h.check.check(h.req(7))).toMatchObject({ reason: 'hub_unavailable', source: 'closed' });
    expect(h.check.hubCalls).toBe(5);
    h.clock.now += 1_000;
    expect(await h.check.check(h.req(8))).toMatchObject({ reason: 'hub_unavailable', source: 'closed' });
    expect(h.check.hubCalls).toBe(5);
  });

  it('counts every outcome as named', async () => {
    let mode: 'allow' | 'deny' | 'suspend' | 'down' | 'unknown' | 'bad' = 'allow';
    const h = hub((r) => {
      if (mode === 'allow') return Response.json(answer(r));
      if (mode === 'deny')
        return Response.json(answer(r, { allowed: false, reason: 'insufficient_credits' }));
      if (mode === 'suspend')
        return Response.json(answer(r, { allowed: false, reason: 'account_suspended' }));
      if (mode === 'unknown') return Response.json({ error: { code: 'unknown_account' } }, { status: 404 });
      if (mode === 'bad') return Response.json({ error: { code: 'validation_error' } }, { status: 400 });
      return new Response('{}', { status: 500 });
    });
    await h.check.check(h.req(10)); // allowed
    await h.check.check(h.req(5)); // cached_allowed
    mode = 'deny';
    await h.check.check(h.req(20, 'deny.me')); // denied
    await h.check.check(h.req(30, 'deny.me')); // cached_denied
    mode = 'suspend';
    await h.check.check(h.req(1, 'suspend.me')); // suspended
    mode = 'unknown';
    await h.check.check(h.req(1, 'unknown.me')); // unknown_account
    mode = 'bad';
    await h.check.check(h.req(1, 'bad.me')); // malformed
    mode = 'down';
    await h.check.check(h.req(1, 'down.me')); // fail_open
    h.clock.now += 15 * 60_000 + 1;
    await h.check.check(h.req(1, 'down.too')); // closed
    for (const name of [
      'allowed',
      'cached_allowed',
      'denied',
      'cached_denied',
      'suspended',
      'unknown_account',
      'malformed',
      'fail_open',
      'closed'
    ]) {
      expect(await h.outcome(name), name).toBe(1);
    }
    expect(h.check.promMetrics.map((m) => (m as unknown as { name: string }).name)).toEqual([
      'usage_check_total',
      'usage_check_posture',
      'usage_check_failing_since_seconds',
      'usage_check_cache_entries'
    ]);
  });
});

describe('HubCreditCheck: one error line per outage and per action key (the code review)', () => {
  it('three 403s in one outage write one error line; a hub that answers again and then refuses writes a second', async () => {
    let status = 403;
    const h = hub((r) => (status === 200 ? Response.json(answer(r)) : new Response('{}', { status })));
    const refusals = () =>
      h.logs.filter((l) => l.level === 'error' && l.msg.includes('refuses this client')).length;
    for (const q of [1, 2, 3]) {
      expect(await h.check.check(h.req(q))).toMatchObject({ allowed: true, source: 'fail_open' });
    }
    expect(h.check.hubCalls).toBe(3);
    expect(refusals()).toBe(1);
    // The hub answers once: the outage is over, the flag is reset.
    status = 200;
    expect(await h.check.check(h.req(4))).toMatchObject({ allowed: true, source: 'hub' });
    // A larger quantity than the cached answer, so the hub is asked again.
    status = 403;
    expect(await h.check.check(h.req(5))).toMatchObject({ source: 'fail_open' });
    expect(h.check.hubCalls).toBe(5);
    expect(refusals()).toBe(2);
  });

  it('two 400s on one action key write one error line; a second key writes its own', async () => {
    const h = hub(() => Response.json({ error: { code: 'validation_error' } }, { status: 400 }));
    const malformed = () => h.logs.filter((l) => l.level === 'error' && l.msg.includes('malformed')).length;
    expect(await h.check.check(h.req(1, 'files.upload'))).toMatchObject({ source: 'malformed' });
    expect(await h.check.check(h.req(2, 'files.upload'))).toMatchObject({ source: 'malformed' });
    expect(h.check.hubCalls).toBe(2);
    expect(malformed()).toBe(1);
    expect(await h.check.check(h.req(1, 'things.make'))).toMatchObject({ source: 'malformed' });
    expect(h.check.hubCalls).toBe(3);
    expect(malformed()).toBe(2);
  });
});
