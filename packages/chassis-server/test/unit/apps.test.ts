import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@antasphere/chassis-db';
import type { GrantAccess } from '../../src/identity/hub-grant.js';
import type { Logger } from '../../src/logger.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Principal } from '@antasphere/chassis-contract';
import {
  appsFromFile,
  readDescriptor,
  readOrganization,
  safeHttpUrl,
  selectHubApps
} from '../../src/apps/select.js';
import { registerAppsRoutes } from '../../src/apps/routes.js';
import { APPS_CACHE_TTL_MS, AppsService, type HubTokens } from '../../src/apps/service.js';

/**
 * The Apps page's list (`src/apps/`, PRDCT-3493): the URL rule, the
 * operator's file with the descriptor keys, the hub's one answer kept where
 * the organization opens the tool, the current tool, and the service's
 * fall-backs and cache, the suspended organization served as an empty list,
 * the handler's own session-only refusal. The route through the real boot
 * (the allowlist's 403 before the handler) is the integration suite's
 * (`test/integration/apps-route.test.ts`).
 */

const ORG = '0b9f1a52-6f8e-4b5e-9a35-1d2c3e4f5a6b';
const DESCRIPTOR = {
  description: 'Where the company keeps its figures.',
  icon: 'landmark',
  drawing: 'ledger',
  accent: '#B5542A'
};

