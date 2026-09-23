import { describe, expect, it } from 'vitest';
import type { UsageEvent } from '@antasphere/chassis-contract';
import { HubMachineToken, HubUsagePoster } from '@antasphere/chassis-server';
import { DEFAULT_FAILURE_HOLD_MS, DEFAULT_INVALID_CLIENT_HOLD_MS } from '../../src/entitlements/index.js';
import { DEFAULT_USAGE_RETRY, PgBossUsageSink } from '../../src/jobs/index.js';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * The cloud edition's usage downstream against a scripted hub (the billing
 * rail spec, §6): the machine token is minted once and shared, a dead token
 * is minted again exactly once, an outage (404, 5xx, network, 403) fails the
 * batch back to the queue, a malformed batch (400) and a rejected event are
 * dropped with an error log, a 2xx that is not the hub's answer is an outage
 * (PRDCT-2629), every outcome is counted (PRDCT-2635), the hub's per-event
 * answer is read, and a configuration-error mint is held minutes, a
 * transient one seconds (PRDCT-2637).
 */

const logs: Array<{ level: string; msg: string; ctx?: unknown }> = [];
const logger = {
  error: (ctx: unknown, msg?: string) => logs.push({ level: 'error', msg: msg ?? String(ctx), ctx }),
  warn: (ctx: unknown, msg?: string) => logs.push({ level: 'warn', msg: msg ?? String(ctx), ctx }),
  info: () => {},
  debug: () => {}
} as unknown as Logger;

const ISSUER = 'https://hub.test';

function event(id: string, occurredAt: Date = new Date()): UsageEvent {
  return {
    id,
    meter: 'things.make',
    actionKey: 'things.make',
    quantity: 1,
    unit: 'call',
    occurredAt: occurredAt.toISOString(),
    workspaceId: 'ws-1',
    accountRef: 'acct-1',
    userId: 'user-1',
    via: 'api_key',
    source: { instanceId: 'inst', edition: 'cloud', version: 'test' }
  };
}

type Script = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A hub as a script: the token endpoint always mints; the events endpoint answers per the script. */
function hub(script: Script, now?: () => number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let mints = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith('/api/v1/auth/oauth2/token')) {
      mints += 1;
      expect(init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /) });
      expect(String(init?.body)).toContain('grant_type=client_credentials');
      expect(String(init?.body)).toContain('scope=usage%3Awrite');
      expect(String(init?.body)).toContain(`resource=${encodeURIComponent(`${ISSUER}/mcp`)}`);
      return Response.json({ access_token: `mach_${mints}`, token_type: 'Bearer', expires_in: 3600 });
    }
    return script(url, init ?? {});
  }) as typeof fetch;
  const token = new HubMachineToken({
    issuerUrl: ISSUER,
    clientId: 'tool-things',
    clientSecret: 's'.repeat(20),
    resource: `${ISSUER}/mcp`,
    logger,
    fetchImpl
  });
  const poster = new HubUsagePoster({ issuerUrl: ISSUER, token, logger, fetchImpl, now });
  return {
    poster,
    token,
    calls,
    mints: () => mints,
    posts: () => calls.filter((c) => c.url.endsWith('/usage/events'))
  };
}

const accepted = (ids: string[]) => Response.json({ results: ids.map((id) => ({ id, status: 'accepted' })) });

/** A prom-client counter's values by its `outcome` label, zero rows omitted. */
async function counts(counter: {
  get(): Promise<{ values: Array<{ labels: Record<string, unknown>; value: number }> }>;
}) {
  const out: Record<string, number> = {};
  for (const v of (await counter.get()).values) if (v.value > 0) out[String(v.labels.outcome)] = v.value;
  return out;
}

