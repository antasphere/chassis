import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { configPath as coreConfigPath, HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  fresh,
  HUB,
  HUB_KEY,
  key,
  meBody,
  meRoute,
  namingInstanceRoute,
  ORG,
  otpRoutes,
  seedHub,
  seedTool
} from './signin-fixtures.js';

/**
 * Which login signs a command in (R2, PRDCT-3521, PRDCT-3392 and PRDCT-3046
 * on the chassis): the login at the hub the SITE names; for a site that names
 * none, the hub `ANTASPHERE_URL` names, else the hub of the profile's kept
 * key. The exchange runs at that login's own hub with its key, the key is
 * kept on the profile filed by that hub and account, and read back from
 * there. The hub file's active login plays no part and never moves. A login
 * with no `baseUrl` of its own is at the default hub (the chassis passes
 * `hubCloudUrl`, verifier round 1, F4).
 */

const { loadConfig } = cli;
const { displayName } = cli.identity;
const DEFAULT_HUB_URL = 'https://account.antasphere.com';
const CLOUD_HUB_KEY = 'ant_cloudk12_secretsecretsecret1234';

/** Two logins on this machine: `cloud` (the active one) at the default hub, `team` at `HUB`. */
function seedTwoHubs(env: Record<string, string>): void {
  seedHub(env, {
    activeProfile: 'cloud',
    profiles: {
      cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL, email: 'ada@x.co' },
      team: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' }
    }
  });
}

