import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@antasphere/chassis-contract';
import { SiblingConnector, siblingKeyTtlSeconds } from '../../src/connections/sibling.js';
import {
  SiblingCalls,
  asksConnectScope,
  buildSiblingDeclarations,
  type SiblingHandle
} from '../../src/connections/sibling-call.js';
import {
  personOfRequest,
  runAsPerson,
  runWithoutPerson,
  type PersonOfRequest
} from '../../src/middleware/person-scope.js';
import type { GrantAccess } from '../../src/identity/hub-grant.js';
import type { FleetTool } from '../../src/webhooks/fleet-origins.js';

/**
 * The sibling call on its own (PRDCT-4393), the hub and the sibling played
 * by an injected fetch: an undeclared sibling is refused before anything is
 * read, a local instance and a call outside a request answer, the person is
 * the request's and never an argument, the key minted on the sibling is
 * revoked on every path (an answer, a refusal, a 5xx, no answer, the
 * budget, a thrown work), the handle cannot outlive the call, and no token,
 * key or query string is ever logged.
 */

const TWIN: FleetTool = {
  slug: 'twin',
  clientId: 'tool-twin',
  name: 'Twin',
  origin: 'https://twin.example.com',
  resourceUrl: 'https://twin.example.com/mcp'
};
const TOKEN = 'hub-access-token-call-0001';
const CONNECT = 'connect-jwt-call-0001';
const KEY = 'tk_callkey_secretsecretsecret';
const ORG = 'org-hub-1';
const PERSON: PersonOfRequest = { userId: 'user-1', workspaceId: 'ws-here-1', via: 'session' };

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Reply = { status: number; body?: unknown; raw?: string; delayMs?: number } | 'network';

function makeLogger() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => {
    lines.push(JSON.stringify(a, (_k, v: unknown) => (v instanceof Error ? String(v) : v)));
  };
  return { lines, logger: { info: push, warn: push, error: push, debug: push } };
}

const happyScript = (): Record<string, Reply[]> => ({
  'POST /api/v1/sso/connect-token': [{ status: 200, body: { token: CONNECT } }],
  'POST /api/v1/sso/cli-connect': [{ status: 201, body: { key: KEY } }],
  'GET /api/v1/me': [
    {
      status: 200,
      body: {
        workspaces: [
          { id: 'ws-twin-other', centralAccountId: 'org-other' },
          { id: 'ws-twin-local', centralAccountId: null },
          { id: 'ws-twin-1', centralAccountId: ORG }
        ]
      }
    }
  ],
  'DELETE /api/v1/cli/auth/key': [{ status: 200, body: { ok: true } }]
});

function harness(
  script: Record<string, Reply[]>,
  opts: {
    declared?: string[];
    person?: PersonOfRequest | null;
    onHub?: boolean;
    fleetRead?: boolean;
    access?: GrantAccess;
    central?: string | null | Error;
    overallMs?: number;
  } = {}
) {
  const calls: Call[] = [];
  /** Every request as it starts, and every request cut while in flight, in order. */
  const events: string[] = [];
  const grantCalls: string[] = [];
  const centralReads: string[] = [];
  const { lines, logger } = makeLogger();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    events.push(`call ${call.method} ${url.pathname}`);
    expect(init?.redirect).toBe('error');
    const key = `${call.method} ${url.pathname}`;
    const entry = script[key];
    if (!entry) throw new Error(`unscripted call ${key}`);
    const reply = entry.shift() ?? { status: 500 };
    if (reply === 'network') throw new TypeError('fetch failed');
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        init?.signal?.addEventListener('abort', () => {
          events.push(`abort ${call.method} ${url.pathname}`);
          clearTimeout(t);
          reject(new DOMException('The operation was aborted', 'TimeoutError'));
        });
      });
    }
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const connector = new SiblingConnector({
    grant: {
      accessToken: async (userId: string) => {
        grantCalls.push(`accessToken:${userId}`);
        return opts.access ?? ({ kind: 'ok', accessToken: TOKEN } as GrantAccess);
      },
      invalidateAccess: (userId: string) => {
        grantCalls.push(`invalidateAccess:${userId}`);
      },
      refresh: async (userId: string) => {
        grantCalls.push(`refresh:${userId}`);
        return { kind: 'ok', accessToken: `${TOKEN}-fresh` } as GrantAccess;
      }
    },
    issuerUrl: 'https://hub.example/',
    fleet: {
      tool: (slug) => (slug === 'twin' || slug === 'other' ? { ...TWIN, slug } : null),
      fetchedAt: opts.fleetRead === false ? null : new Date()
    },
    logger: logger as never,
    fetchImpl,
    timeoutMs: 1000,
    overallMs: opts.overallMs
  });
  const calls$ = new SiblingCalls({
    declared: (opts.declared ?? ['twin']).map((toolSlug) => ({ toolSlug })),
    connector: opts.onHub === false ? null : connector,
    centralAccountOf: async (workspaceId) => {
      centralReads.push(workspaceId);
      if (opts.central instanceof Error) throw opts.central;
      return opts.central === undefined ? ORG : opts.central;
    },
    logger: logger as never,
    person: () => (opts.person === undefined ? PERSON : opts.person)
  });
  const revoked = () => calls.filter((c) => c.method === 'DELETE' && c.path === '/api/v1/cli/auth/key');
  return { siblings: calls$, calls, events, grantCalls, centralReads, lines, revoked };
}