describe('HubUsagePoster', () => {
  it('posts the batch whole with the machine token, and two batches share one mint', async () => {
    const h = hub((_url, init) => {
      const body = JSON.parse(String(init.body)) as { events: UsageEvent[] };
      return accepted(body.events.map((e) => e.id));
    });
    await Promise.all([h.poster.emitBatch([event('a'), event('b')]), h.poster.emitBatch([event('c')])]);
    expect(h.mints()).toBe(1);
    const posts = h.posts();
    expect(posts).toHaveLength(2);
    expect(posts[0]!.init.headers).toMatchObject({ authorization: 'Bearer mach_1' });
    const bodies = posts.map((p) =>
      (JSON.parse(String(p.init.body)) as { events: UsageEvent[] }).events.map((e) => e.id)
    );
    expect(bodies.flat().sort()).toEqual(['a', 'b', 'c']);
  });

  it('a 401 invalidates the token and re-mints exactly once', async () => {
    let first = true;
    const h = hub((_url, init) => {
      if (first) {
        first = false;
        return Response.json({ error: { code: 'invalid_token' } }, { status: 401 });
      }
      const body = JSON.parse(String(init.body)) as { events: UsageEvent[] };
      return accepted(body.events.map((e) => e.id));
    });
    await h.poster.emitBatch([event('a')]);
    expect(h.mints()).toBe(2);
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1]!.init.headers).toMatchObject({ authorization: 'Bearer mach_2' });
  });

  it('a second 401 in a row is an outage, not a mint loop', async () => {
    const h = hub(() => Response.json({ error: { code: 'invalid_token' } }, { status: 401 }));
    await expect(h.poster.emitBatch([event('a')])).rejects.toThrow(/401/);
    expect(h.mints()).toBe(2);
  });

  it.each([404, 408, 429, 500, 503])('a %s fails the batch back to the queue', async (status) => {
    const h = hub(() => Response.json({ error: { code: 'x' } }, { status }));
    await expect(h.poster.emitBatch([event('a')])).rejects.toThrow(String(status));
  });

  it('an unreachable hub fails the batch back to the queue', async () => {
    const h = hub(() => {
      throw new TypeError('fetch failed');
    });
    await expect(h.poster.emitBatch([event('a')])).rejects.toThrow(/unreachable/);
  });

  it('a 403 is an outage the operator must see, never a drop', async () => {
    logs.length = 0;
    const h = hub(() => Response.json({ error: { code: 'insufficient_scope' } }, { status: 403 }));
    await expect(h.poster.emitBatch([event('a')])).rejects.toThrow(/403/);
    expect(logs.some((l) => l.level === 'error' && /usage:write/.test(l.msg))).toBe(true);
  });

  it('a 400 drops the batch with an error naming the ids (a retry could never heal it)', async () => {
    logs.length = 0;
    const h = hub(() => Response.json({ error: { code: 'validation_error' } }, { status: 400 }));
    await expect(h.poster.emitBatch([event('a'), event('b')])).resolves.toEqual({ held: [] });
    const dropped = logs.find((l) => l.level === 'error' && /malformed/.test(l.msg));
    expect(dropped?.ctx).toMatchObject({ ids: ['a', 'b'] });
  });

  it('reads the per-event answer: duplicates are fine, a rejection is logged and dropped', async () => {
    logs.length = 0;
    const h = hub(() =>
      Response.json({
        results: [
          { id: 'a', status: 'duplicate' },
          { id: 'b', status: 'rejected', reason: 'unknown_account' },
          { id: null, status: 'rejected', reason: 'invalid_event', details: [{ path: 'occurredAt' }] }
        ],
        accepted: 0,
        duplicate: 1,
        rejected: 2
      })
    );
    await expect(h.poster.emitBatch([event('a'), event('b'), event('c')])).resolves.toEqual({ held: [] });
    const rejected = logs.filter((l) => l.level === 'error' && /rejected/.test(l.msg));
    expect(rejected.map((l) => l.ctx)).toEqual([
      expect.objectContaining({ id: 'b', reason: 'unknown_account' }),
      expect.objectContaining({ id: null, reason: 'invalid_event' })
    ]);
    // Every outcome is counted where an operator can see it (PRDCT-2635).
    expect(await counts(h.poster.events)).toEqual({ duplicate: 1, rejected: 2 });
    expect(await counts(h.poster.batches)).toEqual({ delivered: 1 });
  });

  it('a 2xx that is not the hub’s answer is an outage the queue retries, never a delivery (PRDCT-2629)', async () => {
    logs.length = 0;
    const h = hub(() => new Response('<html>a proxy page</html>', { status: 200 }));
    await expect(h.poster.emitBatch([event('a')])).rejects.toThrow(/readable results/);
    expect(logs.some((l) => l.level === 'warn' && /retried/.test(l.msg))).toBe(true);
    expect(await counts(h.poster.batches)).toEqual({ retried: 1 });
    expect(await counts(h.poster.events)).toEqual({});
  });

  it('a hub answer with fewer results than events posted is an outage too, never a partial delivery', async () => {
    const h = hub(() => accepted(['a']));
    await expect(h.poster.emitBatch([event('a'), event('b')])).rejects.toThrow(/different number/);
    expect(await counts(h.poster.batches)).toEqual({ retried: 1 });
    expect(await counts(h.poster.events)).toEqual({});
  });

  it('counts a dropped batch per event and a retried outage per batch', async () => {
    const dropped = hub(() => Response.json({ error: { code: 'validation_error' } }, { status: 400 }));
    await dropped.poster.emitBatch([event('a'), event('b'), event('c')]);
    expect(await counts(dropped.poster.events)).toEqual({ dropped: 3 });
    expect(await counts(dropped.poster.batches)).toEqual({ dropped: 1 });
    const outage = hub(() => Response.json({ error: { code: 'internal' } }, { status: 503 }));
    await expect(outage.poster.emitBatch([event('a')])).rejects.toThrow(/503/);
    expect(await counts(outage.poster.batches)).toEqual({ retried: 1 });
  });

  it.each(['invalid_client', 'unauthorized_client', 'invalid_scope', 'invalid_target'])(
    'a mint the hub refuses as %s is an outage with an error log, never a loop',
    async (error) => {
      logs.length = 0;
      const fetchImpl = (async () => Response.json({ error }, { status: 400 })) as unknown as typeof fetch;
      const token = new HubMachineToken({
        issuerUrl: ISSUER,
        clientId: 'tool-things',
        clientSecret: 's'.repeat(20),
        resource: `${ISSUER}/mcp`,
        logger,
        fetchImpl
      });
      const poster = new HubUsagePoster({ issuerUrl: ISSUER, token, logger, fetchImpl });
      await expect(poster.emitBatch([event('a')])).rejects.toThrow(/no machine token/);
      expect(logs.some((l) => l.level === 'error' && /HUB_CLIENT_ID/.test(l.msg))).toBe(true);
    }
  );

  it('an empty batch touches nothing', async () => {
    const h = hub(() => {
      throw new Error('never');
    });
    await h.poster.emitBatch([]);
    expect(h.calls).toHaveLength(0);
  });
});