const trace = (h: ReturnType<typeof routedHarness>) =>
  h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`);

/** The same routes, every answer that names a user naming `email` instead. */
function answeringAs(routes: Route[], email: string, name = 'Ada'): Route[] {
  return routes.map((r) => ({
    ...r,
    reply: (call: Parameters<Route['reply']>[0]) => {
      const answer = r.reply(call);
      const body = answer.body as Record<string, unknown> | undefined;
      return body && 'user' in body
        ? { ...answer, body: { ...body, user: { ...(body.user as object), email, name } } }
        : answer;
    }
  }));
}

const revokeRoute: Route = {
  method: 'DELETE',
  path: /\/api\/v1\/cli\/auth\/key$/,
  reply: () => ({ body: { revoked: true, id: 'k' } })
};

describe('for a site that names no hub, ANTASPHERE_URL names the one it signs in at (PRDCT-3392)', () => {
  it.each(['http://hub', 'http://hub/', 'HTTP://HUB'])(
    'ANTASPHERE_URL=%s: login exchanges at that hub with its key, the key is kept for that hub, and the next command is served from it',
    async (spelling) => {
      const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: spelling };
      seedTwoHubs(env);
      const minted = key('team');
      const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
      const asked: string[] = [];
      h.io.prompt = async (q) => {
        asked.push(q);
        return '';
      };
      expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
      expect(asked).toEqual([]);
      expect(h.wire.some((c) => c.path.startsWith('/api/v1/cli/auth/'))).toBe(false);
      expect(h.wire.filter((c) => c.path.endsWith('/sso/tool-token'))).toEqual([
        expect.objectContaining({ origin: HUB, auth: `Bearer ${HUB_KEY}` })
      ]);
      expect(h.wire.some((c) => c.auth === `Bearer ${CLOUD_HUB_KEY}`)).toBe(false);
      expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
        { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
      ]);
      // Nothing of the hub's file moved: `cloud` stays the active login.
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe('cloud');

      const next = routedHarness([meRoute()], env);
      expect(await run(['whoami', '--json'], next.io)).toBe(0);
      expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
      expect(JSON.parse(next.out())).toMatchObject({
        credentialSource: 'hub-cache',
        profile: 'tool',
        login: { hub: HUB, email: 'ada@x.co' }
      });
    }
  );

  it('ANTASPHERE_URL naming a hub with no login on this machine: login signs in on THAT hub, writes the login named for its host beside the others, then exchanges there', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHub(env, {
      activeProfile: 'cloud',
      profiles: { cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL, email: 'ada@x.co' } }
    });
    const minted = key('hub');
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([minted]), meRoute()],
      env
    );
    h.io.prompt = async () => '123456';
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const hubConfig = loadCoreConfig(env, HUB_TOOL);
    // The machine's active login never moves (R3): it is `cloud`'s still.
    expect(hubConfig.activeProfile).toBe('cloud');
    expect(hubConfig.profiles.hub).toMatchObject({ apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' });
    expect(hubConfig.profiles.cloud).toEqual({
      apiKey: CLOUD_HUB_KEY,
      baseUrl: DEFAULT_HUB_URL,
      email: 'ada@x.co'
    });
    expect(loadConfig(env).profiles.tool?.hubKeys?.map((k) => k.hub)).toEqual([HUB]);
  });
});

describe('a login with no baseUrl is at the default hub (verifier round 1, F4)', () => {
  /** A pre-`baseUrl` login, active, and ANTASPHERE_URL naming the default hub. */
  async function legacyEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: DEFAULT_HUB_URL };
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, email: 'ada@x.co' } }
    });
    return env;
  }

  it('an old-shape key filed under that login is moved and served: zero hub calls', async () => {
    const env = await legacyEnv();
    const cached = key('cached');
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: {
          baseUrl: 'http://tool',
          site: fresh(null),
          connectKeys: { default: { apiKey: cached, email: 'ada@x.co' } }
        }
      }
    });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('new')]), meRoute()], env);
    expect(await run(['whoami', '--json'], h.io)).toBe(0);
    expect(trace(h)).toEqual([`GET http://tool/api/v1/me Bearer ${cached}`]);
    expect(JSON.parse(h.out())).toMatchObject({
      credentialSource: 'hub-cache',
      login: { hub: DEFAULT_HUB_URL, email: 'ada@x.co' }
    });
    // The one move of the old slot (cli-core): the key is kept for that hub and account now.
    const work = loadConfig(env).profiles.work;
    expect(work?.connectKeys).toBeUndefined();
    expect(work?.hubKeys).toEqual([
      { hub: DEFAULT_HUB_URL, email: 'ada@x.co', apiKey: cached, mintedAt: expect.any(String) }
    ]);
  });

  it('a 401 on that kept key: evicted, a fresh exchange at the default hub, the replay with the new key', async () => {
    const env = await legacyEnv();
    const cached = key('cached');
    const minted = key('new');
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: {
          baseUrl: 'http://tool',
          site: fresh(null),
          connectKeys: { default: { apiKey: cached, email: 'ada@x.co' } }
        }
      }
    });
    const me: Route = {
      method: 'GET',
      path: /\/api\/v1\/me$/,
      reply: ({ headers }) =>
        headers.get('authorization') === `Bearer ${minted}`
          ? { body: meBody() }
          : { status: 401, body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } } }
    };
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), me], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `GET http://tool/api/v1/me Bearer ${cached}`,
      'GET http://tool/api/v1/instance -',
      `POST ${DEFAULT_HUB_URL}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(loadConfig(env).profiles.work?.hubKeys).toEqual([
      { hub: DEFAULT_HUB_URL, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(cached);
  });

  it('without a kept key it exchanges at the default hub with its own key, and the key is kept for that hub', async () => {
    const env = await legacyEnv();
    const minted = key('new');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${DEFAULT_HUB_URL}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
      { hub: DEFAULT_HUB_URL, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
    // The login carried its address: nothing of the hub's file moves.
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, email: 'ada@x.co' } }
    });
  });

  it('login finds that stored login: no email code is asked, the exchange runs at the default hub with its key', async () => {
    const env = await legacyEnv();
    const minted = key('new');
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(key('otp')), ...exchangeRoutes([minted]), meRoute()],
      env
    );
    const asked: string[] = [];
    h.io.prompt = async (q) => {
      asked.push(q);
      return '';
    };
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual([]);
    expect(h.wire.some((c) => c.path === '/api/v1/cli/auth/request')).toBe(false);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/tool-token'))).toEqual([
      expect.objectContaining({ origin: DEFAULT_HUB_URL, auth: `Bearer ${HUB_KEY}` })
    ]);
    expect(loadConfig(env).profiles.tool?.hubKeys?.map((k) => k.hub)).toEqual([DEFAULT_HUB_URL]);
  });

  it('logout --all revokes the login the profile’s key came from at the default hub, and forgets it', async () => {
    const env = await legacyEnv();
    const toolKey = key('cached');
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: toolKey, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${toolKey}`,
      `DELETE ${DEFAULT_HUB_URL}/api/v1/cli/auth/key Bearer ${HUB_KEY}`
    ]);
    expect(h.out()).toContain(
      `The Antasphere login ada@x.co at ${DEFAULT_HUB_URL} is revoked and forgotten.`
    );
    expect(loadCoreConfig(env, HUB_TOOL).profiles).toEqual({});
  });

  it('plain logout with no profile of the tool names the command that ends that login, nothing sent', async () => {
    const env = await legacyEnv();
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Nothing of ${displayName}'s to sign out of on this machine. The Antasphere login ada@x.co at ` +
        `${DEFAULT_HUB_URL} stays for the whole tool family: \`antasphere logout\` ends it.\n`
    );
    expect(h.wire).toEqual([]);
  });
});

