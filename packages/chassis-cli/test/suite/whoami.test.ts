import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  key,
  meBody,
  meRoute,
  ORG,
  seedHubLogin,
  wsRow
} from './signin-fixtures.js';

/**
 * `whoami` says who, where, and WITH WHAT (PRDCT-2947): the credential the
 * run resolved, and what became of the Antasphere login.
 */

const { saveConfig } = cli;
const { bin, envPrefix: P, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

function lines(out: string, prefix: string): string[] {
  return out.split('\n').filter((l) => l.startsWith(prefix));
}

describe('whoami', () => {
  it('prints every line, in order', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const flagKey = key('flag');
    const rows = [wsRow('w1', 'Acme', { default: true, hubOrigin: true, centralAccountId: ORG })];
    const h = routedHarness([meRoute(meBody({ workspaces: rows }))], env);
    expect(await run(['whoami', '--api-url', 'http://inst', '--api-key', flagKey], h.io)).toBe(0);
    expect(h.out()).toBe(
      'Ada <ada@x.co>\n' +
        '  instance:  http://inst (profile "inst")\n' +
        '  workspace: Acme (w1)\n' +
        `  organization: ${ORG}\n` +
        "  chosen by: the server's default (nothing selected)\n" +
        '  signed in with: the --api-key flag\n' +
        '  Antasphere login: ada@x.co (not used: the --api-key flag wins)\n' +
        '  role:      owner (via api_key)\n' +
        '  scopes:    a:read\n' +
        '  key expires: never\n'
    );
  });

  it('the key variable', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([meRoute()], {
      ...env,
      [`${P}_URL`]: 'http://inst',
      [`${P}_API_KEY`]: key('env')
    });
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the API key variable']);
    expect(lines(h.out(), '  Antasphere login:')).toEqual([
      '  Antasphere login: ada@x.co (not used: the API key variable wins)'
    ]);
    expect(h.out()).not.toContain('organization:');
  });

  it("the profile's own key; no Antasphere line off the cloud with no hub login", async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('own'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  instance:')).toEqual(['  instance:  http://inst (profile "work")']);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the key of profile "work"']);
    expect(h.out()).not.toContain('Antasphere login');
  });

  it("the profile's own key, with a hub login stored: not used", async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('own'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  Antasphere login:')).toEqual([
      '  Antasphere login: ada@x.co (not used: the key of profile "work" wins)'
    ]);
  });

  it('the cached key of the Antasphere login', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: key('cached') } } } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire[0]?.auth).toBe(`Bearer ${key('cached')}`);
    expect(lines(h.out(), '  signed in with:')).toEqual([
      '  signed in with: the Antasphere login (cached key)'
    ]);
    expect(lines(h.out(), '  Antasphere login:')).toEqual(['  Antasphere login: ada@x.co']);
  });

  it('a fresh exchange', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('fresh')]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(lines(h.out(), '  signed in with:')).toEqual([
      '  signed in with: the Antasphere login (fresh exchange)'
    ]);
    expect(lines(h.out(), '  Antasphere login:')).toEqual(['  Antasphere login: ada@x.co']);
  });

  it('on the cloud with no Antasphere login: not connected', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-key', key('flag')], h.io)).toBe(0);
    expect(h.wire[0]?.origin).toBe(CLOUD);
    expect(lines(h.out(), '  instance:')).toEqual([`  instance:  ${CLOUD} (profile "cloud")`]);
    expect(lines(h.out(), '  Antasphere login:')).toEqual([
      `  Antasphere login: not connected (run \`${bin} login\`)`
    ]);
  });

  it('--json adds the sources, the profile and the hub login', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: key('cached') } } } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--json', '--workspace', 'w1'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
      workspaceSource: 'flag',
      credentialSource: 'hub-cache',
      profile: 'work',
      hubLogin: { profile: 'default', email: 'ada@x.co' }
    });

    const bare = routedHarness([meRoute()], await tempConfigEnv());
    expect(
      await run(['whoami', '--json', '--api-url', 'http://inst', '--api-key', key('flag')], bare.io)
    ).toBe(0);
    expect(JSON.parse(bare.out())).toMatchObject({
      workspaceSource: 'default',
      credentialSource: 'flag',
      profile: 'inst',
      hubLogin: null
    });
  });
});