describe('HubUsagePoster, the hub’s occurredAt window (PRDCT-2644)', () => {
  const NOW = Date.parse('2026-09-23T12:00:00.000Z');
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const at = (offsetMs: number) => new Date(NOW + offsetMs);
  const echo: Script = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { events: UsageEvent[] };
    return accepted(body.events.map((e) => e.id));
  };
  const postedIds = (h: ReturnType<typeof hub>) =>
    h
      .posts()
      .flatMap((p) => (JSON.parse(String(p.init.body)) as { events: UsageEvent[] }).events.map((e) => e.id));

  it('an event eight days old is held, never posted: no fetch at all, named in the outcome, counted as held', async () => {
    logs.length = 0;
    const h = hub(echo, () => NOW);
    const outcome = await h.poster.emitBatch([event('stale', at(-8 * DAY))]);
    expect(outcome).toEqual({ held: [{ id: 'stale', reason: 'occurred_at_window' }] });
    expect(h.calls).toHaveLength(0); // neither a mint nor a post
    expect(await counts(h.poster.events)).toEqual({ held: 1 });
    expect(await counts(h.poster.batches)).toEqual({});
    const warn = logs.find((l) => l.level === 'warn' && /window/.test(l.msg));
    expect(warn?.ctx).toMatchObject({
      id: 'stale',
      occurredAt: at(-8 * DAY).toISOString(),
      issue: 'more than 7 days before the hub received the event'
    });
  });

  it('an event four minutes ahead is posted; one six minutes ahead is held', async () => {
    const h = hub(echo, () => NOW);
    expect(await h.poster.emitBatch([event('soon', at(4 * MIN))])).toEqual({ held: [] });
    expect(postedIds(h)).toEqual(['soon']);
    logs.length = 0;
    expect(await h.poster.emitBatch([event('future', at(6 * MIN))])).toEqual({
      held: [{ id: 'future', reason: 'occurred_at_window' }]
    });
    expect(postedIds(h)).toEqual(['soon']);
    expect(logs.find((l) => l.level === 'warn' && /window/.test(l.msg))?.ctx).toMatchObject({
      issue: 'more than 5 minutes after the hub received the event'
    });
    expect(await counts(h.poster.events)).toEqual({ accepted: 1, held: 1 });
  });

  it('both bounds are inclusive: exactly seven days before and exactly five minutes after are posted', async () => {
    const h = hub(echo, () => NOW);
    await h.poster.emitBatch([event('edge-past', at(-7 * DAY)), event('edge-future', at(5 * MIN))]);
    expect(postedIds(h)).toEqual(['edge-past', 'edge-future']);
  });

  it('a mixed batch posts only the in-window events, in order, and holds the rest', async () => {
    const h = hub(echo, () => NOW);
    const outcome = await h.poster.emitBatch([
      event('a', at(-1 * DAY)),
      event('old', at(-8 * DAY)),
      event('b', at(0)),
      event('ahead', at(10 * MIN))
    ]);
    expect(postedIds(h)).toEqual(['a', 'b']);
    expect(outcome).toEqual({
      held: [
        { id: 'old', reason: 'occurred_at_window' },
        { id: 'ahead', reason: 'occurred_at_window' }
      ]
    });
    expect(await counts(h.poster.events)).toEqual({ accepted: 2, held: 2 });
    expect(await counts(h.poster.batches)).toEqual({ delivered: 1 });
  });

  it('a batch of only stale events makes no POST and answers the outcome', async () => {
    const h = hub(
      () => {
        throw new Error('never posted');
      },
      () => NOW
    );
    const outcome = await h.poster.emitBatch([event('x', at(-30 * DAY)), event('y', at(-8 * DAY))]);
    expect(outcome.held.map((e) => e.id)).toEqual(['x', 'y']);
    expect(h.posts()).toHaveLength(0);
    expect(h.poster.posts).toBe(0);
  });

  it('a held event is not counted when the rest of its batch meets an outage (the queue’s retry judges it again)', async () => {
    const h = hub(
      () => Response.json({ error: { code: 'internal' } }, { status: 503 }),
      () => NOW
    );
    await expect(h.poster.emitBatch([event('ok', at(0)), event('old', at(-8 * DAY))])).rejects.toThrow(/503/);
    expect(await counts(h.poster.events)).toEqual({});
    expect(postedIds(h)).toEqual(['ok']);
  });
});

