import { describe, expect, it } from 'vitest';
import { HUB_TOOL, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meBody,
  ORG,
  seedHubLogin,
  TOOL_ACCESS_DENIED,
  wsRow
} from './signin-fixtures.js';

/**
 * A stranded cached key recovers ONCE (PRDCT-2947): a 401 answered to a key
 * the connect cache served evicts it, runs the exchange again, and replays
 * the same request with the new key. A second 401 stands; a direct key
 * never recovers; a hub refusal on the way is its own sentence, exit 3.
 */

const { loadConfig, saveConfig } = cli;
const { bin, envPrefix: P, displayName } = cli.identity;

const OLD = key('old');
const NEW = key('new');

/** GET /files: 200 for the keys in `good`, else 401. */
function filesFor(good: string[]): Route {
  return {
    method: 'GET',
    path: /\/api\/v1\/files$/,
    reply: ({ headers }) =>
      good.includes(headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '')
        ? { body: { files: [], nextCursor: null } }
        : { status: 401, body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } } }
  };
}

async function cachedEnv(): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  seedHubLogin(env);
  saveConfig(env, {
    activeProfile: 'work',
    profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: OLD } } } }
  });
  return env;
}

const trace = (h: ReturnType<typeof routedHarness>) =>
  h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`);

describe('the stranded cached key', () => {
  it('a 401 on a cached key: evict, exchange again, replay the same request once with the new key', async () => {
    const env = await cachedEnv();
    const h = routedHarness([filesFor([NEW]), cloudInstanceRoute, ...exchangeRoutes([NEW])], env);
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `GET http://tool/api/v1/files Bearer ${OLD}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/files Bearer ${NEW}`
    ]);
    expect(h.err()).toContain('The cached key was refused; signed in again through Antasphere.\n');
    expect(h.out()).toContain('No files.');
    const work = loadConfig(env).profiles.work;
    expect(work?.connectKeys?.default?.apiKey).toBe(NEW);
    expect(JSON.stringify(loadConfig(env))).not.toContain(OLD);
  });

  it('a second 401 stands: the plain error, one recovery only', async () => {
    const env = await cachedEnv();
    const h = routedHarness([filesFor([]), cloudInstanceRoute, ...exchangeRoutes([NEW])], env);
    expect(await run(['files', 'list'], h.io)).toBe(1);
    expect(h.wire.filter((c) => c.path === '/api/v1/files').map((c) => c.auth)).toEqual([
      `Bearer ${OLD}`,
      `Bearer ${NEW}`
    ]);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/tool-token'))).toHaveLength(1);
    expect(h.err()).toContain(`Error: API key not recognized (check the key: \`${bin} verify\`)\n`);
  });

  it.each([
    ['the profile key', { apiKey: OLD, baseUrl: 'http://tool' }, [], {}],
    ['the --api-key flag', { baseUrl: 'http://tool' }, ['--api-key', OLD], {}],
    ['the key variable', { baseUrl: 'http://tool' }, [], { [`${P}_API_KEY`]: OLD }]
  ] as const)('%s never recovers', async (_label, profile, args, extraEnv) => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, { activeProfile: 'work', profiles: { work: profile } });
    const h = routedHarness([filesFor([NEW]), cloudInstanceRoute, ...exchangeRoutes([NEW])], {
      ...env,
      ...extraEnv
    });
    expect(await run(['files', 'list', ...args], h.io)).toBe(1);
    expect(trace(h)).toEqual([`GET http://tool/api/v1/files Bearer ${OLD}`]);
    expect(h.err()).not.toContain('signed in again');
  });

  it('a hub refusal during the recovery: its own sentence, exit 3', async () => {
    const env = await cachedEnv();
    const h = routedHarness(
      [
        filesFor([NEW]),
        cloudInstanceRoute,
        ...exchangeRoutes([NEW], { toolToken: () => TOOL_ACCESS_DENIED })
      ],
      env
    );
    expect(await run(['files', 'list'], h.io)).toBe(3);
    expect(h.err()).toBe(`Error: This account has no access to ${displayName} in any of its organizations\n`);
  });

  it('a hub refusal on a first connect: its own sentence, no suffix, exit 3', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [
        filesFor([NEW]),
        cloudInstanceRoute,
        ...exchangeRoutes([NEW], { toolToken: () => TOOL_ACCESS_DENIED })
      ],
      env
    );
    expect(await run(['files', 'list', '--api-url', 'http://tool'], h.io)).toBe(3);
    expect(h.err()).toBe(`Error: This account has no access to ${displayName} in any of its organizations\n`);
    expect(loadConfig(env).profiles.tool).toBeUndefined();
  });
});

