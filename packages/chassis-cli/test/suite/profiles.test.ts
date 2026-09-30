import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { redactKey } from '@antasphere/chassis-cli';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  filesRoute,
  key,
  meRoute,
  ossInstanceRoute,
  seedHubLogin
} from './signin-fixtures.js';

/**
 * A profile IS an instance (cli-core 0.5.0 `selectProfile`, PRDCT-2947):
 * --profile, else the profile of the URL the run names, else the active one,
 * else the implicit `cloud` profile at the tool's cloud URL. `profiles`
 * lists them with how each signs in.
 */

const { loadConfig, saveConfig } = cli;
const { bin, envPrefix: P, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

/** The instance line of `whoami`: which URL, which profile. */
const instanceLine = (out: string) => out.split('\n').find((l) => l.startsWith('  instance:'));

describe('which profile a command runs on', () => {
  it('--profile wins, and must exist', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: key('a'), baseUrl: 'http://a' }, b: { apiKey: key('b'), baseUrl: 'http://b' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--profile', 'b'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://b', path: '/api/v1/me', auth: `Bearer ${key('b')}` }
    ]);

    const unknown = routedHarness([], env);
    expect(await run(['whoami', '--profile', 'x'], unknown.io)).toBe(1);
    expect(unknown.err()).toBe(`Error: Unknown profile "x" — run \`${bin} profiles\` to list them.\n`);
    expect(unknown.wire).toEqual([]);
  });

  it('--api-url selects the saved profile of that instance (trailing slash and case aside)', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: {
        a: { apiKey: key('a'), baseUrl: 'http://a' },
        b: { apiKey: key('b'), baseUrl: 'http://B/' }
      }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://b'], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: 'http://b', auth: `Bearer ${key('b')}` });
    expect(instanceLine(h.out())).toBe('  instance:  http://b (profile "b")');
  });

  it(`${P}_URL selects it the same way`, async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: key('a'), baseUrl: 'http://a' }, b: { apiKey: key('b'), baseUrl: 'http://b' } }
    });
    const h = routedHarness([meRoute()], { ...env, [`${P}_URL`]: 'http://b' });
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: 'http://b', auth: `Bearer ${key('b')}` });
  });

  it('several profiles at that instance: the active one first, then `cloud`, then the first', async () => {
    const env = await tempConfigEnv();
    const profiles = {
      first: { apiKey: key('first'), baseUrl: 'http://same' },
      second: { apiKey: key('second'), baseUrl: 'http://same' }
    };
    saveConfig(env, { activeProfile: 'second', profiles });
    const active = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://same'], active.io)).toBe(0);
    expect(active.wire[0]?.auth).toBe(`Bearer ${key('second')}`);

    saveConfig(env, {
      activeProfile: 'elsewhere',
      profiles: { ...profiles, elsewhere: { baseUrl: 'http://x' } }
    });
    const first = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://same'], first.io)).toBe(0);
    expect(first.wire[0]?.auth).toBe(`Bearer ${key('first')}`);

    saveConfig(env, {
      profiles: { mine: { apiKey: key('mine') }, cloud: { apiKey: key('cloud'), baseUrl: CLOUD } }
    });
    const cloud = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', CLOUD], cloud.io)).toBe(0);
    expect(cloud.wire[0]?.auth).toBe(`Bearer ${key('cloud')}`);
  });

  it('a profile with no URL of its own is at the cloud URL', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'x',
      profiles: { x: { baseUrl: 'http://x' }, mine: { apiKey: key('mine') } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', `${CLOUD}/`], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: CLOUD, auth: `Bearer ${key('mine')}` });
    expect(instanceLine(h.out())).toBe(`  instance:  ${CLOUD} (profile "mine")`);
  });

  it.each([
    ['http://tool', 'tool'],
    ['http://localhost:3400', 'localhost:3400'],
    [cloudUrl, 'cloud']
  ])('no profile saved at %s: one in memory named %s, never written', async (url, name) => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', url, '--api-key', key('flag')], h.io)).toBe(0);
    expect(instanceLine(h.out())).toContain(`(profile "${name}")`);
    expect(Object.keys(loadConfig(env).profiles)).toEqual(['work']);
  });

  it("the active profile's key never goes to another instance named by --api-url", async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([ossInstanceRoute], env);
    expect(await run(['files', 'list', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/instance', auth: undefined }
    ]);
  });

  it("--profile's own key never goes to the other instance --api-url names (verifier round 1, F5)", async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { oss: { apiKey: key('oss'), baseUrl: 'http://oss' } } });
    const h = routedHarness([ossInstanceRoute, filesRoute, meRoute()], env);
    expect(await run(['files', 'list', '--profile', 'oss', '--api-url', 'http://cloud'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://cloud', path: '/api/v1/instance', auth: undefined }
    ]);
    expect(h.wire.some((c) => c.auth?.includes(key('oss')))).toBe(false);
    expect(h.err()).toContain(
      `An API key is required. Sign in (\`${bin} login\`), pass --api-key, or set ${P}_API_KEY.`
    );
  });

  it.each([
    ['the --api-key flag', ['--api-key', key('flag')], {}],
    ['the key variable', [], { [`${P}_API_KEY`]: key('flag') }]
  ] as const)('%s still goes to any URL', async (_label, args, extraEnv) => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { oss: { apiKey: key('oss'), baseUrl: 'http://oss' } } });
    const h = routedHarness([filesRoute], { ...env, ...extraEnv });
    expect(await run(['files', 'list', '--profile', 'oss', '--api-url', 'http://cloud', ...args], h.io)).toBe(
      0
    );
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://cloud', path: '/api/v1/files', auth: `Bearer ${key('flag')}` }
    ]);
  });

  it('else the active profile', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: 'http://inst', auth: `Bearer ${key('work')}` });
  });

  it('else the `cloud` profile on disk', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { cloud: { apiKey: key('cloud') }, other: { baseUrl: 'http://o' } } });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: CLOUD, auth: `Bearer ${key('cloud')}` });
  });

  it('with nothing at all: the implicit cloud profile, at the cloud URL', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-key', key('flag')], h.io)).toBe(0);
    expect(h.wire[0]?.origin).toBe(CLOUD);
    expect(instanceLine(h.out())).toBe(`  instance:  ${CLOUD} (profile "cloud")`);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('the first hub connect writes the in-memory profile, active only when the tool had none', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('minted')]), filesRoute], env);
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(h.wire[0]?.origin).toBe(CLOUD);
    let config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(config.profiles.cloud?.baseUrl).toBe(CLOUD);
    expect(config.profiles.cloud?.connectKeys?.default?.apiKey).toBe(key('minted'));

    const second = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('other')]), filesRoute], env);
    expect(await run(['files', 'list', '--api-url', 'http://tool'], second.io)).toBe(0);
    config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(config.profiles.tool?.baseUrl).toBe('http://tool');
    expect(config.profiles.tool?.connectKeys?.default?.apiKey).toBe(key('other'));
  });

  it("a cached key is read only when the selected profile names the request's instance", async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: key('cached') } } } }
    });
    const h = routedHarness([ossInstanceRoute, filesRoute], env);
    expect(await run(['files', 'list', '--profile', 'work', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/instance', auth: undefined }
    ]);

    const home = routedHarness([filesRoute], env);
    expect(await run(['files', 'list', '--profile', 'work'], home.io)).toBe(0);
    expect(home.wire).toEqual([
      { method: 'GET', origin: 'http://tool', path: '/api/v1/files', auth: `Bearer ${key('cached')}` }
    ]);
  });
});

