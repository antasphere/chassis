import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  configPath as coreConfigPath,
  HUB_TOOL,
  loadConfig as loadCoreConfig,
  saveConfig as saveCoreConfig
} from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meBody,
  meRoute,
  ORG,
  otpRoutes
} from './signin-fixtures.js';

/**
 * The hub profile of a run is the one `ANTASPHERE_URL` names (PRDCT-3392 and
 * PRDCT-3046 on the chassis, cli-core 0.6.0 `selectHubProfile`): the
 * exchange runs at that hub with that hub's key, its key is cached under
 * that profile's slot, and the cache is read from the same slot. The active
 * hub profile's key never travels when the variable names another hub. A
 * hub profile with no `baseUrl` of its own is at the default hub (the
 * chassis passes `hubCloudUrl`, verifier round 1, F4).
 */

const { loadConfig, saveConfig } = cli;
const { bin, displayName } = cli.identity;
const DEFAULT_HUB_URL = 'https://account.antasphere.com';
const CLOUD_HUB_KEY = 'ant_cloudk12_secretsecretsecret1234';

/** Two hub logins on this machine: `cloud` (active) at the default hub, `team` at `HUB`. */
function seedTwoHubs(env: Record<string, string>): void {
  saveCoreConfig(env, HUB_TOOL, {
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

describe('the hub profile ANTASPHERE_URL names (PRDCT-3392)', () => {
  it.each(['http://hub', 'http://hub/', 'HTTP://HUB'])(
    'ANTASPHERE_URL=%s: login exchanges at that hub with its key into its slot, and the next command is served from that slot',
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
      const connectKeys = loadConfig(env).profiles.tool?.connectKeys ?? {};
      expect(Object.keys(connectKeys)).toEqual(['team']);
      expect(connectKeys.team).toMatchObject({ apiKey: minted, email: 'ada@x.co' });
      // Nothing of the hub's file moved: `cloud` stays the active hub login.
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe('cloud');

      const next = routedHarness([meRoute()], env);
      expect(await run(['whoami', '--json'], next.io)).toBe(0);
      expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
      expect(JSON.parse(next.out())).toMatchObject({
        credentialSource: 'hub-cache',
        profile: 'tool',
        hubLogin: { profile: 'team', email: 'ada@x.co' }
      });
    }
  );

  it('ANTASPHERE_URL naming a hub with no profile on disk: login signs in inline on THAT hub, writes the profile named for its host, then exchanges there', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    saveCoreConfig(env, HUB_TOOL, {
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
    expect(hubConfig.activeProfile).toBe('hub');
    expect(hubConfig.profiles.hub).toMatchObject({ apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' });
    expect(hubConfig.profiles.cloud).toEqual({
      apiKey: CLOUD_HUB_KEY,
      baseUrl: DEFAULT_HUB_URL,
      email: 'ada@x.co'
    });
    expect(Object.keys(loadConfig(env).profiles.tool?.connectKeys ?? {})).toEqual(['hub']);
  });
});

describe('a hub profile with no baseUrl is at the default hub (verifier round 1, F4)', () => {
  /** A pre-`baseUrl` hub login, active, and ANTASPHERE_URL naming the default hub. */
  async function legacyEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: DEFAULT_HUB_URL };
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, email: 'ada@x.co' } }
    });
    return env;
  }

  it('a key cached under that profile is served from the cache: zero hub calls', async () => {
    const env = await legacyEnv();
    const cached = key('cached');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: cached, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('new')]), meRoute()], env);
    expect(await run(['whoami', '--json'], h.io)).toBe(0);
    expect(trace(h)).toEqual([`GET http://tool/api/v1/me Bearer ${cached}`]);
    expect(JSON.parse(h.out())).toMatchObject({
      credentialSource: 'hub-cache',
      hubLogin: { profile: 'default', email: 'ada@x.co' }
    });
  });

  it('a 401 on that cached key: evicted from the slot it was read from, a fresh exchange at the default hub, the replay with the new key under the same slot', async () => {
    const env = await legacyEnv();
    const cached = key('cached');
    const minted = key('new');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: cached, email: 'ada@x.co' } } }
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
      `POST ${new URL(DEFAULT_HUB_URL).origin}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const connectKeys = loadConfig(env).profiles.work?.connectKeys ?? {};
    expect(Object.keys(connectKeys)).toEqual(['default']);
    expect(connectKeys.default).toMatchObject({ apiKey: minted, email: 'ada@x.co' });
    expect(JSON.stringify(loadConfig(env))).not.toContain(cached);
  });

  it('without a cached key it exchanges at the default hub with its own key, and the connect key lands under its slot', async () => {
    const env = await legacyEnv();
    const minted = key('new');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${new URL(DEFAULT_HUB_URL).origin}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const connectKeys = loadConfig(env).profiles.tool?.connectKeys ?? {};
    expect(Object.keys(connectKeys)).toEqual(['default']);
    expect(connectKeys.default).toMatchObject({ apiKey: minted, email: 'ada@x.co' });
    // The profile carried its address: nothing of the hub's file moves.
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
      expect.objectContaining({ origin: new URL(DEFAULT_HUB_URL).origin, auth: `Bearer ${HUB_KEY}` })
    ]);
    expect(Object.keys(loadConfig(env).profiles.tool?.connectKeys ?? {})).toEqual(['default']);
  });

  it('logout --all revokes that login at the default hub and forgets it', async () => {
    const env = await legacyEnv();
    const toolKey = key('cached');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: toolKey, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${toolKey}`,
      `DELETE ${new URL(DEFAULT_HUB_URL).origin}/api/v1/cli/auth/key Bearer ${HUB_KEY}`
    ]);
    expect(h.out()).toContain('The Antasphere login ada@x.co is revoked and forgotten.');
    expect(loadCoreConfig(env, HUB_TOOL).profiles).toEqual({});
  });

  it('plain logout with no profile of the tool names the two commands that end that login, nothing sent', async () => {
    const env = await legacyEnv();
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Nothing of ${displayName}'s to sign out of on this machine. The Antasphere login ada@x.co ` +
        `stays for the whole tool family: \`${bin} logout --all\` or \`antasphere logout\` ends it.\n`
    );
    expect(h.wire).toEqual([]);
  });
});

