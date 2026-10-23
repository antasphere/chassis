import { describe, expect, it } from 'vitest';
import { SiblingConnector } from '../../src/connections/sibling.js';
import type { GrantAccess } from '../../src/identity/hub-grant.js';
import type { FleetTool } from '../../src/webhooks/fleet-origins.js';

/**
 * The sibling connect's two conversations on their own (PRDCT-3774), with
 * the hub and the sibling played by an injected fetch: every answer maps to
 * ONE outcome the service turns into a sentence, the person's key on the
 * sibling is revoked whatever the work did (a refusal, a throw), a 401 from
 * the hub earns exactly one forced refresh, no redirect is followed, and no
 * token, key or secret is ever logged.
 */

const logger = {
  lines: [] as string[],
  info(...a: unknown[]) {
    this.lines.push(JSON.stringify(a));
  },
  warn(...a: unknown[]) {
    this.lines.push(JSON.stringify(a));
  },
  error(...a: unknown[]) {
    this.lines.push(JSON.stringify(a));
  },
  debug() {}
};

const TWIN: FleetTool = {
  slug: 'twin',
  clientId: 'tool-twin',
  name: 'Twin',
  origin: 'https://twin.example.com',
  resourceUrl: 'https://twin.example.com/mcp'
};
const TOKEN = 'hub-access-token-0001';
const CONNECT = 'connect-jwt-0001';
const KEY = 'tk_keyid_secretsecretsecret';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status: number; body?: unknown } | 'network';

function harness(
  script: Record<string, Reply[] | ((call: Call) => Reply)>,
  grant: Partial<GrantLike> = {},
  fleet: { fetchedAt?: Date | null } = {}
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    expect(init?.redirect).toBe('error');
    const key = `${call.method} ${new URL(url).pathname}`;
    const entry = script[key];
    if (!entry) throw new Error(`unscripted call ${key}`);
    const reply = typeof entry === 'function' ? entry(call) : (entry.shift() ?? { status: 500 });
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const grantCalls: string[] = [];
  const grantImpl = {
    accessToken: async () => {
      grantCalls.push('accessToken');
      return grant.access ?? ({ kind: 'ok', accessToken: TOKEN } as GrantAccess);
    },
    invalidateAccess: () => {
      grantCalls.push('invalidateAccess');
    },
    refresh: async () => {
      grantCalls.push('refresh');
      return grant.refreshed ?? ({ kind: 'ok', accessToken: `${TOKEN}-fresh` } as GrantAccess);
    }
  };
  const connector = new SiblingConnector({
    grant: grantImpl,
    issuerUrl: 'https://hub.example/',
    fleet: {
      tool: (slug) => (slug === 'twin' ? TWIN : null),
      fetchedAt: fleet.fetchedAt === undefined ? new Date() : fleet.fetchedAt
    },
    logger: logger as never,
    fetchImpl,
    timeoutMs: 1000
  });
  return { connector, calls, grantCalls };
}
type GrantLike = { access: GrantAccess; refreshed: GrantAccess };

const err = (code: string, message = code) => ({ error: { code, message } });

