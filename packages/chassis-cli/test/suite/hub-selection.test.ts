import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
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
});
