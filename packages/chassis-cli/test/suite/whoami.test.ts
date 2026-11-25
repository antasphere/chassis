import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  exchangeRoutes,
  fresh,
  HUB,
  kept,
  key,
  meBody,
  meRoute,
  namingInstanceRoute,
  ORG,
  seedHubLogin,
  seedTool,
  wsRow
} from './signin-fixtures.js';

/**
 * `whoami` says who, where, and WITH WHAT (PRDCT-2947): the credential the
 * run resolved, and, when an Antasphere login signed it in, which one: the
 * login at the hub the site names, never another (PRDCT-3364). There is no
 * line about a login that did not sign the command in.
 */

const { envPrefix: P, cloudUrl } = cli.identity;
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
        '  role:      owner (via api_key)\n' +
        '  scopes:    a:read\n' +
        '  key expires: never\n'
    );
  });

  it('the key variable, paired with the site its URL variable names', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([meRoute()], {
      ...env,
      [`${P}_URL`]: 'http://inst',
      [`${P}_API_KEY`]: key('env')
    });
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the API key variable']);
    expect(h.out()).not.toContain('Antasphere login');
    expect(h.out()).not.toContain('organization:');
  });

  it("the profile's own key", async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('own'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  instance:')).toEqual(['  instance:  http://inst (profile "work")']);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the key of profile "work"']);
    expect(h.out()).not.toContain('Antasphere login');
  });

  it("the profile's own key, with an Antasphere login on the machine: the login is not named (PRDCT-3364)", async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('own'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the key of profile "work"']);
    expect(h.out()).not.toContain('Antasphere login');
  });

  it('the key the profile keeps from the Antasphere login, served with no exchange', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', site: fresh(HUB), hubKeys: [kept(HUB, 'ada@x.co', key('cached'))] }
      }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual([
      `GET /api/v1/me Bearer ${key('cached')}`
    ]);
    expect(lines(h.out(), '  signed in with:')).toEqual([
      `  signed in with: the Antasphere login ada@x.co at ${HUB} (kept key)`
    ]);
    expect(lines(h.out(), '  Antasphere login:')).toEqual([]);
  });

  it('a fresh sign-in', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([namingInstanceRoute(HUB), ...exchangeRoutes([key('fresh')]), meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(lines(h.out(), '  signed in with:')).toEqual([
      `  signed in with: the Antasphere login ada@x.co at ${HUB} (fresh sign-in)`
    ]);
    expect(lines(h.out(), '  Antasphere login:')).toEqual([]);
  });

  it('on the cloud with a key on the command line: the flag, and nothing about a login', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-key', key('flag')], h.io)).toBe(0);
    expect(h.wire[0]?.origin).toBe(CLOUD);
    expect(lines(h.out(), '  instance:')).toEqual([`  instance:  ${CLOUD} (profile "cloud")`]);
    expect(lines(h.out(), '  signed in with:')).toEqual(['  signed in with: the --api-key flag']);
    expect(h.out()).not.toContain('Antasphere login');
  });

  it('--json adds the sources, the profile and the login that signed it in', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', site: fresh(HUB), hubKeys: [kept(HUB, 'ada@x.co', key('cached'))] }
      }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--json', '--workspace', 'w1'], h.io)).toBe(0);
    const answer = JSON.parse(h.out()) as Record<string, unknown>;
    expect(answer).toMatchObject({
      user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
      workspaceSource: 'flag',
      credentialSource: 'hub-cache',
      profile: 'work',
      login: { hub: HUB, email: 'ada@x.co' }
    });
    expect(answer).not.toHaveProperty('hubLogin');

    const bare = routedHarness([meRoute()], await tempConfigEnv());
    expect(
      await run(['whoami', '--json', '--api-url', 'http://inst', '--api-key', key('flag')], bare.io)
    ).toBe(0);
    expect(JSON.parse(bare.out())).toMatchObject({
      workspaceSource: 'default',
      credentialSource: 'flag',
      profile: 'inst',
      login: null
    });
  });
});