describe('safeHttpUrl', () => {
  it('keeps http and https, normalised', () => {
    expect(safeHttpUrl('https://finance.example.com')).toBe('https://finance.example.com/');
    expect(safeHttpUrl('http://localhost:4300/home')).toBe('http://localhost:4300/home');
  });

  it('refuses every other scheme, a relative path, credentials, a blank and a non-string', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      '/relative',
      'https://user:pw@finance.example.com',
      '',
      '   ',
      42,
      null,
      undefined,
      'https://' + 'a'.repeat(2001)
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe('readDescriptor', () => {
  it('keeps a valid descriptor and drops an invalid or empty one, never refusing the entry', () => {
    expect(readDescriptor(DESCRIPTOR)).toEqual(DESCRIPTOR);
    expect(readDescriptor({ icon: 'mail' })).toEqual({ icon: 'mail' });
    expect(readDescriptor({})).toBeUndefined();
    expect(readDescriptor(null)).toBeUndefined();
    expect(readDescriptor({ icon: 'skull' })).toBeUndefined();
    expect(readDescriptor({ logo: 'https://x.example/logo.svg' })).toBeUndefined();
    expect(readDescriptor({ accent: 'red' })).toBeUndefined();
    expect(readDescriptor('landmark')).toBeUndefined();
    expect(readDescriptor(['landmark'])).toBeUndefined();
  });

  it('drops the one key the contract refuses and keeps the rest: a newer hub’s icon or key never costs the sentence', () => {
    expect(readDescriptor({ icon: 'mail', badge: 'new' })).toEqual({ icon: 'mail' });
    expect(readDescriptor({ icon: 'anchor', drawing: 'ledger', accent: '#112233' })).toEqual({
      drawing: 'ledger',
      accent: '#112233'
    });
    expect(readDescriptor({ ...DESCRIPTOR, accent: 'red' })).toEqual({
      description: DESCRIPTOR.description,
      icon: DESCRIPTOR.icon,
      drawing: DESCRIPTOR.drawing
    });
    expect(readDescriptor({ description: '  trimmed  ', icon: 'skull' })).toEqual({ description: 'trimmed' });
  });
});

describe('readOrganization', () => {
  it('reads the organization and its status, null without one or on another shape', () => {
    expect(readOrganization({ organization: { id: ORG, name: 'Acme', status: 'active' } })).toEqual({
      name: 'Acme',
      status: 'active'
    });
    expect(readOrganization({ organization: { id: ORG, name: 'Acme', status: 'suspended' } })).toEqual({
      name: 'Acme',
      status: 'suspended'
    });
    expect(readOrganization({ organization: { id: ORG, name: 'Acme' } })).toBeNull();
    expect(readOrganization({ organization: { status: 'frozen' } })).toBeNull();
    expect(readOrganization({ organization: 'Acme' })).toBeNull();
    expect(readOrganization({})).toBeNull();
    expect(readOrganization(null)).toBeNull();
  });
});

describe('appsFromFile', () => {
  it('lists the valid entries in order, marks this tool current, reads the descriptor keys', () => {
    const file = appsFromFile(
      [
        {
          slug: 'finance',
          name: 'Antasphere Finance',
          launchUrl: 'https://finance.example.com',
          ...DESCRIPTOR
        },
        { slug: 'yourtool', name: 'Your Tool', launchUrl: 'https://yourtool.example.com' },
        {
          slug: 'mail',
          name: 'Antasphere Mail',
          launchUrl: 'https://mail.example.com',
          icon: 'mail',
          accent: 'red'
        }
      ],
      'yourtool'
    );
    expect(file.rejected).toEqual([]);
    expect(file.hub).toBeNull();
    expect(file.apps.map((a) => [a.slug, a.current, a.descriptor])).toEqual([
      ['finance', false, DESCRIPTOR],
      ['yourtool', true, undefined],
      // one bad key drops that key alone, the entry and its other keys stay
      ['mail', false, { icon: 'mail' }]
    ]);
    expect(file.apps[0]).toMatchObject({ connected: false, firstUsedAt: null, lastUsedAt: null });
  });

  it('leaves out an entry without a slug, a name or an http(s) launchUrl, and a second of the same slug', () => {
    const file = appsFromFile(
      [
        { name: 'No slug', launchUrl: 'https://a.example.com' },
        { slug: 'Bad Slug', name: 'x', launchUrl: 'https://a.example.com' },
        { slug: 'noname', launchUrl: 'https://a.example.com' },
        { slug: 'crm', name: 'CRM', launchUrl: 'javascript:alert(1)' },
        { slug: 'finance', name: 'Finance', launchUrl: 'https://f.example.com' },
        { slug: 'finance', name: 'Finance again', launchUrl: 'https://f2.example.com' },
        null
      ],
      'yourtool'
    );
    expect(file.apps.map((a) => a.slug)).toEqual(['finance']);
    expect(file.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it('takes an entry named hub or account as the account’s card, not a tool', () => {
    const file = appsFromFile(
      [
        { slug: 'account', name: 'Antasphere account', launchUrl: 'https://account.example.com' },
        { slug: 'finance', name: 'Finance', launchUrl: 'https://f.example.com' }
      ],
      'yourtool'
    );
    expect(file.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere account' });
    expect(file.apps.map((a) => a.slug)).toEqual(['finance']);
  });

  it('a file that is not an array lists nothing', () => {
    const file = appsFromFile({ slug: 'finance' }, 'yourtool');
    expect(file.apps).toEqual([]);
    expect(file.rejected[0]!.reason).toContain('not a JSON array');
  });
});

describe('selectHubApps', () => {
  const answer = {
    organization: { id: ORG, name: 'Acme' },
    tools: [
      {
        slug: 'finance',
        name: 'Antasphere Finance',
        launchUrl: 'https://finance.example.com',
        connected: true,
        connectedAt: '2026-09-01T00:00:00Z',
        lastUsedAt: '2026-10-10T00:00:00Z',
        descriptor: DESCRIPTOR,
        open: true
      },
      {
        slug: 'yourtool',
        name: 'Your Tool',
        launchUrl: 'https://yourtool.example.com',
        connected: false,
        open: true
      },
      {
        slug: 'hiring',
        name: 'Antasphere Hiring',
        launchUrl: 'https://hiring.example.com',
        connected: false,
        open: false
      },
      {
        slug: 'mail',
        name: 'Antasphere Mail',
        launchUrl: 'javascript:alert(1)',
        connected: false,
        open: true
      },
      { slug: 'Bad Slug', name: 'x', launchUrl: 'https://x.example.com', connected: false, open: true },
      {
        slug: 'finance',
        name: 'Finance twice',
        launchUrl: 'https://f2.example.com',
        connected: false,
        open: true
      },
      {
        slug: 'sign',
        name: 'Antasphere Sign',
        launchUrl: 'https://sign.example.com',
        connected: false,
        open: true,
        descriptor: { icon: 'skull' }
      }
    ]
  };

  it('keeps the tools the organization opens, in the hub’s order, with their facts and descriptor', () => {
    const apps = selectHubApps(answer, 'yourtool')!;
    expect(apps.map((a) => a.slug)).toEqual(['finance', 'yourtool', 'sign']);
    expect(apps[0]).toEqual({
      slug: 'finance',
      name: 'Antasphere Finance',
      launchUrl: 'https://finance.example.com/',
      descriptor: DESCRIPTOR,
      connected: true,
      firstUsedAt: '2026-09-01T00:00:00Z',
      lastUsedAt: '2026-10-10T00:00:00Z',
      current: false
    });
    expect(apps[1]!.current).toBe(true);
    // an invalid descriptor drops the descriptor, never the tool
    expect(apps[2]!.descriptor).toBeUndefined();
  });

  it('a tool not open is left out, never listed greyed', () => {
    expect(selectHubApps(answer, 'yourtool')!.some((a) => a.slug === 'hiring')).toBe(false);
  });

  it('is null when the body carries no list', () => {
    expect(selectHubApps({}, 'x')).toBeNull();
    expect(selectHubApps(null, 'x')).toBeNull();
    expect(selectHubApps({ tools: 'nope' }, 'x')).toBeNull();
  });
});

// ── The service ──────────────────────────────────────────────────────────────

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** A db whose one query (the workspace's hub organization) answers `hubOrgId`. */
function fakeDb(hubOrgId: string | null): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([{ hubOrgId }])
  };
  return chain as unknown as Db;
}

function fakeTokens(access: GrantAccess = { kind: 'ok', accessToken: 'tok-1' }) {
  return {
    accessToken: vi.fn<HubTokens['accessToken']>(() => Promise.resolve(access)),
    refresh: vi.fn<HubTokens['refresh']>(() => Promise.resolve({ kind: 'ok', accessToken: 'tok-2' })),
    invalidateAccess: vi.fn<HubTokens['invalidateAccess']>()
  };
}

/** A hub that answers /me/apps for the given token, recording every call with its organization header. */
function fakeHub(
  opts: { token?: string; status?: number; body?: unknown; orgStatus?: 'active' | 'suspended' } = {}
) {
  const calls: Array<{ path: string; org: string | null }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, org: headers.get('x-workspace-id') });
    if (headers.get('authorization') !== `Bearer ${opts.token ?? 'tok-1'}`) {
      return Response.json({ error: {} }, { status: 401 });
    }
    if (opts.status) return Response.json(opts.body ?? {}, { status: opts.status });
    return Response.json(
      opts.body ?? {
        organization: { id: ORG, name: 'Acme', status: opts.orgStatus ?? 'active' },
        tools: [
          {
            slug: 'finance',
            name: 'Antasphere Finance',
            launchUrl: 'https://finance.example.com',
            connected: true,
            connectedAt: '2026-09-01T00:00:00Z',
            lastUsedAt: null,
            descriptor: DESCRIPTOR,
            open: true
          },
          {
            slug: 'yourtool',
            name: 'Your Tool',
            launchUrl: 'https://yourtool.example.com',
            connected: true,
            open: true
          },
          {
            slug: 'hiring',
            name: 'Antasphere Hiring',
            launchUrl: 'https://hiring.example.com',
            connected: false,
            open: false
          }
        ]
      }
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const principal = { userId: 'usr_1', workspaceId: 'ws_1' };

function cloud(over: {
  db?: Db;
  tokens?: HubTokens;
  fetchImpl?: typeof fetch;
  appsFile?: string;
  now?: () => number;
}) {
  return new AppsService({
    db: over.db ?? fakeDb(ORG),
    logger,
    edition: 'cloud',
    hubIssuerUrl: 'https://account.example.com/',
    appsFile: over.appsFile,
    selfSlug: 'yourtool',
    tokens: over.tokens ?? fakeTokens(),
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
    ...(over.now ? { now: over.now } : {})
  });
}

function writeFile(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'apps-'));
  const path = join(dir, 'apps.json');
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

describe('AppsService on the cloud edition', () => {
  it('asks the hub once as the person, for the workspace’s organization, and keeps what it opens', async () => {
    const hub = fakeHub();
    const list = await cloud({ fetchImpl: hub.impl }).list(principal);
    expect(hub.calls).toEqual([{ path: '/api/v1/me/apps', org: ORG }]);
    expect(list.source).toBe('hub');
    expect(list.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere Account' });
    expect(list.apps.map((a) => [a.slug, a.current, a.connected])).toEqual([
      ['finance', false, true],
      ['yourtool', true, true]
    ]);
    expect(list.apps[0]!.descriptor).toEqual(DESCRIPTOR);
    expect(list.organization).toEqual({ name: 'Acme', status: 'active' });
  });

  it('serves a suspended organization as an empty list that says so, never as the tools, and holds that answer', async () => {
    const hub = fakeHub({ orgStatus: 'suspended' });
    const service = cloud({ fetchImpl: hub.impl });
    const list = await service.list(principal);
    expect(list).toEqual({
      apps: [],
      hub: { url: 'https://account.example.com/', name: 'Antasphere Account' },
      source: 'hub',
      organization: { name: 'Acme', status: 'suspended' }
    });
    await service.list(principal);
    expect(hub.calls).toHaveLength(1);
  });

  it('a suspended organization empties the list even when the body carries no tools', async () => {
    const body = { organization: { id: ORG, name: 'Acme', status: 'suspended' } };
    const list = await cloud({ fetchImpl: fakeHub({ body }).impl }).list(principal);
    expect(list.source).toBe('hub');
    expect(list.apps).toEqual([]);
    expect(list.organization).toEqual({ name: 'Acme', status: 'suspended' });
  });

  it('an older hub naming no organization status is read as active', async () => {
    const body = {
      organization: { id: ORG, name: 'Acme' },
      tools: [
        {
          slug: 'finance',
          name: 'Finance',
          launchUrl: 'https://finance.example.com',
          connected: false,
          open: true
        }
      ]
    };
    const list = await cloud({ fetchImpl: fakeHub({ body }).impl }).list(principal);
    expect(list.apps.map((a) => a.slug)).toEqual(['finance']);
    expect(list.organization).toBeUndefined();
  });

  it('refreshes the grant once on a 401 and retries', async () => {
    const hub = fakeHub({ token: 'tok-2' });
    const tokens = fakeTokens();
    const list = await cloud({ fetchImpl: hub.impl, tokens }).list(principal);
    expect(tokens.invalidateAccess).toHaveBeenCalledWith('usr_1');
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(hub.calls).toHaveLength(2);
    expect(list.source).toBe('hub');
  });

  it('holds the answer five minutes per person and workspace', async () => {
    const hub = fakeHub();
    let now = 1_000_000;
    const service = cloud({ fetchImpl: hub.impl, now: () => now });
    await service.list(principal);
    await service.list(principal);
    expect(hub.calls).toHaveLength(1);
    await service.list({ userId: 'usr_2', workspaceId: 'ws_1' });
    expect(hub.calls).toHaveLength(2);
    // the same person in another workspace is another organization: asked again
    await service.list({ userId: 'usr_1', workspaceId: 'ws_2' });
    expect(hub.calls).toHaveLength(3);
    now += APPS_CACHE_TTL_MS;
    await service.list(principal);
    expect(hub.calls).toHaveLength(4);
  });

  it('falls back to the file when the grant is dead, the hub fails or answers another shape, or the workspace is no hub organization', async () => {
    const file = writeFile([{ slug: 'finance', name: 'F', launchUrl: 'https://f.example.com' }]);
    const dead = await cloud({ appsFile: file, tokens: fakeTokens({ kind: 'grant_dead' }) }).list(principal);
    expect(dead.source).toBe('file');
    const down = await cloud({ appsFile: file, fetchImpl: fakeHub({ status: 503 }).impl }).list(principal);
    expect(down.source).toBe('file');
    const odd = await cloud({ appsFile: file, fetchImpl: fakeHub({ body: { orgs: [] } }).impl }).list(
      principal
    );
    expect(odd.source).toBe('file');
    const local = await cloud({ appsFile: file, db: fakeDb(null), fetchImpl: fakeHub().impl }).list(
      principal
    );
    expect(local.source).toBe('file');
    const noFile = await cloud({ fetchImpl: fakeHub({ status: 503 }).impl }).list(principal);
    expect(noFile.source).toBe('none');
    expect(noFile.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere Account' });
  });

  it('does not hold a failed answer', async () => {
    const hub = fakeHub({ status: 503 });
    const service = cloud({ fetchImpl: hub.impl });
    await service.list(principal);
    await service.list(principal);
    expect(hub.calls).toHaveLength(2);
  });
});

describe('AppsService on a self-hosted instance', () => {
  const oss = (appsFile?: string) =>
    new AppsService({
      db: fakeDb(null),
      logger,
      edition: 'oss',
      appsFile,
      selfSlug: 'yourtool',
      tokens: null
    });

  it('reads the file, the account from its hub entry, never the hub', async () => {
    const file = writeFile([
      { slug: 'hub', name: 'Our account', launchUrl: 'https://account.example.com' },
      { slug: 'finance', name: 'Finance', launchUrl: 'https://f.example.com', icon: 'landmark' },
      { slug: 'yourtool', name: 'Your Tool', launchUrl: 'https://y.example.com' }
    ]);
    const list = await oss(file).list(principal);
    expect(list.source).toBe('file');
    expect(list.hub).toEqual({ url: 'https://account.example.com/', name: 'Our account' });
    expect(list.apps.map((a) => [a.slug, a.current])).toEqual([
      ['finance', false],
      ['yourtool', true]
    ]);
    expect(list.apps[0]!.descriptor).toEqual({ icon: 'landmark' });
  });

  it('lists nothing without a file, or with one that is not JSON', async () => {
    expect(await oss().list(principal)).toEqual({ apps: [], hub: null, source: 'none' });
    const dir = mkdtempSync(join(tmpdir(), 'apps-'));
    const path = join(dir, 'apps.json');
    writeFileSync(path, '{not json');
    expect((await oss(path).list(principal)).source).toBe('none');
  });
});

// ── The handler ──────────────────────────────────────────────────────────────

describe('the GET /apps handler', () => {
  /** The route alone, behind a principal the test sets: the allowlist that refuses machines first is not mounted here. */
  function routeAs(via: Principal['via']) {
    const api = new OpenAPIHono();
    api.use('*', async (c, next) => {
      c.set('principal', {
        ...principal,
        email: 'p@x.test',
        name: 'P',
        role: 'member',
        origin: 'local',
        via
      } as Principal);
      await next();
    });
    const service = { list: vi.fn(async () => ({ apps: [], hub: null, source: 'none' as const })) };
    registerAppsRoutes(api, service as unknown as AppsService);
    return { api, service };
  }

  it('answers a browser session', async () => {
    const { api, service } = routeAs('session');
    const res = await api.request('/apps');
    expect(res.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining(principal));
  });

  it('refuses anything that is not a session itself, 403 session_required, whatever an allowlist would say', async () => {
    for (const via of ['api_key', 'oauth'] as const) {
      const { api, service } = routeAs(via);
      const res = await api.request('/apps');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('session_required');
      expect(service.list).not.toHaveBeenCalled();
    }
  });
});