const err = (code: string, message = code) => ({ error: { code, message } });

/** Nothing secret in the log lines: no hub token, no connect token, no key, no query string. */
function expectNothingSecret(lines: string[], ...more: string[]) {
  const text = lines.join('\n');
  for (const secret of [TOKEN, CONNECT, KEY, 'secretsecret', ...more]) expect(text).not.toContain(secret);
}

describe('the sibling call · before any conversation', () => {
  it('an undeclared sibling is refused before the hub, the fleet list, the person or the workspace is read', async () => {
    let personRead = 0;
    const h = harness(happyScript(), { declared: ['twin'] });
    const siblings = new SiblingCalls({
      declared: [{ toolSlug: 'twin' }],
      connector: null,
      centralAccountOf: async () => {
        throw new Error('read');
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      person: () => {
        personRead++;
        return PERSON;
      }
    });
    let ran = false;
    const work = async () => {
      ran = true;
      return { kind: 'ok' as const, value: 1 };
    };
    expect(await h.siblings.call('other', work)).toEqual({
      kind: 'sibling_not_declared',
      message: 'This tool declares no sibling named "other"'
    });
    expect(h.calls).toEqual([]);
    expect(h.grantCalls).toEqual([]);
    expect(h.centralReads).toEqual([]);
    expect(ran).toBe(false);
    expect((await siblings.call('other', work)).kind).toBe('sibling_not_declared');
    expect(personRead).toBe(0);
  });

  it('a local instance (no hub) answers not_on_hub, inside a request or outside one, and never throws', async () => {
    const h = harness(happyScript(), { onHub: false });
    const answered = await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }));
    expect(answered).toEqual({
      kind: 'not_on_hub',
      message: 'This instance is not on an Antasphere hub, so it has no sibling tool to act on'
    });
    const outside = harness(happyScript(), { onHub: false, person: null });
    expect((await outside.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).kind).toBe(
      'not_on_hub'
    );
    expect(h.calls).toEqual([]);
  });

  it('outside a person’s request the call answers no_person and asks nothing of anyone', async () => {
    const h = harness(happyScript(), { person: null });
    expect(await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'no_person',
      message: 'A sibling is called as the person of a request, and this code runs outside one'
    });
    expect(h.calls).toEqual([]);
    expect(h.grantCalls).toEqual([]);
  });

  it('a sibling the hub does not list is unknown once the fleet was read, unavailable before', async () => {
    const h = harness(happyScript(), { declared: ['gone'] });
    expect(await h.siblings.call('gone', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'sibling_unknown',
      message: 'The hub lists no tool named "gone" in its fleet'
    });
    const early = harness(happyScript(), { declared: ['gone'], fleetRead: false });
    expect((await early.siblings.call('gone', async () => ({ kind: 'ok', value: 1 }))).kind).toBe(
      'unavailable'
    );
    expect(h.calls).toEqual([]);
  });

  it('a local workspace (no hub organization) has no twin: sibling_workspace_missing before the hub is asked', async () => {
    const h = harness(happyScript(), { central: null });
    expect(await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'sibling_workspace_missing'
    });
    expect(h.centralReads).toEqual([PERSON.workspaceId]);
    expect(h.calls).toEqual([]);
  });

  it('a workspace that cannot be read answers unavailable, never throws', async () => {
    const h = harness(happyScript(), { central: new Error('connection terminated') });
    expect(await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'unavailable',
      message: 'the workspace could not be read'
    });
    expect(h.calls).toEqual([]);
  });
});