describe('HubMachineToken', () => {
  it('refreshes before expiry, single-flight', async () => {
    let now = 1_000_000;
    let mints = 0;
    const fetchImpl = (async () => {
      mints += 1;
      return Response.json({ access_token: `mach_${mints}`, expires_in: 100 });
    }) as unknown as typeof fetch;
    const token = new HubMachineToken({
      issuerUrl: ISSUER,
      clientId: 'tool-things',
      clientSecret: 's'.repeat(20),
      resource: `${ISSUER}/mcp`,
      logger,
      fetchImpl,
      now: () => now,
      refreshSkewMs: 20_000
    });
    expect(await Promise.all([token.get(), token.get(), token.get()])).toEqual([
      'mach_1',
      'mach_1',
      'mach_1'
    ]);
    expect(mints).toBe(1);
    now += 85_000; // 15 s left: inside the skew, so the next get mints
    expect(await token.get()).toBe('mach_2');
    expect(mints).toBe(2);
    token.invalidate();
    expect(await token.get()).toBe('mach_3');
  });

  it('holds a failed mint for the negative-cache window, then asks again; invalidate clears the hold', async () => {
    let now = 1_000_000;
    let attempts = 0;
    let mode: 'down' | 'ok' = 'down';
    const fetchImpl = (async () => {
      attempts += 1;
      if (mode === 'down') throw new TypeError('fetch failed');
      return Response.json({ access_token: `mach_${attempts}`, expires_in: 900 });
    }) as unknown as typeof fetch;
    const token = new HubMachineToken({
      issuerUrl: ISSUER,
      clientId: 'tool-things',
      clientSecret: 's'.repeat(20),
      resource: `${ISSUER}/mcp`,
      logger,
      fetchImpl,
      now: () => now,
      failureHoldMs: 5_000
    });
    await expect(token.get()).rejects.toThrow(/unreachable/);
    await expect(token.get()).rejects.toThrow(/unreachable/);
    expect(attempts).toBe(1); // the second get did not ask the hub
    now += 5_001;
    await expect(token.get()).rejects.toThrow(/unreachable/);
    expect(attempts).toBe(2);
    token.invalidate();
    mode = 'ok';
    expect(await token.get()).toBe('mach_3');
  });
});

