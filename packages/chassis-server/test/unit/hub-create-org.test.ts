import { describe, expect, it, vi } from 'vitest';
import { classifyHubOrgCreateAnswer, HubUserClient } from '@antasphere/chassis-server/identity';
import type { GrantAccess, HubGrantService } from '@antasphere/chassis-server/identity';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * The ONE hub call behind POST /workspaces on cloud (PRDCT-2443):
 * `HubUserClient.createOrg` and its pure answer classifier. The grant is a
 * stub — what matters here is WHICH token is presented, how often, and that
 * an ambiguous answer is never retried (a blind second POST could create a
 * second organization).
 */
const ORG_ID = '7d0c9a52-3f5e-4a4b-9a57-0e6c1c2f9b11';
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function stubGrant(over: Partial<Record<'accessToken' | 'refresh', GrantAccess>> = {}) {
  const grant = {
    accessToken: vi.fn(
      async (): Promise<GrantAccess> => over.accessToken ?? { kind: 'ok', accessToken: 'at-1' }
    ),
    refresh: vi.fn(async (): Promise<GrantAccess> => over.refresh ?? { kind: 'ok', accessToken: 'at-2' }),
    invalidateAccess: vi.fn(),
    prime: vi.fn()
  };
  return grant;
}

function client(grant: ReturnType<typeof stubGrant>, fetchImpl: typeof fetch) {
  return new HubUserClient({
    grant: grant as unknown as HubGrantService,
    issuerUrl: 'https://hub.test/',
    logger: silent,
    timeoutMs: 1_000,
    fetchImpl
  });
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('classifyHubOrgCreateAnswer', () => {
  it('201 with a well-formed org is created; the role is validated, never invented', () => {
    expect(
      classifyHubOrgCreateAnswer(201, { org: { id: ORG_ID, name: 'Acme', role: 'owner', personal: false } })
    ).toEqual({ kind: 'created', org: { id: ORG_ID, name: 'Acme', role: 'owner' } });
    expect(classifyHubOrgCreateAnswer(201, { org: { id: ORG_ID, name: ' ', role: 'emperor' } })).toEqual({
      kind: 'created',
      org: { id: ORG_ID, name: null, role: null }
    });
  });

  it('a 2xx without a valid org id is inconclusive — never a guessed id', () => {
    expect(classifyHubOrgCreateAnswer(201, { org: { id: 'not-a-uuid' } })).toEqual({ kind: 'inconclusive' });
    expect(classifyHubOrgCreateAnswer(201, {})).toEqual({ kind: 'inconclusive' });
    expect(classifyHubOrgCreateAnswer(201, null)).toEqual({ kind: 'inconclusive' });
  });

  it('the hub cap, in either spelling and either status, is limit_reached', () => {
    for (const status of [403, 409]) {
      for (const code of ['org_limit_reached', 'org_cap_reached']) {
        expect(classifyHubOrgCreateAnswer(status, { error: { code } })).toEqual({ kind: 'limit_reached' });
      }
    }
  });

  it('403 insufficient_scope — exactly that — is reauth_required; no other 403 is', () => {
    expect(classifyHubOrgCreateAnswer(403, { error: { code: 'insufficient_scope' } })).toEqual({
      kind: 'reauth_required'
    });
    // The same code on another status, and the hub's OTHER 403s, are not a
    // reason to send someone through a sign-in that would change nothing.
    expect(classifyHubOrgCreateAnswer(401, { error: { code: 'insufficient_scope' } }).kind).toBe('refused');
    expect(classifyHubOrgCreateAnswer(403, { error: { code: 'forbidden' } }).kind).toBe('refused');
    expect(classifyHubOrgCreateAnswer(403, { error: { code: 'endpoint_not_allowed' } }).kind).toBe('refused');
    expect(classifyHubOrgCreateAnswer(403, null).kind).toBe('refused');
  });

  it('400/422 is invalid; any other 4xx is a definitive refusal; 5xx is inconclusive', () => {
    expect(classifyHubOrgCreateAnswer(400, { error: { code: 'validation_error' } })).toEqual({
      kind: 'invalid'
    });
    expect(classifyHubOrgCreateAnswer(422, null)).toEqual({ kind: 'invalid' });
    expect(classifyHubOrgCreateAnswer(403, { error: { code: 'forbidden' } })).toEqual({
      kind: 'refused',
      status: 403,
      code: 'forbidden'
    });
    expect(classifyHubOrgCreateAnswer(409, { error: { code: 'other' } })).toEqual({
      kind: 'refused',
      status: 409,
      code: 'other'
    });
    expect(classifyHubOrgCreateAnswer(500, null)).toEqual({ kind: 'inconclusive' });
    expect(classifyHubOrgCreateAnswer(502, 'gateway')).toEqual({ kind: 'inconclusive' });
  });
});

describe('HubUserClient.createOrg', () => {
  it('POSTs { name } to <hub>/api/v1/orgs with the USER grant as the bearer — and nothing naming a user', async () => {
    const grant = stubGrant();
    const fetchImpl = vi.fn(async () => answer(201, { org: { id: ORG_ID, name: 'Acme', role: 'owner' } }));
    const result = await client(grant, fetchImpl as unknown as typeof fetch).createOrg('user-1', 'Acme');
    expect(result).toEqual({ kind: 'created', org: { id: ORG_ID, name: 'Acme', role: 'owner' } });
    expect(grant.accessToken).toHaveBeenCalledWith('user-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hub.test/api/v1/orgs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at-1');
    // The body is the name and ONLY the name: no target-user parameter exists.
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Acme' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes the grant verdicts through without calling the hub', async () => {
    for (const kind of ['no_link', 'grant_dead', 'inconclusive'] as const) {
      const fetchImpl = vi.fn();
      const result = await client(
        stubGrant({ accessToken: { kind } }),
        fetchImpl as unknown as typeof fetch
      ).createOrg('user-1', 'Acme');
      expect(result).toEqual({ kind });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('a 401 earns ONE forced refresh and ONE retry with the fresh token', async () => {
    const grant = stubGrant();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(answer(401, { error: { code: 'invalid_token' } }))
      .mockResolvedValueOnce(answer(201, { org: { id: ORG_ID, name: 'Acme', role: 'owner' } }));
    const result = await client(grant, fetchImpl as unknown as typeof fetch).createOrg('user-1', 'Acme');
    expect(result.kind).toBe('created');
    expect(grant.invalidateAccess).toHaveBeenCalledWith('user-1');
    expect(grant.refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).authorization).toBe('Bearer at-2');
  });

  it('a dead grant discovered by that refresh is grant_dead; a second 401 is a refusal, not a loop', async () => {
    const dead = stubGrant({ refresh: { kind: 'grant_dead' } });
    const once = vi.fn(async () => answer(401, {}));
    expect(await client(dead, once as unknown as typeof fetch).createOrg('u', 'A')).toEqual({
      kind: 'grant_dead'
    });
    expect(once).toHaveBeenCalledTimes(1);

    const twice = vi.fn(async () => answer(401, {}));
    expect(await client(stubGrant(), twice as unknown as typeof fetch).createOrg('u', 'A')).toEqual({
      kind: 'refused',
      status: 401,
      code: null
    });
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries a 403, a 5xx, or a network failure — the hub may have committed', async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => answer(403, { error: { code: 'org_limit_reached' } }), 'limit_reached'],
      [async () => answer(403, { error: { code: 'forbidden' } }), 'refused'],
      [async () => answer(403, { error: { code: 'insufficient_scope' } }), 'reauth_required'],
      [async () => answer(500, { error: { code: 'internal' } }), 'inconclusive'],
      [
        async () => {
          throw new TypeError('fetch failed');
        },
        'inconclusive'
      ]
    ];
    for (const [impl, kind] of cases) {
      const grant = stubGrant();
      const fetchImpl = vi.fn(impl);
      const result = await client(grant, fetchImpl as unknown as typeof fetch).createOrg('u', 'A');
      expect(result.kind).toBe(kind);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(grant.refresh).not.toHaveBeenCalled();
    }
  });
});