describe('the sibling call · as the person', () => {
  it('runs the work as the request’s person in the twin workspace, then revokes the key', async () => {
    const script = happyScript();
    script['POST /api/v1/things'] = [{ status: 201, body: { thing: { id: 'thing-9' } } }];
    const h = harness(script);
    let seen: SiblingHandle | null = null;
    const outcome = await h.siblings.call('twin', async (sibling) => {
      seen = sibling;
      const made = await sibling.request('POST', '/things', { body: { name: 'A link' } });
      if (made.kind !== 'ok') return made;
      return { kind: 'ok', value: made.value };
    });
    expect(outcome).toEqual({ kind: 'ok', value: { status: 201, body: { thing: { id: 'thing-9' } } } });
    // The person of the request, and nobody else, bought the token.
    expect(h.grantCalls).toEqual([`accessToken:${PERSON.userId}`]);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/sso/connect-token',
      'POST /api/v1/sso/cli-connect',
      'GET /api/v1/me',
      'POST /api/v1/things',
      'DELETE /api/v1/cli/auth/key'
    ]);
    expect(h.calls[0]!.body).toEqual({ resource: TWIN.resourceUrl });
    expect(h.calls[1]!.body).toEqual({ token: CONNECT, expiresInSeconds: 300 });
    const thing = h.calls[3]!;
    expect(thing.headers.authorization).toBe(`Bearer ${KEY}`);
    // The workspace whose hub organization is ours, not the first one listed.
    expect(thing.headers['x-workspace-id']).toBe('ws-twin-1');
    expect(thing.body).toEqual({ name: 'A link' });
    expect(h.calls[4]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // The handle shows the sibling and its workspace, never the key.
    expect(seen!.workspaceId).toBe('ws-twin-1');
    expect(seen!.tool).toEqual({ slug: 'twin', name: 'Twin' });
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(Object.values(seen!)).not.toContain(KEY);
    expect(h.lines.some((l) => l.includes('"outcome":"ok"'))).toBe(true);
    expectNothingSecret(h.lines);
  });

  it('the person comes from the request scope, and the scope carries the admitted principal alone', async () => {
    const principal: Principal = {
      userId: 'user-scope',
      email: 'p@example.com',
      name: 'P',
      workspaceId: 'ws-scope',
      role: 'member',
      origin: 'hub',
      via: 'oauth',
      scopes: new Set(['things:write'])
    };
    expect(personOfRequest()).toBeNull();
    const inside = await runAsPerson(principal, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return personOfRequest();
    });
    expect(inside).toEqual({ userId: 'user-scope', workspaceId: 'ws-scope', via: 'oauth' });
    expect(Object.isFrozen(inside)).toBe(true);
    expect(personOfRequest()).toBeNull();

    // The default person reader is the scope: inside it the call is the scope's person.
    const script = happyScript();
    const reads: string[] = [];
    const h = harness(script);
    const siblings = new SiblingCalls({
      declared: [{ toolSlug: 'twin' }],
      connector: (h.siblings as unknown as { deps: { connector: SiblingConnector } }).deps.connector,
      centralAccountOf: async (workspaceId) => {
        reads.push(workspaceId);
        return ORG;
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never
    });
    expect((await siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).kind).toBe('no_person');
    const outcome = await runAsPerson(principal, () =>
      siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))
    );
    expect(outcome).toEqual({ kind: 'ok', value: 1 });
    expect(h.grantCalls).toEqual(['accessToken:user-scope']);
    expect(reads).toEqual(['ws-scope']);
  });

  it('a refusal of the sibling is answered with its status and code, and the key is revoked', async () => {
    const script = happyScript();
    script['POST /api/v1/things'] = [{ status: 409, body: err('slug_taken', 'That link exists already') }];
    const h = harness(script);
    const outcome = await h.siblings.call('twin', async (sibling) => {
      const made = await sibling.request('POST', '/things', { body: {} });
      if (made.kind !== 'ok') return made;
      return { kind: 'ok', value: made.value };
    });
    expect(outcome).toEqual({
      kind: 'sibling_refused',
      message: 'Twin refused: That link exists already',
      status: 409,
      code: 'slug_taken'
    });
    expect(h.revoked()).toHaveLength(1);
    expectNothingSecret(h.lines);
  });

  it('a 5xx, no answer, or an answer that is not JSON is unavailable, and the key is revoked each time', async () => {
    for (const reply of [{ status: 503 }, 'network', { status: 200, raw: '<html>' }] as const) {
      const script = happyScript();
      script['GET /api/v1/things'] = [reply as Reply];
      const h = harness(script);
      const outcome = await h.siblings.call('twin', async (sibling) => sibling.request('GET', '/things'));
      expect(outcome.kind).toBe('unavailable');
      expect(h.revoked()).toHaveLength(1);
      expectNothingSecret(h.lines);
    }
  });

  it('a 204 answers ok with a null body', async () => {
    const script = happyScript();
    script['DELETE /api/v1/things/t1'] = [{ status: 204 }];
    const h = harness(script);
    expect(await h.siblings.call('twin', (sibling) => sibling.request('DELETE', '/things/t1'))).toEqual({
      kind: 'ok',
      value: { status: 204, body: null }
    });
  });

  it('a work that throws has the key revoked first, then its own error rethrown', async () => {
    const h = harness(happyScript());
    const boom = new Error('the work exploded');
    await expect(
      h.siblings.call('twin', async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(h.revoked()).toHaveLength(1);
    // A work that throws before it awaits anything is the same.
    const sync = harness(happyScript());
    await expect(
      sync.siblings.call('twin', (() => {
        throw boom;
      }) as never)
    ).rejects.toBe(boom);
    expect(sync.revoked()).toHaveLength(1);
  });

  it('a work past the overall budget answers unavailable, the key is revoked, and the handle is closed', async () => {
    const script = happyScript();
    script['GET /api/v1/things'] = [{ status: 200, body: { things: [] } }];
    const h = harness(script, { overallMs: 200 });
    let handle: SiblingHandle | null = null;
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    const started = Date.now();
    const outcome = await h.siblings.call('twin', async (sibling) => {
      handle = sibling;
      await parked;
      return { kind: 'ok', value: 'late' };
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toEqual({ kind: 'unavailable', message: 'the call to Twin took too long' });
    expect(h.revoked()).toHaveLength(1);
    release();
    // The work's handle answers nothing once the call is over, and reaches nobody.
    const before = h.calls.length;
    expect(await handle!.request('GET', '/things')).toEqual({
      kind: 'unavailable',
      message: 'the call to Twin is over'
    });
    expect(h.calls.length).toBe(before);
  });

  it('a work that rejects after the deadline is not an unhandled error', async () => {
    const h = harness(happyScript(), { overallMs: 100 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = await h.siblings.call('twin', async () => {
        await new Promise((r) => setTimeout(r, 250));
        throw new Error('too late to matter');
      });
      expect(outcome.kind).toBe('unavailable');
      await new Promise((r) => setTimeout(r, 400));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a slow sibling request is cut at the budget: unavailable, and the key is still revoked', async () => {
    const script = happyScript();
    script['GET /api/v1/things'] = [{ status: 200, body: { things: [] }, delayMs: 5_000 }];
    const h = harness(script, { overallMs: 300 });
    const started = Date.now();
    const outcome = await h.siblings.call('twin', (sibling) => sibling.request('GET', '/things'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.kind).toBe('unavailable');
    expect(h.revoked()).toHaveLength(1);
  });

  it('a handle kept past a successful call answers unavailable and reaches nobody', async () => {
    const h = harness(happyScript());
    let kept: SiblingHandle | null = null;
    await h.siblings.call('twin', async (sibling) => {
      kept = sibling;
      return { kind: 'ok', value: 1 };
    });
    const before = h.calls.length;
    expect((await kept!.request('GET', '/things')).kind).toBe('unavailable');
    expect(h.calls.length).toBe(before);
  });

  it('a query string never reaches a log line', async () => {
    const script = happyScript();
    script['GET /api/v1/things'] = [{ status: 404, body: err('not_found') }];
    const h = harness(script);
    await h.siblings.call('twin', (sibling) => sibling.request('GET', '/things?token=query-secret-123'));
    expect(h.calls.some((c) => c.path === '/api/v1/things?token=query-secret-123')).toBe(true);
    expectNothingSecret(h.lines, 'query-secret-123');
    const net = happyScript();
    net['GET /api/v1/things'] = ['network'];
    const n = harness(net);
    await n.siblings.call('twin', (sibling) => sibling.request('GET', '/things?token=query-secret-456'));
    expectNothingSecret(n.lines, 'query-secret-456');
  });

  it('a path that would leave the sibling’s /api/v1 is a programming error, thrown; the key is still revoked', async () => {
    for (const path of [
      'things',
      '//evil.example/x',
      'https://evil.example/x',
      '/../admin',
      '/things/%2e%2e/%2e%2e/x',
      '/things/%2Fetc',
      '/a\\b',
      '/a b',
      '/a#b'
    ]) {
      const h = harness(happyScript());
      await expect(h.siblings.call('twin', (sibling) => sibling.request('GET', path))).rejects.toThrow(
        TypeError
      );
      expect(h.revoked()).toHaveLength(1);
      expect(h.calls.filter((c) => !c.path.startsWith('/api/v1/sso') && c.path !== '/api/v1/me')).toEqual(
        h.revoked()
      );
    }
    const bad = harness(happyScript());
    await expect(
      bad.siblings.call('twin', (sibling) => sibling.request('TRACE' as never, '/things'))
    ).rejects.toThrow(TypeError);
    expect(bad.revoked()).toHaveLength(1);
  });
});

describe('the sibling call · what the first verifier round asked for', () => {
  it('F3: a request still in flight when the work returns is cut before the key is revoked', async () => {
    const script = happyScript();
    script['GET /api/v1/things'] = [{ status: 200, body: { things: [] }, delayMs: 5_000 }];
    const h = harness(script);
    const started = Date.now();
    const outcome = await h.siblings.call('twin', async (sibling) => {
      // Fired and left behind: the work answers before its request does.
      void sibling.request('GET', '/things');
      await new Promise((r) => setTimeout(r, 20));
      return { kind: 'ok', value: 'answered' };
    });
    expect(outcome).toEqual({ kind: 'ok', value: 'answered' });
    expect(Date.now() - started).toBeLessThan(1000);
    const abort = h.events.indexOf('abort GET /api/v1/things');
    const revoke = h.events.indexOf('call DELETE /api/v1/cli/auth/key');
    expect(abort).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(abort);
  });

  it('F3: a request in flight at the deadline is cut before the key is revoked', async () => {
    const script = happyScript();
    script['GET /api/v1/things'] = [{ status: 200, body: { things: [] }, delayMs: 5_000 }];
    const h = harness(script, { overallMs: 300 });
    expect((await h.siblings.call('twin', (sibling) => sibling.request('GET', '/things'))).kind).toBe(
      'unavailable'
    );
    const abort = h.events.indexOf('abort GET /api/v1/things');
    expect(abort).toBeGreaterThan(-1);
    expect(h.events.indexOf('call DELETE /api/v1/cli/auth/key')).toBeGreaterThan(abort);
  });

  it('F4: a call leaves no timer of its own behind, whatever its outcome', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ok = harness(happyScript());
      expect((await ok.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).kind).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
      const refused = happyScript();
      refused['GET /api/v1/things'] = [{ status: 404, body: err('not_found') }];
      const r = harness(refused);
      expect((await r.siblings.call('twin', (s) => s.request('GET', '/things'))).kind).toBe(
        'sibling_refused'
      );
      expect(vi.getTimerCount()).toBe(0);
      const thrown = harness(happyScript());
      await expect(
        thrown.siblings.call('twin', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F5: a dot segment, an encoded backslash and a malformed escape are each a TypeError', async () => {
    for (const path of [
      '/things/./x',
      '/./things',
      '/things/%2e',
      '/a%5Cb',
      '/a%5cb',
      '/%E0%A4%A',
      '/things/%'
    ]) {
      const h = harness(happyScript());
      const thrown = await h.siblings.call('twin', (sibling) => sibling.request('GET', path)).catch((e) => e);
      expect(thrown, path).toBeInstanceOf(TypeError);
      expect(h.revoked()).toHaveLength(1);
    }
  });

  it('F6: the key is asked for with a lifetime of its own, so a revocation that cannot run still ends it', async () => {
    const h = harness(happyScript());
    await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }));
    const mint = h.calls.find((c) => c.path === '/api/v1/sso/cli-connect')!;
    expect(mint.body).toEqual({ token: CONNECT, expiresInSeconds: 300 });
    expect(siblingKeyTtlSeconds(60_000, 10_000)).toBe(300);
    expect(siblingKeyTtlSeconds(600_000, 10_000)).toBe(670);
    expect(siblingKeyTtlSeconds(10 * 3_600_000, 10_000)).toBe(3600);
    expect(siblingKeyTtlSeconds(0, 0)).toBe(300);
  });

  it('F9: a request with no principal runs with no person, even entered from a person’s scope', async () => {
    const principal = {
      userId: 'u-outer',
      email: 'o@example.com',
      name: 'O',
      workspaceId: 'ws-outer',
      role: 'admin',
      origin: 'hub',
      via: 'session',
      scopes: null
    } satisfies Principal;
    const seen = await runAsPerson(principal, () =>
      runWithoutPerson(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return personOfRequest();
      })
    );
    expect(seen).toBeNull();
    expect(runAsPerson(principal, () => personOfRequest())?.userId).toBe('u-outer');
  });

  it('F1: the sign-in asks for sso:connect for a sibling call, for a sibling source, each on its own', () => {
    expect(asksConnectScope([], [])).toBe(false);
    expect(asksConnectScope([], [{}, { sibling: undefined }])).toBe(false);
    expect(asksConnectScope([{ toolSlug: 'twin' }], [])).toBe(true);
    expect(asksConnectScope([], [{}, { sibling: { toolSlug: 'twin', events: [] } }])).toBe(true);
  });
});

describe('the sibling call · the connect’s refusals, answered', () => {
  const cases: Array<[string, Record<string, Reply[]>, { access?: GrantAccess }, unknown]> = [
    ['no grant on this tool', {}, { access: { kind: 'no_link' } }, { kind: 'hub_reauth_required' }],
    ['a dead grant', {}, { access: { kind: 'grant_dead' } }, { kind: 'hub_reauth_required' }],
    [
      'the hub not answering the grant refresh',
      {},
      { access: { kind: 'inconclusive' } },
      { kind: 'unavailable', message: 'the hub did not answer the grant refresh' }
    ],
    [
      'a grant without sso:connect',
      { 'POST /api/v1/sso/connect-token': [{ status: 403, body: err('insufficient_scope') }] },
      {},
      { kind: 'sibling_scope_missing' }
    ],
    [
      'the hub closing the sibling to the person',
      { 'POST /api/v1/sso/connect-token': [{ status: 403, body: err('tool_access_denied') }] },
      {},
      { kind: 'sibling_access_denied' }
    ],
    [
      'a resource the hub does not know',
      { 'POST /api/v1/sso/connect-token': [{ status: 400, body: err('unknown_resource') }] },
      {},
      { kind: 'sibling_unknown', message: 'The hub’s registry knows no tool at the sibling’s address' }
    ],
    [
      'the hub down',
      { 'POST /api/v1/sso/connect-token': ['network'] },
      {},
      { kind: 'unavailable', message: 'the hub did not answer' }
    ]
  ];
  for (const [name, script, opts, expected] of cases) {
    it(`${name}: answered before any key exists`, async () => {
      const h = harness(script, opts);
      let ran = false;
      const outcome = await h.siblings.call('twin', async () => {
        ran = true;
        return { kind: 'ok', value: 1 };
      });
      expect(outcome).toEqual(expected);
      expect(ran).toBe(false);
      expect(h.calls.filter((c) => !c.path.startsWith('/api/v1/sso/connect-token'))).toEqual([]);
      expectNothingSecret(h.lines);
    });
  }

  it('a person the sibling never saw: sibling_grant_missing, no key to revoke', async () => {
    const script = happyScript();
    script['POST /api/v1/sso/cli-connect'] = [{ status: 403, body: err('hub_grant_missing') }];
    const h = harness(script);
    expect(await h.siblings.call('twin', async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'sibling_grant_missing'
    });
    expect(h.revoked()).toEqual([]);
  });

  it('no sibling workspace of our organization: sibling_workspace_missing, and the key is revoked', async () => {
    const script = happyScript();
    script['GET /api/v1/me'] = [
      { status: 200, body: { workspaces: [{ id: 'ws-twin-other', centralAccountId: 'org-other' }] } }
    ];
    const h = harness(script);
    let ran = false;
    expect(
      await h.siblings.call('twin', async () => {
        ran = true;
        return { kind: 'ok', value: 1 };
      })
    ).toEqual({ kind: 'sibling_workspace_missing' });
    expect(ran).toBe(false);
    expect(h.revoked()).toHaveLength(1);
  });

  it('a revocation the sibling refuses is logged, and the answer stands', async () => {
    const script = happyScript();
    script['DELETE /api/v1/cli/auth/key'] = [{ status: 500 }];
    const h = harness(script);
    expect(await h.siblings.call('twin', async () => ({ kind: 'ok', value: 7 }))).toEqual({
      kind: 'ok',
      value: 7
    });
    expect(h.lines.some((l) => l.includes('could not be revoked'))).toBe(true);
    expectNothingSecret(h.lines);
  });
});

describe('the siblings slot, checked at boot', () => {
  it('takes a list of registry slugs, once each', () => {
    expect(buildSiblingDeclarations(undefined)).toEqual([]);
    expect(buildSiblingDeclarations([{ toolSlug: 'other' }, { toolSlug: 'other-2' }])).toEqual([
      { toolSlug: 'other' },
      { toolSlug: 'other-2' }
    ]);
    expect(() => buildSiblingDeclarations({ toolSlug: 'other' })).toThrow(/must be a list/);
    expect(() => buildSiblingDeclarations([{ toolSlug: 'Other' }])).toThrow(/siblings\[0\]\.toolSlug/);
    expect(() => buildSiblingDeclarations([{ toolSlug: '' }])).toThrow(/siblings\[0\]\.toolSlug/);
    expect(() => buildSiblingDeclarations(['other'])).toThrow(/siblings\[0\]\.toolSlug/);
    expect(() => buildSiblingDeclarations([{ toolSlug: 'other' }, { toolSlug: 'other' }])).toThrow(/twice/);
  });

  it('the call reads the declared list and nothing else', async () => {
    const h = harness(happyScript(), { declared: ['twin', 'other'] });
    expect(h.siblings.declared).toEqual(['twin', 'other']);
    expect(Object.isFrozen(h.siblings.declared)).toBe(true);
    expect((await h.siblings.call('stranger-tool', async () => ({ kind: 'ok', value: 1 }))).kind).toBe(
      'sibling_not_declared'
    );
  });
});