describe('a refused selection is not a dead key (verifier round 1, F2)', () => {
  const NOT_MINE = '99999999-9999-4999-8999-999999999999';
  const UNAUTHORIZED = {
    status: 401,
    body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
  };
  const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '';
  const traceWs = (h: ReturnType<typeof routedHarness>) =>
    h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'} ${c.workspace ?? '-'}`);

  it('--org <not mine> on a live cached key: bare /me answers, nothing evicted, exchanged or replayed', async () => {
    const env = await cachedEnv();
    const before = loadConfig(env).profiles.work?.connectKeys;
    const h = routedHarness(
      [
        {
          method: 'GET',
          path: /\/api\/v1\/files$/,
          // The server answers a workspace the person is not in like an unknown key.
          reply: ({ headers }) =>
            headers.get('x-workspace-id') ? UNAUTHORIZED : { body: { files: [], nextCursor: null } }
        },
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: ({ headers }) =>
            bearer(headers) === OLD && !headers.get('x-workspace-id') ? { body: meBody() } : UNAUTHORIZED
        },
        cloudInstanceRoute,
        ...exchangeRoutes([NEW])
      ],
      env
    );
    expect(await run(['files', 'list', '--org', NOT_MINE], h.io)).toBe(1);
    expect(traceWs(h)).toEqual([
      `GET http://tool/api/v1/files Bearer ${OLD} ${NOT_MINE}`,
      `GET http://tool/api/v1/me Bearer ${OLD} -`,
      `GET http://tool/api/v1/me Bearer ${OLD} -`
    ]);
    expect(h.wire.some((c) => c.path.endsWith('/sso/tool-token'))).toBe(false);
    expect(h.wire.some((c) => c.path.endsWith('/sso/cli-connect'))).toBe(false);
    expect(loadConfig(env).profiles.work?.connectKeys).toEqual(before);
    expect(loadConfig(env).profiles.work?.connectKeys?.default?.apiKey).toBe(OLD);
    expect(h.err()).toContain(
      `The organization "${NOT_MINE}" (selected by the --org flag) is not one of yours on http://tool; ` +
        'the API key itself works.'
    );
    expect(h.err()).not.toContain('The cached key was refused');
  });

  it('--org with a dead cached key: bare /me refuses too, so the recovery runs and replays once', async () => {
    const env = await cachedEnv();
    const h = routedHarness(
      [
        filesFor([NEW]),
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: ({ headers }) => (bearer(headers) === NEW ? { body: meBody() } : UNAUTHORIZED)
        },
        cloudInstanceRoute,
        ...exchangeRoutes([NEW])
      ],
      env
    );
    expect(await run(['files', 'list', '--org', NOT_MINE], h.io)).toBe(0);
    expect(traceWs(h)).toEqual([
      `GET http://tool/api/v1/files Bearer ${OLD} ${NOT_MINE}`,
      `GET http://tool/api/v1/me Bearer ${OLD} -`,
      'GET http://tool/api/v1/instance - -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY} -`,
      'POST http://tool/api/v1/sso/cli-connect - -',
      `GET http://tool/api/v1/files Bearer ${NEW} ${NOT_MINE}`
    ]);
    expect(h.err()).toContain('The cached key was refused; signed in again through Antasphere.\n');
    expect(loadConfig(env).profiles.work?.connectKeys?.default?.apiKey).toBe(NEW);
  });

  it('F10: a bare /me probe with no answer keeps the key: no eviction, no exchange, the 401 stands', async () => {
    const env = await cachedEnv();
    const h = routedHarness(
      [
        filesFor([]),
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: () => {
            throw new TypeError('fetch failed');
          }
        },
        cloudInstanceRoute,
        ...exchangeRoutes([NEW])
      ],
      env
    );
    expect(await run(['files', 'list', '--org', NOT_MINE], h.io)).toBe(1);
    expect(h.wire.some((c) => c.path.endsWith('/sso/tool-token'))).toBe(false);
    expect(h.wire.some((c) => c.path.endsWith('/sso/cli-connect'))).toBe(false);
    expect(h.wire.filter((c) => c.path.endsWith('/api/v1/files'))).toHaveLength(1);
    expect(loadConfig(env).profiles.work?.connectKeys?.default?.apiKey).toBe(OLD);
    expect(h.err()).not.toContain('The cached key was refused');
  });

  it('without a selection there is no probe: the recovery runs on the first 401', async () => {
    const env = await cachedEnv();
    const h = routedHarness([filesFor([NEW]), cloudInstanceRoute, ...exchangeRoutes([NEW])], env);
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(h.wire.some((c) => c.path === '/api/v1/me')).toBe(false);
  });
});

