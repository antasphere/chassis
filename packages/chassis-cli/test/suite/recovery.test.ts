import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  fresh,
  HUB,
  HUB_KEY,
  kept,
  key,
  meBody,
  namingInstanceRoute,
  ORG,
  seedHub,
  seedHubLogin,
  seedTool,
  TOOL_ACCESS_DENIED,
  wsRow
} from './signin-fixtures.js';

/**
 * A stranded kept key recovers ONCE (PRDCT-2947): a 401 answered to a key
 * the sign-in served runs cli-core's `refreshConnectKey` (compare-and-evict,
 * then the exchange again) and replays the same request with the new key. A
 * second 401 stands; a direct key never recovers; a hub refusal on the way is
 * its own sentence, exit 3.
 */

const { loadConfig } = cli;
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

/**
 * A profile with a kept key of the login at `HUB`, on a site that names no
 * hub (it runs a version from before sites named theirs), and no
 * ANTASPHERE_URL: the kept key's own hub is the only hint of where it signs
 * in, which the recovery must keep after it evicts the key.
 */
async function cachedEnv(): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  seedHubLogin(env);
  seedTool(env, {
    activeProfile: 'work',
    profiles: { work: { baseUrl: 'http://tool', site: fresh(null), hubKeys: [kept(HUB, 'ada@x.co', OLD)] } }
  });
  return env;
}

const trace = (h: ReturnType<typeof routedHarness>) =>
  h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`);

describe('the stranded kept key', () => {
  it('a 401 on a kept key: evict, exchange again at its hub, replay the same request once with the new key', async () => {
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
    expect(loadConfig(env).profiles.work?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: NEW, mintedAt: expect.any(String) }
    ]);
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
    [
      'the key variable',
      { baseUrl: 'http://tool' },
      [],
      { [`${P}_URL`]: 'http://tool', [`${P}_API_KEY`]: OLD }
    ]
  ] as const)('%s never recovers', async (_label, profile, args, extraEnv) => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, { activeProfile: 'work', profiles: { work: profile } });
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

  it('a hub refusal on a first sign-in: its own sentence, no suffix, exit 3', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [
        filesFor([NEW]),
        namingInstanceRoute(HUB),
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

  it('--org <not mine> on a live kept key: bare /me answers, nothing evicted, exchanged or replayed', async () => {
    const env = await cachedEnv();
    const before = loadConfig(env).profiles.work?.hubKeys;
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
    expect(loadConfig(env).profiles.work?.hubKeys).toEqual(before);
    expect(h.err()).toContain(
      `The organization "${NOT_MINE}" (selected by the --org flag) is not one of yours on http://tool; ` +
        'the API key itself works.'
    );
    expect(h.err()).not.toContain('The cached key was refused');
  });

  it('--org with a dead kept key: bare /me refuses too, so the recovery runs and replays once', async () => {
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
    expect(loadConfig(env).profiles.work?.hubKeys?.map((k) => k.apiKey)).toEqual([NEW]);
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
    expect(loadConfig(env).profiles.work?.hubKeys?.map((k) => k.apiKey)).toEqual([OLD]);
    expect(h.err()).not.toContain('The cached key was refused');
  });

  it('without a selection there is no probe: the recovery runs on the first 401', async () => {
    const env = await cachedEnv();
    const h = routedHarness([filesFor([NEW]), cloudInstanceRoute, ...exchangeRoutes([NEW])], env);
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(h.wire.some((c) => c.path === '/api/v1/me')).toBe(false);
  });
});

