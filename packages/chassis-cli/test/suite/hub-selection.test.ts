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

  it('a 401 on that cached key evicts it from the slot it was read from (the seam is given the same hub cloud URL)', async () => {
    const env = await legacyEnv();
    const cached = key('cached');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: cached, email: 'ada@x.co' } } }
      }
    });
    const refused: Route = {
      method: 'GET',
      path: /\/api\/v1\/me$/,
      reply: () => ({
        status: 401,
        body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
      })
    };
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('new')]), refused], env);
    expect(await run(['whoami'], h.io)).toBe(1);
    expect(trace(h)).toEqual([
      `GET http://tool/api/v1/me Bearer ${cached}`,
      'GET http://tool/api/v1/instance -'
    ]);
    expect(loadConfig(env).profiles.work?.connectKeys ?? {}).toEqual({});
  });

  it('without a cached key the profile is found, but cli-core 0.6.0 takes the hub URL from its own baseUrl only: the login is demanded, no hub is called', async () => {
    const env = await legacyEnv();
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('new')]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(1);
    expect(trace(h)).toEqual(['GET http://tool/api/v1/instance -']);
    expect(h.err()).toContain('signs in through Antasphere');
    expect(loadConfig(env).profiles.tool?.connectKeys).toBeUndefined();
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