describe('HubMachineToken, the two holds (PRDCT-2637)', () => {
  it('a mint the hub refuses as a configuration error is held five minutes, a transient failure five seconds', async () => {
    let now = 1_000_000;
    let attempts = 0;
    let mode: 'invalid_client' | 'down' | 'ok' = 'invalid_client';
    const fetchImpl = (async () => {
      attempts += 1;
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'invalid_client') return Response.json({ error: 'invalid_client' }, { status: 401 });
      return Response.json({ access_token: `mach_${attempts}`, expires_in: 900 });
    }) as unknown as typeof fetch;
    const token = new HubMachineToken({
      issuerUrl: ISSUER,
      clientId: 'tool-things',
      clientSecret: 's'.repeat(20),
      resource: `${ISSUER}/mcp`,
      logger,
      fetchImpl,
      now: () => now
    });
    expect(DEFAULT_INVALID_CLIENT_HOLD_MS).toBe(5 * 60_000);
    await expect(token.get()).rejects.toThrow(/invalid_client/);
    now += DEFAULT_FAILURE_HOLD_MS + 1; // past the transient hold: still held
    await expect(token.get()).rejects.toThrow(/invalid_client/);
    expect(attempts).toBe(1);
    now += DEFAULT_INVALID_CLIENT_HOLD_MS; // past the configuration hold: asked again
    await expect(token.get()).rejects.toThrow(/invalid_client/);
    expect(attempts).toBe(2);
    // A transient failure keeps its short hold.
    mode = 'down';
    now += DEFAULT_INVALID_CLIENT_HOLD_MS + 1;
    await expect(token.get()).rejects.toThrow(/unreachable/);
    expect(attempts).toBe(3);
    now += DEFAULT_FAILURE_HOLD_MS + 1;
    await expect(token.get()).rejects.toThrow(/unreachable/);
    expect(attempts).toBe(4);
    // invalidate() (a 401 from the hub on a live token) clears either hold.
    mode = 'invalid_client';
    now += DEFAULT_FAILURE_HOLD_MS + 1;
    await expect(token.get()).rejects.toThrow(/invalid_client/);
    token.invalidate();
    mode = 'ok';
    const minted = attempts + 1;
    expect(await token.get()).toBe(`mach_${minted}`);
  });
});