describe('logout --all ends the hub login ANTASPHERE_URL names', () => {
  it('under ANTASPHERE_URL=http://hub: the `team` login is revoked on its hub and forgotten, `cloud` and its key stay', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedTwoHubs(env);
    const toolKey = key('team');
    saveConfig(env, {
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
    expect(h.out()).toContain('The Antasphere login ada@x.co is revoked and forgotten.');
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'cloud',
      profiles: { cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: DEFAULT_HUB_URL, email: 'ada@x.co' } }
    });
    expect(loadConfig(env).profiles.tool?.connectKeys ?? {}).toEqual({});
  });
});

describe('logout --all revokes the hub key at the hub', () => {
  it('a hub profile with no baseUrl: the hub key is revoked at the default hub, and no request carrying it reaches the tool', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, email: 'ada@x.co' } }
    });
    const toolKey = key('cached');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: toolKey, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${toolKey}`,
      `DELETE ${new URL(DEFAULT_HUB_URL).origin}/api/v1/cli/auth/key Bearer ${HUB_KEY}`
    ]);
    expect(h.wire.filter((c) => c.auth === `Bearer ${HUB_KEY}`).map((c) => c.origin)).toEqual([
      new URL(DEFAULT_HUB_URL).origin
    ]);
    expect(h.wire.some((c) => c.origin !== 'http://tool' && c.auth === `Bearer ${toolKey}`)).toBe(false);
    expect(h.wire.some((c) => c.origin === new URL(cli.identity.cloudUrl).origin)).toBe(false);
    expect(loadCoreConfig(env, HUB_TOOL).profiles).toEqual({});
  });
});

describe('a hub profile without its address is healed by the first fresh exchange', () => {
  it('login on a hub profile with no email: one exchange, the address the hub answered written onto that profile only, the next command served from the cache', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    saveCoreConfig(env, HUB_TOOL, {
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

  it("a stale address (the account changed it at the hub): one mint, the profile at the hub's answer, said on stderr, the next run served from the cache with no DELETE", async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const minted = key('new');
    const routes = answeringAs([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], 'ada@new.co');
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
    expect(loadConfig(env).profiles.tool?.connectKeys?.default).toMatchObject({
      apiKey: minted,
      email: 'ada@new.co'
    });

    for (let i = 0; i < 2; i++) {
      const next = routedHarness(
        answeringAs([cloudInstanceRoute, ...exchangeRoutes([key('again')]), meRoute()], 'ada@new.co'),
        env
      );
      expect(await run(['whoami'], next.io)).toBe(0);
      expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
      expect(next.err()).toBe('');
    }
  });

  it('a blank address is healed like an absent one, silently, and no sentence carries the blank', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: '  ' } }
    });
    const old = key('old');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: old, email: 'ada@x.co' } } }
      }
    });
    const minted = key('new');
    const h = routedHarness([revokeRoute, cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${old}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.err()).toContain(
      `The ${displayName} key cached for ada@x.co is retired: the Antasphere login carries no address to match it with.\n`
    );
    expect(h.err()).not.toMatch(/ {2}/);
    expect(h.err()).not.toContain("The Antasphere login's address is now");
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default).toEqual({
      apiKey: HUB_KEY,
      baseUrl: HUB,
      email: 'ada@x.co'
    });

    const next = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('again')]), meRoute()], env);
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
  });
  it('the address changed at the hub under a live cached key: the recovery mints once and heals, the next run is served from the cache with no DELETE (verifier round 2, F1)', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const live = key('live');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: live, email: 'ada@x.co' } } }
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
    expect(a.err()).toContain('The cached key was refused; signed in again through Antasphere.\n');
    expect(a.err()).toContain(
      "The Antasphere login's address is now ada@new.co, replaced from ada@x.co (the hub's own answer).\n"
    );
    expect(a.err()).not.toContain('is retired');
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.email).toBe('ada@new.co');

    const b = routedHarness(routes, env);
    expect(await run(['whoami'], b.io)).toBe(0);
    expect(trace(b)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(b.wire.some((c) => c.method === 'DELETE')).toBe(false);
    expect(b.err()).toBe('');
  });

  it('a stored address in another case is the same address: one fresh exchange writes nothing, says nothing, and the next run is served (verifier round 2, F2)', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ADA@X.CO' } }
    });
    const hubFile = coreConfigPath(env, HUB_TOOL)!;
    const before = readFileSync(hubFile, 'utf8');
    const minted = key('new');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    expect(readFileSync(hubFile, 'utf8')).toBe(before);
    expect(h.err()).not.toContain("The Antasphere login's address is now");

    const next = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('again')]), meRoute()], env);
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(next.err()).toBe('');
  });

  it('a blank answered address is never written: the hub profile unchanged, no line, the entry stored as cli-core stores it (verifier round 2, F3)', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
    });
    const hubFile = coreConfigPath(env, HUB_TOOL)!;
    const before = readFileSync(hubFile, 'utf8');
    const minted = key('new');
    const h = routedHarness(
      [meRoute(), ...answeringAs([cloudInstanceRoute, ...exchangeRoutes([minted])], '')],
      env
    );
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(readFileSync(hubFile, 'utf8')).toBe(before);
    expect(h.err()).not.toContain("The Antasphere login's address is now");
    expect(loadConfig(env).profiles.tool?.connectKeys?.default).toMatchObject({ apiKey: minted, email: '' });
  });
});

describe('login --email on a stored login with no address is a switch (verifier round 1, F2)', () => {
  it.each([
    ['absent', {}],
    ['blank', { email: '  ' }]
  ] as const)(
    "a hub key with its address %s and --email bob: bob signs in afresh, the exchange runs with bob's key, the profile and the output name bob",
    async (_label, address) => {
      const ADA_KEY = 'ant_adakey12_secretsecretsecret1234';
      const BOB_KEY = 'ant_bobkey12_secretsecretsecret1234';
      const env = await tempConfigEnv();
      saveCoreConfig(env, HUB_TOOL, {
        activeProfile: 'default',
        profiles: { default: { apiKey: ADA_KEY, baseUrl: HUB, ...address } }
      });
      const minted = key('bob');
      const h = routedHarness(
        answeringAs(
          [cloudInstanceRoute, ...otpRoutes(BOB_KEY, ORG), ...exchangeRoutes([minted]), meRoute()],
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
      expect(h.wire.some((c) => c.auth === `Bearer ${ADA_KEY}`)).toBe(false);
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

describe('profiles names why another hub login is not the one in use (verifier round 1, F6)', () => {
  it('under ANTASPHERE_URL a slot of another hub login reads "not the one ANTASPHERE_URL names"', async () => {
    const env: Record<string, string> = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedTwoHubs(env);
    saveConfig(env, {
      activeProfile: 'tool',
      profiles: {
        tool: { baseUrl: 'http://tool', connectKeys: { cloud: { apiKey: key('cloud'), email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(h.out()).toContain('via Antasphere (login "cloud", not the one ANTASPHERE_URL names)');
    expect(h.out()).not.toContain('not the active one');
  });
});