describe('SiblingConnector · the hub, as the person', () => {
  it('asks POST <hub>/api/v1/sso/connect-token with the grant token and the resource, and answers the token', async () => {
    const { connector, calls } = harness({
      'POST /api/v1/sso/connect-token': [{ status: 200, body: { token: CONNECT, expiresAt: 'x' } }]
    });
    expect(await connector.connectToken('u1', TWIN.resourceUrl)).toEqual({ kind: 'ok', value: CONNECT });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/sso/connect-token');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ resource: TWIN.resourceUrl });
  });

  it('a 401 earns one forced refresh and one retry; a second 401 is a reauth', async () => {
    const { connector, grantCalls } = harness({
      'POST /api/v1/sso/connect-token': [
        { status: 401, body: err('invalid_token') },
        { status: 200, body: { token: CONNECT } }
      ]
    });
    expect(await connector.connectToken('u1', TWIN.resourceUrl)).toEqual({ kind: 'ok', value: CONNECT });
    expect(grantCalls).toEqual(['accessToken', 'invalidateAccess', 'refresh']);

    const twice = harness({
      'POST /api/v1/sso/connect-token': [
        { status: 401, body: err('invalid_token') },
        { status: 401, body: err('invalid_token') }
      ]
    });
    expect(await twice.connector.connectToken('u1', TWIN.resourceUrl)).toEqual({
      kind: 'hub_reauth_required'
    });
    expect(twice.calls).toHaveLength(2);
  });

  it('maps the hub’s refusals: no grant, a dead grant, the scope, the access, the resource, a 5xx, the network', async () => {
    const noLink = harness({}, { access: { kind: 'no_link' } });
    expect(await noLink.connector.connectToken('u1', TWIN.resourceUrl)).toEqual({
      kind: 'hub_reauth_required'
    });
    expect(noLink.calls).toHaveLength(0);
    const dead = harness({}, { access: { kind: 'grant_dead' } });
    expect(await dead.connector.connectToken('u1', TWIN.resourceUrl)).toEqual({
      kind: 'hub_reauth_required'
    });
    const inconclusive = harness({}, { access: { kind: 'inconclusive' } });
    expect((await inconclusive.connector.connectToken('u1', TWIN.resourceUrl)).kind).toBe('unavailable');

    const one = (reply: Reply) =>
      harness({ 'POST /api/v1/sso/connect-token': [reply] }).connector.connectToken('u1', TWIN.resourceUrl);
    expect(await one({ status: 403, body: err('insufficient_scope') })).toEqual({
      kind: 'sibling_scope_missing'
    });
    expect(await one({ status: 403, body: err('tool_access_denied') })).toEqual({
      kind: 'sibling_access_denied'
    });
    expect((await one({ status: 400, body: err('unknown_resource') })).kind).toBe('sibling_unknown');
    expect(await one({ status: 403, body: err('forbidden', 'A session may not') })).toEqual({
      kind: 'sibling_refused',
      message: 'The hub refused the connect: A session may not'
    });
    expect((await one({ status: 503 })).kind).toBe('unavailable');
    expect((await one('network')).kind).toBe('unavailable');
    expect((await one({ status: 200, body: { nope: true } })).kind).toBe('unavailable');
  });
});