describe('HubMachineToken, the default hold and the skew window', () => {
  it('a token built with no dials holds a failed mint five seconds (the outage posture rests on the default)', async () => {
    let now = 1_000_000;
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const token = new HubMachineToken({
      issuerUrl: ISSUER,
      clientId: 'tool-things',
      clientSecret: 's'.repeat(20),
      resource: `${ISSUER}/mcp`,
      logger,
      fetchImpl,
      now: () => now
    });
    expect(DEFAULT_FAILURE_HOLD_MS).toBe(5_000);
    await expect(token.get()).rejects.toThrow();
    now += 4_999;
    await expect(token.get()).rejects.toThrow();
    expect(attempts).toBe(1);
    now += 2;
    await expect(token.get()).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it('a refresh that fails inside the skew window serves the cached token while it is still live at the hub', async () => {
    let now = 1_000_000;
    let mode: 'ok' | 'down' = 'ok';
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (mode === 'down') throw new TypeError('fetch failed');
      return Response.json({ access_token: `mach_${attempts}`, expires_in: 900 });
    }) as unknown as typeof fetch;
    const token = new HubMachineToken({
      issuerUrl: ISSUER,
      clientId: 'tool-things',
      clientSecret: 's'.repeat(20),
      resource: `${ISSUER}/mcp`,
      logger,
      fetchImpl,
      now: () => now
    });
    expect(await token.get()).toBe('mach_1');
    mode = 'down';
    now += 850_000; // 50 s of validity left, inside the 60 s skew: a refresh is tried and fails
    expect(await token.get()).toBe('mach_1');
    expect(attempts).toBe(2);
    now += 1_000; // inside the hold: no attempt, the live token is served
    expect(await token.get()).toBe('mach_1');
    expect(attempts).toBe(2);
    now += 60_000; // expired: the failure is what there is
    await expect(token.get()).rejects.toThrow(/unreachable/);
    mode = 'ok';
    now += 5_001;
    const next = attempts + 1;
    expect(await token.get()).toBe(`mach_${next}`);
  });
});

describe('PgBossUsageSink', () => {
  it('sends with the ULID as singleton key and the default retry budget of ten retries from thirty seconds, backing off', async () => {
    const sends: Array<{ queue: string; data: unknown; options: Record<string, unknown> }> = [];
    const boss = {
      send: async (queue: string, data: unknown, options: Record<string, unknown>) => {
        sends.push({ queue, data, options });
        return 'job-1';
      }
    };
    const sink = new PgBossUsageSink(boss as never, logger);
    const e = event('01JZZZZZZZZZZZZZZZZZZZZZZ9');
    await sink.emit(e);
    expect(DEFAULT_USAGE_RETRY).toEqual({ limit: 10, delaySeconds: 30, heldDelaySeconds: 3600 });
    expect(sends).toEqual([
      {
        queue: 'usage-events',
        data: e,
        // The budget's end is a hold (the QUEUE's dead letter, set at install,
        // never named on a send), never a drop (PRDCT-2635).
        options: { singletonKey: e.id, retryLimit: 10, retryDelay: 30, retryBackoff: true }
      }
    ]);
    // A shrunk budget (a test seam) is passed through as given.
    const fast = new PgBossUsageSink(boss as never, logger, {
      limit: 2,
      delaySeconds: 1,
      heldDelaySeconds: 1
    });
    await fast.emit(e);
    expect(sends[1]!.options).toMatchObject({ retryLimit: 2, retryDelay: 1 });
    expect(sends[1]!.options).not.toHaveProperty('deadLetter');
  });
});
