import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { exchangeRoutes, HUB, key, namingInstanceRoute, seedHubLogin, seedTool } from './signin-fixtures.js';

/**
 * The two sentences only the runner can say, because only it sees how a
 * request ended: a 401 answered to the profile's OWN key (the key is stale,
 * `login` on that profile is the fix, PRDCT-3522), and a request to the
 * profile's site that cannot connect at all (PRDCT-3060): at a loopback or
 * private address the profile is named with its fixes, its removal among
 * them; anywhere else, never the removal of a site that may only be down.
 */

const { bin, envPrefix: P } = cli.identity;

const UNKNOWN_KEY = {
  status: 401,
  body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
};

/** Every request, of any method, fails the way `fetch` fails when nothing answers. */
function nothingAnswers(error: () => Error = () => new TypeError('fetch failed')): Route[] {
  return ['GET', 'POST', 'DELETE'].map((method) => ({
    method,
    path: /.*/,
    reply: () => {
      throw error();
    }
  }));
}

describe('a 401 answered to the profile’s own key (PRDCT-3522)', () => {
  it.each([['files', 'list'], ['whoami'], ['verify']])(
    '%s: the profile, its site, the code, and the login that fixes it',
    async (...argv) => {
      const env = await tempConfigEnv();
      seedTool(env, {
        activeProfile: 'work',
        profiles: { work: { apiKey: key('stale'), baseUrl: 'https://remote.example.com' } }
      });
      const h = routedHarness(
        [{ method: 'GET', path: /\/api\/v1\/(files|me)$/, reply: () => UNKNOWN_KEY }],
        env
      );
      expect(await run(argv, h.io)).toBe(1);
      expect(h.err()).toBe(
        'Error: The key of profile "work" was refused by https://remote.example.com (invalid_api_key): it is ' +
          `stale. Run ${bin} --profile work login to sign in again.\n`
      );
      expect(h.wire).toHaveLength(1);
    }
  );

  it.each([
    ['the --api-key flag', ['--api-url', 'https://remote.example.com', '--api-key', key('flag')], {}],
    ['the key variable', [], { [`${P}_URL`]: 'https://remote.example.com', [`${P}_API_KEY`]: key('env') }]
  ] as const)('%s refused: the plain line and its hint, no profile blamed', async (_label, args, extra) => {
    const env = await tempConfigEnv();
    const h = routedHarness([{ method: 'GET', path: /\/api\/v1\/me$/, reply: () => UNKNOWN_KEY }], {
      ...env,
      ...extra
    });
    expect(await run(['whoami', ...args], h.io)).toBe(1);
    expect(h.err()).toBe(`Error: API key not recognized (check the key: \`${bin} verify\`)\n`);
  });
});

describe('a profile’s site that does not answer (PRDCT-3060)', () => {
  it.each([
    'http://localhost:3400',
    'http://dev.localhost:8080',
    'http://127.0.0.1:9',
    'http://[::1]:3000',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.10'
  ])('at %s: the profile is named, with another site and its removal as the ways out', async (url) => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'dev', profiles: { dev: { apiKey: key('dev'), baseUrl: url } } });
    const h = routedHarness(nothingAnswers(), env);
    expect(await run(['files', 'list'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Profile "dev" is ${url}, and nothing answers there. Run on another site with --profile <name> or ` +
        `${bin} use <name>, or forget this one: ${bin} profiles remove dev.\n`
    );
  });

  it('a refused connection (ECONNREFUSED) reads the same', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'dev',
      profiles: { dev: { apiKey: key('dev'), baseUrl: 'http://localhost:3400' } }
    });
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3400'), { code: 'ECONNREFUSED' });
    const h = routedHarness(nothingAnswers(refused), env);
    expect(await run(['whoami'], h.io)).toBe(1);
    expect(h.err()).toContain('Error: Profile "dev" is http://localhost:3400, and nothing answers there.');
  });

  it('a profile with no key of its own, whose discovery cannot connect: the same sentence, not the no-key one', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, { activeProfile: 'dev', profiles: { dev: { baseUrl: 'http://localhost:3400' } } });
    const h = routedHarness(nothingAnswers(), env);
    expect(await run(['files', 'list'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: Profile "dev" is http://localhost:3400, and nothing answers there. Run on another site with ' +
        `--profile <name> or ${bin} use <name>, or forget this one: ${bin} profiles remove dev.\n`
    );
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/instance']);
  });

  it.each(['https://remote.example.com', 'http://172.32.0.1', 'http://11.0.0.1', 'http://192.169.0.1'])(
    'at %s: check the address or try again, never its removal',
    async (url) => {
      const env = await tempConfigEnv();
      seedTool(env, {
        activeProfile: 'remote',
        profiles: { remote: { apiKey: key('remote'), baseUrl: url } }
      });
      const h = routedHarness(nothingAnswers(), env);
      expect(await run(['files', 'list'], h.io)).toBe(1);
      expect(h.err()).toBe(
        `Error: Nothing answers at ${url} (profile "remote"). Check the address, or try again.\n`
      );
      expect(h.err()).not.toContain('profiles remove');
    }
  );

  it('a local URL with no saved profile: nothing to forget, so check and retry', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(nothingAnswers(), env);
    expect(
      await run(['files', 'list', '--api-url', 'http://localhost:3400', '--api-key', key('flag')], h.io)
    ).toBe(1);
    expect(h.err()).toBe(
      'Error: Nothing answers at http://localhost:3400 (profile "localhost:3400"). Check the address, or try again.\n'
    );
  });

  it('a hub that does not answer is not the site’s fault: the plain error, no profile blamed', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, { activeProfile: 'dev', profiles: { dev: { baseUrl: 'http://localhost:3400' } } });
    const hubDown: Route[] = ['POST'].map((method) => ({
      method,
      path: /\/api\/v1\/sso\/tool-token$/,
      reply: () => {
        throw new TypeError('fetch failed');
      }
    }));
    const h = routedHarness([...hubDown, namingInstanceRoute(HUB), ...exchangeRoutes([key('minted')])], env);
    expect(await run(['files', 'list'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: fetch failed\n');
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path}`)).toEqual([
      'GET http://localhost:3400/api/v1/instance',
      `POST ${HUB}/api/v1/sso/tool-token`
    ]);
  });
});