describe('SiblingConnector · the sibling, as the person', () => {
  it('mints the key at /sso/cli-connect (201), runs the work with it, and revokes it after', async () => {
    const { connector, calls } = harness({
      'POST /api/v1/sso/cli-connect': [
        { status: 201, body: { key: KEY, apiKey: {}, user: {}, workspaceId: null } }
      ],
      'DELETE /api/v1/cli/auth/key': [{ status: 200, body: { revoked: true, id: 'k' } }]
    });
    const seen: string[] = [];
    const out = await connector.withPersonKey(TWIN, CONNECT, async (key) => {
      seen.push(key);
      return { kind: 'ok', value: 42 };
    });
    expect(out).toEqual({ kind: 'ok', value: 42 });
    expect(seen).toEqual([KEY]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://twin.example.com/api/v1/sso/cli-connect',
      'DELETE https://twin.example.com/api/v1/cli/auth/key'
    ]);
    expect(calls[0]!.body).toEqual({ token: CONNECT });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('revokes the key when the work refuses, and when the work throws (the throw still propagates)', async () => {
    const refused = harness({
      'POST /api/v1/sso/cli-connect': [{ status: 201, body: { key: KEY } }],
      'DELETE /api/v1/cli/auth/key': [{ status: 200, body: { revoked: true, id: 'k' } }]
    });
    expect(
      await refused.connector.withPersonKey(TWIN, CONNECT, async () => ({
        kind: 'sibling_workspace_missing'
      }))
    ).toEqual({ kind: 'sibling_workspace_missing' });
    expect(refused.calls.at(-1)!.method).toBe('DELETE');

    const thrown = harness({
      'POST /api/v1/sso/cli-connect': [{ status: 201, body: { key: KEY } }],
      'DELETE /api/v1/cli/auth/key': [{ status: 200, body: { revoked: true, id: 'k' } }]
    });
    await expect(
      thrown.connector.withPersonKey(TWIN, CONNECT, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(thrown.calls.at(-1)!.method).toBe('DELETE');
  });

  it('a revoke that fails is logged, never thrown, and never logs the key', async () => {
    const { connector, calls } = harness({
      'POST /api/v1/sso/cli-connect': [{ status: 201, body: { key: KEY } }],
      'DELETE /api/v1/cli/auth/key': ['network']
    });
    logger.lines.length = 0;
    expect(await connector.withPersonKey(TWIN, CONNECT, async () => ({ kind: 'ok', value: 1 }))).toEqual({
      kind: 'ok',
      value: 1
    });
    expect(calls).toHaveLength(2);
    expect(logger.lines.join('\n')).not.toContain(KEY);
    expect(logger.lines.join('\n')).not.toContain(CONNECT);
  });

  it('maps the sibling’s refusals of the connect token: no grant there, no membership, a 401, a 5xx, the network', async () => {
    const one = (reply: Reply) =>
      harness({ 'POST /api/v1/sso/cli-connect': [reply] }).connector.withPersonKey(
        TWIN,
        CONNECT,
        async () => ({
          kind: 'ok',
          value: 1
        })
      );
    expect(await one({ status: 403, body: err('hub_grant_missing') })).toEqual({
      kind: 'sibling_grant_missing'
    });
    expect(await one({ status: 403, body: err('no_membership') })).toEqual({ kind: 'sibling_grant_missing' });
    expect(await one({ status: 401, body: err('invalid_token', 'expired') })).toEqual({
      kind: 'sibling_refused',
      message: 'Twin refused the connect: expired'
    });
    expect((await one({ status: 502 })).kind).toBe('unavailable');
    expect((await one('network')).kind).toBe('unavailable');
    expect((await one({ status: 201, body: { nokey: true } })).kind).toBe('unavailable');
  });

  it('finds the twin workspace by our hub organization in GET /me, or says none projects it', async () => {
    const me = {
      workspaces: [
        { id: 'w-local', centralAccountId: null },
        { id: 'w-twin', centralAccountId: 'org-1' }
      ]
    };
    const { connector, calls } = harness({
      'GET /api/v1/me': [
        { status: 200, body: me },
        { status: 200, body: me }
      ]
    });
    expect(await connector.workspaceOf(TWIN, KEY, 'org-1')).toEqual({ kind: 'ok', value: 'w-twin' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await connector.workspaceOf(TWIN, KEY, 'org-2')).toEqual({ kind: 'sibling_workspace_missing' });
    const refused = harness({ 'GET /api/v1/me': [{ status: 401, body: err('unauthenticated') }] });
    expect((await refused.connector.workspaceOf(TWIN, KEY, 'org-1')).kind).toBe('sibling_refused');
  });

  it('registers the endpoint in the twin workspace with the URL, the events and the description, and answers id and secret', async () => {
    const { connector, calls } = harness({
      'POST /api/v1/webhooks': [{ status: 201, body: { id: 'ep-1', secret: 'whsec_abc', url: 'x' } }]
    });
    const out = await connector.createEndpoint(TWIN, KEY, 'w-twin', {
      url: 'https://things.example.com/hooks/twin/tok',
      events: ['thing.created'],
      description: 'Things: connected from Settings › Connections'
    });
    expect(out).toEqual({ kind: 'ok', value: { id: 'ep-1', secret: 'whsec_abc' } });
    expect(calls[0]!.headers['x-workspace-id']).toBe('w-twin');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({
      url: 'https://things.example.com/hooks/twin/tok',
      events: ['thing.created'],
      description: 'Things: connected from Settings › Connections'
    });
  });

  it('a refused endpoint carries the twin’s own sentence; a 5xx is unavailable; a body off the contract is unavailable', async () => {
    const one = (reply: Reply) =>
      harness({ 'POST /api/v1/webhooks': [reply] }).connector.createEndpoint(TWIN, KEY, 'w', {
        url: 'u',
        events: ['e'],
        description: 'd'
      });
    expect(
      await one({ status: 400, body: err('url_refused', 'the address is on a private network') })
    ).toEqual({
      kind: 'sibling_refused',
      message: 'Twin would not register the endpoint: the address is on a private network'
    });
    expect(await one({ status: 403, body: err('plan_required', 'Upgrade') })).toEqual({
      kind: 'sibling_refused',
      message: 'Twin would not register the endpoint: Upgrade'
    });
    expect((await one({ status: 500 })).kind).toBe('unavailable');
    expect((await one({ status: 201, body: { id: 'ep', nosecret: 1 } })).kind).toBe('unavailable');
  });

  it('deletes every endpoint of ours for a source, page by page, leaving the others; a refused page is the twin’s', async () => {
    const page1 = {
      webhooks: [
        { id: 'ours-1', url: 'https://things.example.com/hooks/twin/tok-1' },
        { id: 'theirs', url: 'https://elsewhere.example.com/hook' },
        { id: 'another-source', url: 'https://things.example.com/hooks/partner/tok' }
      ],
      nextCursor: 'c2'
    };
    const page2 = {
      webhooks: [{ id: 'ours-2', url: 'https://things.example.com/hooks/twin/tok-2' }],
      nextCursor: null
    };
    const { connector, calls } = harness({
      'GET /api/v1/webhooks': [
        { status: 200, body: page1 },
        { status: 200, body: page2 }
      ],
      'DELETE /api/v1/webhooks/ours-1': [{ status: 200, body: { id: 'ours-1' } }],
      'DELETE /api/v1/webhooks/ours-2': [{ status: 404, body: err('not_found') }]
    });
    const out = await connector.deleteOurEndpoints(TWIN, KEY, 'w', 'https://things.example.com/hooks/twin/');
    expect(out).toEqual({ kind: 'ok', value: 2 });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      'GET /api/v1/webhooks?limit=100',
      'GET /api/v1/webhooks?limit=100&cursor=c2',
      'DELETE /api/v1/webhooks/ours-1',
      'DELETE /api/v1/webhooks/ours-2'
    ]);
    // Every call in the sibling workspace, as the key.
    expect(
      calls.every((c) => c.headers['x-workspace-id'] === 'w' && c.headers.authorization === `Bearer ${KEY}`)
    ).toBe(true);
    const refused = harness({
      'GET /api/v1/webhooks': [{ status: 403, body: err('forbidden', 'Only an owner') }]
    });
    expect(await refused.connector.deleteOurEndpoints(TWIN, KEY, 'w', 'x')).toEqual({
      kind: 'sibling_refused',
      message: 'Twin would not list its endpoints: Only an owner'
    });
  });

  it('keeps the endpoint just made, deletes the tracked one by id whatever its URL, and never one of a source whose key merely starts the same', async () => {
    const page = {
      webhooks: [
        { id: 'new', url: 'https://things.example.com/hooks/twin/tok-new' },
        { id: 'stale', url: 'https://things.example.com/hooks/twin/tok-old' },
        { id: 'twin-other', url: 'https://things.example.com/hooks/twin-other/tok' },
        { id: 'tracked-legacy', url: 'https://things.example.com/legacy/hooks/twin/tok' }
      ],
      nextCursor: null
    };
    const { connector, calls } = harness({
      'GET /api/v1/webhooks': [{ status: 200, body: page }],
      'DELETE /api/v1/webhooks/stale': [{ status: 200, body: { id: 'stale' } }],
      'DELETE /api/v1/webhooks/tracked-legacy': [{ status: 200, body: { id: 'tracked-legacy' } }]
    });
    const out = await connector.deleteOurEndpoints(TWIN, KEY, 'w', 'https://things.example.com/hooks/twin/', {
      keep: 'new',
      also: 'tracked-legacy'
    });
    expect(out).toEqual({ kind: 'ok', value: 2 });
    expect(
      calls
        .filter((c) => c.method === 'DELETE')
        .map((c) => new URL(c.url).pathname)
        .sort()
    ).toEqual(['/api/v1/webhooks/stale', '/api/v1/webhooks/tracked-legacy']);
    // `also` equal to `keep` deletes nothing.
    const same = harness({
      'GET /api/v1/webhooks': [{ status: 200, body: { webhooks: [], nextCursor: null } }]
    });
    expect(await same.connector.deleteOurEndpoints(TWIN, KEY, 'w', 'x/', { keep: 'n', also: 'n' })).toEqual({
      kind: 'ok',
      value: 0
    });
  });

  it('a connect has one budget: a call past its deadline is unavailable without reaching the sibling', async () => {
    const { connector, calls } = harness({ 'GET /api/v1/me': [{ status: 200, body: { workspaces: [] } }] });
    const budget = { deadlineAt: Date.now() - 1 };
    expect(await connector.workspaceOf(TWIN, KEY, 'org-1', budget)).toEqual({
      kind: 'unavailable',
      message: 'the connect took too long'
    });
    expect(await connector.connectToken('u1', TWIN.resourceUrl, budget)).toEqual({
      kind: 'unavailable',
      message: 'the connect took too long'
    });
    expect(calls).toHaveLength(0);
    // Inside the budget the call goes through.
    expect(await connector.workspaceOf(TWIN, KEY, 'org-1', connector.budget())).toEqual({
      kind: 'sibling_workspace_missing'
    });
    expect(calls).toHaveLength(1);
  });

  it('deletes the endpoint, one already gone counting as deleted; a refusal is the twin’s', async () => {
    const { connector, calls } = harness({
      'DELETE /api/v1/webhooks/ep-1': [
        { status: 200, body: { id: 'ep-1' } },
        { status: 404, body: err('not_found') }
      ],
      'DELETE /api/v1/webhooks/ep-2': [{ status: 403, body: err('forbidden', 'Only an owner') }]
    });
    expect(await connector.deleteEndpoint(TWIN, KEY, 'w', 'ep-1')).toEqual({ kind: 'ok', value: undefined });
    expect(await connector.deleteEndpoint(TWIN, KEY, 'w', 'ep-1')).toEqual({ kind: 'ok', value: undefined });
    expect(await connector.deleteEndpoint(TWIN, KEY, 'w', 'ep-2')).toEqual({
      kind: 'sibling_refused',
      message: 'Twin would not delete the endpoint: Only an owner'
    });
    expect(calls.every((c) => c.headers['x-workspace-id'] === 'w')).toBe(true);
  });

  it('resolves a declared slug through the fleet list, null for a slug the hub does not list; says whether the fleet was ever read', () => {
    const { connector } = harness({});
    expect(connector.resolve('twin')).toEqual(TWIN);
    expect(connector.resolve('nobody')).toBeNull();
    expect(connector.fleetRead()).toBe(true);
    const unread = harness({}, {}, { fetchedAt: null });
    expect(unread.connector.fleetRead()).toBe(false);
  });

  it('addresses the sibling’s API at the origin of its RESOURCE URL, not of its launch URL (round 5, F5)', async () => {
    const branded: FleetTool = {
      slug: 'branded',
      clientId: 'tool-branded',
      name: 'Branded',
      origin: 'https://app.branded.example.com',
      resourceUrl: 'https://branded.example.com/mcp'
    };
    expect(SiblingConnector.apiOrigin(branded)).toBe('https://branded.example.com');
    const { connector, calls } = harness({ 'GET /api/v1/me': [{ status: 200, body: { workspaces: [] } }] });
    expect(await connector.workspaceOf(branded, KEY, 'org-1')).toEqual({ kind: 'sibling_workspace_missing' });
    expect(calls[0]!.url).toBe('https://branded.example.com/api/v1/me');
  });
});