describe('a cached key of another Antasphere account (PRDCT-3032)', () => {
  const BOB_HUB_KEY = 'ant_bobkey12_secretsecretsecret1234';
  const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '';

  /** The hub login switched to bob since the key was cached for ada. */
  async function switchedEnv(cached: { apiKey: string; email?: string }, hubEmail: string | undefined) {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: {
        default: { apiKey: BOB_HUB_KEY, baseUrl: HUB, ...(hubEmail ? { email: hubEmail } : {}) }
      }
    });
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: cached } } }
    });
    return env;
  }

  /** `/me` for the given keys only, else 401; the cli-connect answer naming bob. */
  function routesFor(good: string[]): Route[] {
    return [
      {
        method: 'GET',
        path: /\/api\/v1\/me$/,
        reply: ({ headers }) =>
          good.includes(bearer(headers))
            ? {
                body: meBody({
                  workspaces: [wsRow('w1', 'Acme', { default: true, hubOrigin: true, centralAccountId: ORG })]
                })
              }
            : { status: 401, body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } } }
      },
      {
        method: 'DELETE',
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: () => ({ body: { revoked: true, id: 'k' } })
      },
      cloudInstanceRoute,
      ...exchangeRoutes([NEW]).map((r) => ({
        ...r,
        reply: (call: Parameters<Route['reply']>[0]) => {
          const answer = r.reply(call);
          const body = answer.body as Record<string, unknown>;
          return 'user' in body
            ? { ...answer, body: { ...body, user: { ...(body.user as object), email: 'bob@x.co' } } }
            : answer;
        }
      }))
    ];
  }

  it('is never sent: retired on stderr, revoked on the instance, the exchange runs for the new login, the command answers with the new key', async () => {
    const env = await switchedEnv({ apiKey: OLD, email: 'ada@x.co' }, 'bob@x.co');
    const h = routedHarness(routesFor([OLD, NEW]), env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.err()).toContain(
      `The ${displayName} key cached for ada@x.co is retired: the Antasphere login is now bob@x.co.\n`
    );
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${OLD}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${BOB_HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${NEW}`
    ]);
    expect(h.wire.filter((c) => c.auth === `Bearer ${OLD}`).map((c) => c.method)).toEqual(['DELETE']);
    expect(h.out()).toContain('Ada <ada@x.co>');
    const work = loadConfig(env).profiles.work;
    expect(Object.keys(work?.connectKeys ?? {})).toEqual(['default']);
    expect(work?.connectKeys?.default).toMatchObject({ apiKey: NEW, email: 'bob@x.co' });
    expect(JSON.stringify(loadConfig(env))).not.toContain(OLD);
  });

  it('a cache entry with no email, or a hub login with none, is trusted as before', async () => {
    for (const [cached, hubEmail] of [
      [{ apiKey: OLD }, 'bob@x.co'],
      [{ apiKey: OLD, email: 'ada@x.co' }, undefined]
    ] as const) {
      const env = await switchedEnv(cached, hubEmail);
      const h = routedHarness(routesFor([OLD, NEW]), env);
      expect(await run(['whoami'], h.io)).toBe(0);
      expect(trace(h)).toEqual([`GET http://tool/api/v1/me Bearer ${OLD}`]);
      expect(h.err()).not.toContain('is retired');
      expect(loadConfig(env).profiles.work?.connectKeys?.default?.apiKey).toBe(OLD);
    }
  });

  it('the same account in another case is the same account: the cached key is served (verifier M3)', async () => {
    const env = await switchedEnv({ apiKey: OLD, email: 'ada@x.co' }, 'ADA@X.CO');
    const h = routedHarness(routesFor([OLD, NEW]), env);
    expect(await run(['whoami'], h.io)).toBe(0);
    // No DELETE, no exchange: the one call on the wire is the cached key's.
    expect(trace(h)).toEqual([`GET http://tool/api/v1/me Bearer ${OLD}`]);
    expect(h.err()).toBe('');
    expect(loadConfig(env).profiles.work?.connectKeys?.default).toMatchObject({
      apiKey: OLD,
      email: 'ada@x.co'
    });
  });
});