describe('profiles, use, config show', () => {
  it('lists the implicit cloud row first, the active mark, and the three kinds of credential', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own' },
        hubbed: {
          baseUrl: 'http://hubbed',
          connectKeys: { default: { apiKey: key('hub'), email: 'ada@x.co' } }
        },
        stray: { baseUrl: 'http://stray', connectKeys: { personal: { apiKey: key('stray') } } },
        bare: { baseUrl: 'http://bare' }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    const rows = h
      .out()
      .trimEnd()
      .split('\n')
      .map((l) => l.split(/\s{2,}/));
    expect(rows).toEqual([
      ['', 'cloud', CLOUD, '(not signed in)'],
      ['*', 'own', 'http://own', redactKey(key('own'))],
      ['', 'hubbed', 'http://hubbed', 'via Antasphere (ada@x.co)'],
      ['', 'stray', 'http://stray', 'via Antasphere (login "personal", not the active one)'],
      ['', 'bare', 'http://bare', '(not signed in)']
    ]);
    expect(h.out()).not.toContain(key('own'));
  });

  it('with nothing saved, the cloud row is the active one', async () => {
    const h = routedHarness([], await tempConfigEnv());
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(
      h
        .out()
        .trimEnd()
        .split(/\s{2,}/)
    ).toEqual(['*', 'cloud', CLOUD, '(not signed in)']);
  });

  it('--json', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    saveConfig(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own', email: 'ada@x.co' },
        hubbed: {
          baseUrl: 'http://hubbed',
          connectKeys: { default: { apiKey: key('hub'), email: 'bo@x.co' } }
        }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['profiles', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      activeProfile: 'own',
      hubProfile: 'default',
      profiles: {
        cloud: {
          baseUrl: CLOUD,
          saved: false,
          credential: 'none',
          apiKey: null,
          email: null,
          hubProfiles: []
        },
        own: {
          baseUrl: 'http://own',
          saved: true,
          credential: 'key',
          apiKey: redactKey(key('own')),
          email: 'ada@x.co',
          hubProfiles: []
        },
        hubbed: {
          baseUrl: 'http://hubbed',
          saved: true,
          credential: 'hub',
          apiKey: null,
          email: 'bo@x.co',
          hubProfiles: ['default']
        }
      }
    });
  });

  it('`use cloud` writes the cloud profile when it is not on disk, and activates it', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'own',
      profiles: { own: { apiKey: key('own'), baseUrl: 'http://own' } }
    });
    const h = routedHarness([], env);
    expect(await run(['use', 'cloud'], h.io)).toBe(0);
    expect(h.out()).toBe(`Active profile: cloud (${CLOUD})\n`);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(config.profiles.cloud).toEqual({ baseUrl: CLOUD });
    expect(config.profiles.own?.apiKey).toBe(key('own'));
  });

  it('`use <name>` switches; an unknown name errors and writes nothing', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: { a: { baseUrl: 'http://a' }, b: { baseUrl: 'http://b' } }
    });
    const h = routedHarness([], env);
    expect(await run(['use', 'b'], h.io)).toBe(0);
    expect(h.out()).toBe('Active profile: b (http://b)\n');
    expect(loadConfig(env).activeProfile).toBe('b');

    const bad = routedHarness([], env);
    expect(await run(['use', 'nope'], bad.io)).toBe(1);
    expect(bad.err()).toBe(`Error: Unknown profile "nope" — run \`${bin} profiles\`.\n`);
    expect(loadConfig(env).activeProfile).toBe('b');
  });

  it('config show: baseUrl, redacted key, email, redacted connect keys', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own', email: 'ada@x.co' },
        mine: { connectKeys: { default: { apiKey: key('hub') } } }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['config', 'show', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out()).profiles).toEqual({
      own: { baseUrl: 'http://own', apiKey: redactKey(key('own')), email: 'ada@x.co', connectKeys: {} },
      mine: { baseUrl: CLOUD, apiKey: null, email: null, connectKeys: { default: redactKey(key('hub')) } }
    });
    expect(h.out()).not.toContain(key('own'));
    expect(h.out()).not.toContain(key('hub'));
  });
});