describe('a kept key of another Antasphere account (PRDCT-3032)', () => {
  const BOB_HUB_KEY = 'ant_bobkey12_secretsecretsecret1234';
  const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '';

  /** The login at the site's hub switched to bob since the key was kept for ada (in the old shape). */
  async function switchedEnv(cached: { apiKey: string; email?: string }, hubEmail: string | undefined) {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: {
        default: { apiKey: BOB_HUB_KEY, baseUrl: HUB, ...(hubEmail ? { email: hubEmail } : {}) }
      }
    });
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', site: fresh(HUB), connectKeys: { default: cached } } }
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
      namingInstanceRoute(HUB),
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

  it('is never sent: revoked on its own site, the exchange runs for the login now in place, the command answers with the new key', async () => {
    const env = await switchedEnv({ apiKey: OLD, email: 'ada@x.co' }, 'bob@x.co');
    const h = routedHarness(routesFor([OLD, NEW]), env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${OLD}`,
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${BOB_HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${NEW}`
    ]);
    expect(h.wire.filter((c) => c.auth === `Bearer ${OLD}`).map((c) => c.method)).toEqual(['DELETE']);
    expect(h.out()).toContain('Ada <ada@x.co>');
    const work = loadConfig(env).profiles.work;
    expect(work?.connectKeys).toBeUndefined();
    expect(work?.hubKeys).toEqual([
      { hub: HUB, email: 'bob@x.co', apiKey: NEW, mintedAt: expect.any(String) }
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(OLD);
  });

  it.each([
    // A key with no address is no login's: it is gone at once.
    ['a kept key with no address', { apiKey: OLD }, 'bob@x.co', 'first'],
    // A login with no address may be the key's own account: nothing is judged until the exchange tells
    // the address (cli-core E3), and then the next command revokes the key of the account it is not.
    ['a login with no address', { apiKey: OLD, email: 'ada@x.co' }, undefined, 'next']
  ] as const)(
    '%s is never served: the exchange mints anew, the login carries the address after, and the key is revoked on its site, at once or once that address says whose it is not (verifier round 1, F1 and F5)',
    async (_label, cached, hubEmail, revokedBy) => {
      const env = await switchedEnv(cached, hubEmail);
      const revoke = `DELETE http://tool/api/v1/cli/auth/key Bearer ${OLD}`;
      const h = routedHarness(routesFor([OLD, NEW]), env);
      expect(await run(['whoami'], h.io)).toBe(0);
      expect(trace(h)).toEqual([
        'GET http://tool/api/v1/instance -',
        ...(revokedBy === 'first' ? [revoke] : []),
        `POST ${HUB}/api/v1/sso/tool-token Bearer ${BOB_HUB_KEY}`,
        'POST http://tool/api/v1/sso/cli-connect -',
        `GET http://tool/api/v1/me Bearer ${NEW}`
      ]);
      // The old key leaves the machine only to be revoked.
      expect(h.wire.filter((c) => c.auth === `Bearer ${OLD}`).map((c) => c.method)).toEqual(
        revokedBy === 'first' ? ['DELETE'] : []
      );
      const work = loadConfig(env).profiles.work;
      expect(work?.hubKeys).toEqual([
        { hub: HUB, email: 'bob@x.co', apiKey: NEW, mintedAt: expect.any(String) }
      ]);
      expect(JSON.stringify(loadConfig(env)).includes(OLD)).toBe(revokedBy === 'next');
      // The login is healed with the address the exchange answered (when it
      // had none), and nothing else of it moves.
      expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
        activeProfile: 'default',
        profiles: { default: { apiKey: BOB_HUB_KEY, baseUrl: HUB, email: 'bob@x.co' } }
      });

      // The next command is served from the kept key, with no hub call; an old key not yet judged is
      // revoked on its site now, as another account's.
      const next = routedHarness(routesFor([NEW]), env);
      expect(await run(['whoami'], next.io)).toBe(0);
      expect(trace(next)).toEqual([
        ...(revokedBy === 'next' ? [revoke] : []),
        `GET http://tool/api/v1/me Bearer ${NEW}`
      ]);
      expect(next.err()).toBe('');
      expect(JSON.stringify(loadConfig(env))).not.toContain(OLD);
    }
  );

  it('the same account in another case is the same account: the kept key is served (verifier M3)', async () => {
    const env = await switchedEnv({ apiKey: OLD, email: 'ada@x.co' }, 'ADA@X.CO');
    const h = routedHarness(routesFor([OLD, NEW]), env);
    expect(await run(['whoami'], h.io)).toBe(0);
    // No DELETE, no exchange: the one call on the wire is the kept key's.
    expect(trace(h)).toEqual([`GET http://tool/api/v1/me Bearer ${OLD}`]);
    expect(h.err()).toBe('');
    expect(loadConfig(env).profiles.work?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: OLD, mintedAt: expect.any(String) }
    ]);
  });
});