describe('logout --all ends the login the profile’s keys came from, and that one only', () => {
  it('a key of the `team` login: `team` is revoked at its hub and forgotten; `cloud`, the active login, and its key stay', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedTwoHubs(env);
    const toolKey = key('team');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: {
        tool: { baseUrl: 'http://tool', connectKeys: { team: { apiKey: toolKey, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${toolKey}`,
      `DELETE ${HUB}/api/v1/cli/auth/key Bearer ${HUB_KEY}`
    ]);
    expect(h.wire.some((c) => c.auth === `Bearer ${CLOUD_HUB_KEY}`)).toBe(false);
    expect(h.out()).toContain(`The Antasphere login ada@x.co at ${HUB} is revoked and forgotten.`);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'cloud',
      profiles: { cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL, email: 'ada@x.co' } }
    });
    expect(loadConfig(env).profiles.tool).toEqual({ baseUrl: 'http://tool' });
  });
});

describe('logout --all revokes the hub key at the hub', () => {
  it('a login with no baseUrl: the hub key is revoked at the default hub, and no request carrying it reaches the tool', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, email: 'ada@x.co' } }
    });
    const toolKey = key('cached');
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: toolKey, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${toolKey}`,
      `DELETE ${DEFAULT_HUB_URL}/api/v1/cli/auth/key Bearer ${HUB_KEY}`
    ]);
    expect(h.wire.filter((c) => c.auth === `Bearer ${HUB_KEY}`).map((c) => c.origin)).toEqual([
      DEFAULT_HUB_URL
    ]);
    expect(h.wire.some((c) => c.origin !== 'http://tool' && c.auth === `Bearer ${toolKey}`)).toBe(false);
    expect(h.wire.some((c) => c.origin === new URL(cli.identity.cloudUrl).origin)).toBe(false);
    expect(loadCoreConfig(env, HUB_TOOL).profiles).toEqual({});
  });
});

describe('a login without its address is healed by the first fresh exchange', () => {
  it('login on a login with no email: one exchange, the address the hub answered written onto that login only, the next command served from the kept key', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHub(env, {
      activeProfile: 'cloud',
      profiles: {
        cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL },
        team: { apiKey: HUB_KEY, baseUrl: HUB }
      }
    });
    const minted = key('team');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    // An absent address is filled in silently.
    expect(h.err()).not.toContain("The Antasphere login's address is now");
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'cloud',
      profiles: {
        cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL },
        team: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' }
      }
    });

    const next = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('again')]), meRoute()], env);
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(next.err()).toBe('');
  });

  it("a stale address (the account changed it at the hub): one mint, the login at the hub's answer, said on stderr, the next run served from the kept key with no DELETE", async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const minted = key('new');
    const routes = answeringAs(
      [namingInstanceRoute(HUB), ...exchangeRoutes([minted]), meRoute()],
      'ada@new.co'
    );
    const h = routedHarness(routes, env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    expect(h.err()).toContain(
      "The Antasphere login's address is now ada@new.co, replaced from ada@x.co (the hub's own answer).\n"
    );
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@new.co' } }
    });
    expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@new.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);

    for (let i = 0; i < 2; i++) {
      const next = routedHarness(
        answeringAs([namingInstanceRoute(HUB), ...exchangeRoutes([key('again')]), meRoute()], 'ada@new.co'),
        env
      );
      expect(await run(['whoami'], next.io)).toBe(0);
      expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
      expect(next.err()).toBe('');
    }
  });

  it('a blank address is healed like an absent one, silently: the old key is never served, and once the healed address says it is the older key of its account the next command revokes it on its site; no sentence carries the blank', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: '  ' } }
    });
    const old = key('old');
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: old, email: 'ada@x.co' } } }
      }
    });
    const minted = key('new');
    const h = routedHarness(
      [revokeRoute, namingInstanceRoute(HUB), ...exchangeRoutes([minted]), meRoute()],
      env
    );
    expect(await run(['whoami'], h.io)).toBe(0);
    // A login with no address cannot say whose the old key is: it is never served, and nothing is revoked
    // until the exchange tells the address (cli-core E3).
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.err()).not.toMatch(/ {2}/);
    expect(h.err()).not.toContain('is retired');
    expect(h.err()).not.toContain("The Antasphere login's address is now");
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default).toEqual({
      apiKey: HUB_KEY,
      baseUrl: HUB,
      email: 'ada@x.co'
    });

    // The address told, the old key is the older of ada's two: the next command revokes it on its site,
    // never the one just minted, and serves that one.
    const next = routedHarness(
      [revokeRoute, namingInstanceRoute(HUB), ...exchangeRoutes([key('again')]), meRoute()],
      env
    );
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${old}`,
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(old);
  });

  it('the address changed at the hub under a live kept key: the recovery mints once and heals, the next run is served with no DELETE (verifier round 2, F1)', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const live = key('live');
    // A site that names no hub, and no ANTASPHERE_URL: the kept key's own
    // hub is the only hint, and the recovery keeps it after the eviction.
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: {
          baseUrl: 'http://tool',
          site: fresh(null),
          connectKeys: { default: { apiKey: live, email: 'ada@x.co' } }
        }
      }
    });
    const minted = key('new');
    const me: Route = {
      method: 'GET',
      path: /\/api\/v1\/me$/,
      reply: ({ headers }) =>
        headers.get('authorization') === `Bearer ${minted}`
          ? { body: meBody() }
          : { status: 401, body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } } }
    };
    const routes = [
      revokeRoute,
      me,
      ...answeringAs([cloudInstanceRoute, ...exchangeRoutes([minted])], 'ada@new.co')
    ];

    const a = routedHarness(routes, env);
    expect(await run(['whoami'], a.io)).toBe(0);
    expect(trace(a)).toEqual([
      `GET http://tool/api/v1/me Bearer ${live}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(a.err()).toBe(
      'Connected to http://tool as ada@new.co via Antasphere.\n' +
        'The cached key was refused; signed in again through Antasphere.\n' +
        "The Antasphere login's address is now ada@new.co, replaced from ada@x.co (the hub's own answer).\n"
    );
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.email).toBe('ada@new.co');

    const b = routedHarness(routes, env);
    expect(await run(['whoami'], b.io)).toBe(0);
    expect(trace(b)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(b.wire.some((c) => c.method === 'DELETE')).toBe(false);
    expect(b.err()).toBe('');
  });

  it('a stored address in another case is the same address: one fresh exchange writes nothing, says nothing, and the next run is served (verifier round 2, F2)', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ADA@X.CO' } }
    });
    const hubFile = coreConfigPath(env, HUB_TOOL)!;
    const before = readFileSync(hubFile, 'utf8');
    const minted = key('new');
    const h = routedHarness([namingInstanceRoute(HUB), ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    expect(readFileSync(hubFile, 'utf8')).toBe(before);
    expect(h.err()).not.toContain("The Antasphere login's address is now");

    const next = routedHarness([namingInstanceRoute(HUB), ...exchangeRoutes([key('again')]), meRoute()], env);
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(next.err()).toBe('');
  });

  it('a blank answered address is never written: the login unchanged, no line, the key kept under the login’s own address (verifier round 2, F3)', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const hubFile = coreConfigPath(env, HUB_TOOL)!;
    const before = readFileSync(hubFile, 'utf8');
    const minted = key('new');
    const h = routedHarness(
      [meRoute(), ...answeringAs([namingInstanceRoute(HUB), ...exchangeRoutes([minted])], '')],
      env
    );
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(readFileSync(hubFile, 'utf8')).toBe(before);
    expect(h.err()).not.toContain("The Antasphere login's address is now");
    expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
  });
});

describe('login --email on a stored login with no address is a switch (verifier round 1, F2)', () => {
  it.each([
    ['absent', {}],
    ['blank', { email: '  ' }]
  ] as const)(
    "a hub key with its address %s and --email bob: bob signs in afresh at that hub, the exchange runs with bob's key, the old key only goes back to its hub to die",
    async (_label, address) => {
      const ADA_KEY = 'ant_adakey12_secretsecretsecret1234';
      const BOB_KEY = 'ant_bobkey12_secretsecretsecret1234';
      const env = await tempConfigEnv();
      seedHub(env, {
        activeProfile: 'default',
        profiles: { default: { apiKey: ADA_KEY, baseUrl: HUB, ...address } }
      });
      const minted = key('bob');
      const h = routedHarness(
        answeringAs(
          [namingInstanceRoute(HUB), ...otpRoutes(BOB_KEY, ORG), ...exchangeRoutes([minted]), meRoute()],
          'bob@x.co',
          'Bob'
        ),
        env
      );
      h.io.prompt = async () => '123456';
      expect(await run(['login', '--api-url', 'http://tool', '--email', 'bob@x.co'], h.io)).toBe(0);
      expect(h.wire.filter((c) => c.path === '/api/v1/cli/auth/request')).toEqual([
        expect.objectContaining({ origin: HUB, body: { email: 'bob@x.co' } })
      ]);
      expect(h.wire.filter((c) => c.path.endsWith('/sso/tool-token'))).toEqual([
        expect.objectContaining({ origin: HUB, auth: `Bearer ${BOB_KEY}` })
      ]);
      // The replaced hub key is revoked at its own hub (ruling 3), and goes nowhere else.
      expect(trace(h).filter((line) => line.includes(ADA_KEY))).toEqual([
        `DELETE ${HUB}/api/v1/cli/auth/key Bearer ${ADA_KEY}`
      ]);
      expect(h.err()).toContain('Signing in as bob@x.co: the stored Antasphere login carries no address.\n');
      expect(h.err()).not.toMatch(/ {2}/);
      expect(loadCoreConfig(env, HUB_TOOL).profiles.default).toMatchObject({
        apiKey: BOB_KEY,
        baseUrl: HUB,
        email: 'bob@x.co'
      });
      expect(h.out()).toContain('Signed in as Bob <bob@x.co>');
      expect(h.out()).not.toContain('ada@x.co');
    }
  );
});

describe('profiles names who signs each profile in, from its own keys, never the active login (PRDCT-3522)', () => {
  it('a key of the `cloud` login, under ANTASPHERE_URL naming another hub: the listing names `cloud`’s account and hub', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedTwoHubs(env);
    seedTool(env, {
      activeProfile: 'tool',
      profiles: {
        tool: { baseUrl: 'http://tool', connectKeys: { cloud: { apiKey: key('cloud'), email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(h.out()).toContain(`signed in: ada@x.co at ${DEFAULT_HUB_URL}`);
    // The variable is said beside the state, never folded into it.
    expect(h.out()).toContain(
      `ANTASPHERE_URL is exported: profiles whose site names no hub sign in at ${HUB}.`
    );
    expect(h.out()).not.toContain(key('cloud').slice(0, 13));
    expect(h.wire).toEqual([]);
  });
});
