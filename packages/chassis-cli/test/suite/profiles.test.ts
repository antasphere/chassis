import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cliVersionOf,
  cloudInstanceRoute,
  exchangeRoutes,
  filesRoute,
  fresh,
  HUB,
  kept,
  key,
  meRoute,
  ossInstanceRoute,
  seedHubLogin,
  seedTool
} from './signin-fixtures.js';

/**
 * A profile IS an instance (cli-core 0.5.0 `selectProfile`, PRDCT-2947):
 * --profile, else the profile of the URL the run names, else the active one,
 * else the implicit `cloud` profile at the tool's cloud URL. `profiles`
 * lists them with how each signs in, and no listing prints any part of a key.
 */

const { loadConfig } = cli;
const { bin, envPrefix: P, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

/** The instance line of `whoami`: which URL, which profile. */
const instanceLine = (out: string) => out.split('\n').find((l) => l.startsWith('  instance:'));

describe('which profile a command runs on', () => {
  it('--profile wins, and must exist', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
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
    seedTool(env, {
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
    seedTool(env, {
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
    seedTool(env, { activeProfile: 'second', profiles });
    const active = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://same'], active.io)).toBe(0);
    expect(active.wire[0]?.auth).toBe(`Bearer ${key('second')}`);

    seedTool(env, {
      activeProfile: 'elsewhere',
      profiles: { ...profiles, elsewhere: { baseUrl: 'http://x' } }
    });
    const first = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', 'http://same'], first.io)).toBe(0);
    expect(first.wire[0]?.auth).toBe(`Bearer ${key('first')}`);

    seedTool(env, {
      profiles: { mine: { apiKey: key('mine') }, cloud: { apiKey: key('cloud'), baseUrl: CLOUD } }
    });
    const cloud = routedHarness([meRoute()], env);
    expect(await run(['whoami', '--api-url', CLOUD], cloud.io)).toBe(0);
    expect(cloud.wire[0]?.auth).toBe(`Bearer ${key('cloud')}`);
  });

  it('a profile with no URL of its own is at the cloud URL', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
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
    seedTool(env, {
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
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([ossInstanceRoute], env);
    expect(await run(['files', 'list', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/instance', auth: undefined }
    ]);
  });

  it('--profile with --api-url of another site is refused before any request: its own key goes nowhere (verifier round 1, F5; PRDCT-3039, PRDCT-3044)', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { oss: { apiKey: key('oss'), baseUrl: 'http://oss' } } });
    const h = routedHarness([ossInstanceRoute, filesRoute, meRoute()], env);
    expect(await run(['files', 'list', '--profile', 'oss', '--api-url', 'http://cloud'], h.io)).toBe(1);
    expect(h.wire).toEqual([]);
    expect(h.err()).toBe(
      'Error: Profile "oss" is the site http://oss, and this command targets http://cloud. Drop --profile to ' +
        'run on the profile of http://cloud, or drop --api-url to run on "oss".\n'
    );
  });

  it('the --api-key flag goes where the command goes', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'oss', profiles: { oss: { apiKey: key('oss'), baseUrl: 'http://oss' } } });
    const h = routedHarness([filesRoute], env);
    expect(await run(['files', 'list', '--api-url', 'http://cloud', '--api-key', key('flag')], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://cloud', path: '/api/v1/files', auth: `Bearer ${key('flag')}` }
    ]);
  });

  it(`the key variable goes to the site ${P}_URL names, and wins over the profile's own key there`, async () => {
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { oss: { apiKey: key('oss'), baseUrl: 'http://cloud' } } });
    const h = routedHarness([filesRoute], {
      ...env,
      [`${P}_URL`]: 'http://cloud',
      [`${P}_API_KEY`]: key('flag')
    });
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://cloud', path: '/api/v1/files', auth: `Bearer ${key('flag')}` }
    ]);
  });

  it('else the active profile', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    const h = routedHarness([meRoute()], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire[0]).toMatchObject({ origin: 'http://inst', auth: `Bearer ${key('work')}` });
  });

  it('else the `cloud` profile on disk', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { cloud: { apiKey: key('cloud') }, other: { baseUrl: 'http://o' } } });
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

  it('the first sign-in writes the in-memory profile, the default only when the tool had none', async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('minted')]), filesRoute], env);
    expect(await run(['files', 'list'], h.io)).toBe(0);
    expect(h.wire[0]?.origin).toBe(CLOUD);
    let config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(config.profiles.cloud?.baseUrl).toBe(CLOUD);
    expect(config.profiles.cloud?.hubKeys?.[0]?.apiKey).toBe(key('minted'));

    const second = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('other')]), filesRoute], env);
    expect(await run(['files', 'list', '--api-url', 'http://tool'], second.io)).toBe(0);
    config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(config.profiles.tool?.baseUrl).toBe('http://tool');
    expect(config.profiles.tool?.hubKeys?.[0]?.apiKey).toBe(key('other'));
  });

  it("a kept key is read only for the profile's own site: --profile with another site is refused, on its own site it serves", async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'work',
      profiles: {
        work: { baseUrl: 'http://tool', site: fresh(HUB), hubKeys: [kept(HUB, 'ada@x.co', key('cached'))] }
      }
    });
    const h = routedHarness([ossInstanceRoute, filesRoute], env);
    expect(await run(['files', 'list', '--profile', 'work', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([]);

    const home = routedHarness([filesRoute], env);
    expect(await run(['files', 'list', '--profile', 'work'], home.io)).toBe(0);
    expect(home.wire).toEqual([
      { method: 'GET', origin: 'http://tool', path: '/api/v1/files', auth: `Bearer ${key('cached')}` }
    ]);
  });
});

describe('profiles, use, config show', () => {
  /** The rows of the text listing, its header first, split on the column gaps. */
  const rowsOf = (out: string) =>
    out
      .split('\n\n')[0]!
      .split('\n')
      .map((l) => l.split(/\s{2,}/));

  it('lists the implicit cloud row first, the default mark, and how each signs in, never any part of a key', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own' },
        hubbed: { baseUrl: 'http://hubbed', hubKeys: [kept(HUB, 'ada@x.co', key('hub'))] },
        old: { baseUrl: 'http://old', connectKeys: { default: { apiKey: key('old'), email: 'ada@x.co' } } },
        stray: { baseUrl: 'http://stray', connectKeys: { personal: { apiKey: key('stray') } } },
        bare: { baseUrl: 'http://bare' }
      }
    });
    const h = routedHarness([], env);
    h.io.hostname = () => 'a-host-name';
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(rowsOf(h.out())).toEqual([
      ['', 'PROFILE', 'SITE', 'SIGN-IN', 'SITE CLI'],
      ['', 'cloud', CLOUD, `not reached yet: ${bin} profiles --check`, '-'],
      ['*', 'own', 'http://own', 'signed in with its own key', '-'],
      // Their sites never read, with keys kept: what the next sign-in revokes is told once each is asked.
      [
        '',
        'hubbed',
        'http://hubbed',
        `signed in: ada@x.co at ${HUB}; try again: ${bin} profiles --check`,
        '-'
      ],
      ['', 'old', 'http://old', `signed in: ada@x.co at ${HUB}; try again: ${bin} profiles --check`, '-'],
      ['', 'stray', 'http://stray', `needs a sign-in; try again: ${bin} profiles --check`, '-'],
      ['', 'bare', 'http://bare', `not reached yet: ${bin} profiles --check`, '-']
    ]);
    expect(h.out().split('\n\n')[1]).toBe(
      `This CLI ${await cliVersionOf()} on a-host-name.\nAntasphere logins: ada@x.co at ${HUB} (default).\n`
    );
    for (const tag of ['own', 'hub', 'old', 'stray']) expect(h.out()).not.toContain(key(tag).slice(0, 13));
    expect(h.wire).toEqual([]);
  });

  it('with nothing saved, the cloud row is the default one', async () => {
    const h = routedHarness([], await tempConfigEnv());
    h.io.hostname = () => 'a-host-name';
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(rowsOf(h.out())).toEqual([
      ['', 'PROFILE', 'SITE', 'SIGN-IN', 'SITE CLI'],
      ['*', 'cloud', CLOUD, `not reached yet: ${bin} profiles --check`, '-']
    ]);
    expect(h.out().split('\n\n')[1]).toBe(
      `This CLI ${await cliVersionOf()} on a-host-name.\nNo Antasphere login on this machine.\n`
    );
  });

  it('--json, with no key in it', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    seedTool(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own', email: 'ada@x.co' },
        hubbed: {
          baseUrl: 'http://hubbed',
          connectKeys: { default: { apiKey: key('hub'), email: 'ada@x.co' } }
        },
        replaced: { baseUrl: 'http://replaced', hubKeys: [kept(HUB, 'bo@x.co', key('bo'))] }
      }
    });
    const h = routedHarness([], env);
    h.io.hostname = () => 'a-host-name';
    expect(await run(['profiles', '--json'], h.io)).toBe(0);
    const never = { name: null, hub: null, federated: null, cliVersion: null, seenAt: null };
    const signIn = (over: Record<string, unknown>) => ({
      state: 'signed_in',
      via: 'login',
      hub: HUB,
      email: 'ada@x.co',
      staleKeys: 0,
      fix: null,
      ...over
    });
    expect(JSON.parse(h.out())).toEqual({
      machine: 'a-host-name',
      cliVersion: await cliVersionOf(),
      defaultSite: 'http://own',
      environment: { url: null, key: false, hubUrl: null },
      logins: [{ hub: HUB, email: 'ada@x.co', name: 'default' }],
      profiles: [
        {
          name: 'cloud',
          default: false,
          saved: false,
          site: { origin: CLOUD, ...never },
          cliBehind: null,
          signIn: signIn({
            state: 'unknown',
            via: null,
            hub: null,
            email: null,
            fix: { kind: 'check', argv: [bin, 'profiles', '--check'] }
          }),
          environment: []
        },
        {
          name: 'own',
          default: true,
          saved: true,
          site: { origin: 'http://own', ...never },
          cliBehind: null,
          signIn: signIn({ via: 'key', hub: null }),
          environment: []
        },
        // Its site never read, with an old slot held: how many keys its next sign-in revokes cannot be
        // told before the site is asked, and asking it is the fix.
        {
          name: 'hubbed',
          default: false,
          saved: true,
          site: { origin: 'http://hubbed', ...never },
          cliBehind: null,
          signIn: signIn({ staleKeys: null, fix: { kind: 'check', argv: [bin, 'profiles', '--check'] } }),
          environment: []
        },
        // Another account's key, now that the login at its hub is ada's: nothing serves it, a stale key
        // never says which hub a site trusts, and with its site never read the count waits for the check.
        {
          name: 'replaced',
          default: false,
          saved: true,
          site: { origin: 'http://replaced', ...never },
          cliBehind: null,
          signIn: signIn({
            state: 'needs_login',
            via: null,
            hub: null,
            email: null,
            staleKeys: null,
            fix: { kind: 'check', argv: [bin, 'profiles', '--check'] }
          }),
          environment: []
        }
      ]
    });
    for (const tag of ['own', 'hub', 'bo']) expect(h.out()).not.toContain(key(tag).slice(0, 13));
  });

  it('`use cloud` writes the cloud profile when it is not on disk, and activates it', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
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

  it('`use cloud` selects the profile already at the cloud site, whatever its name, and writes no second one (R3)', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own' },
        mine: { apiKey: key('mine') },
        later: { baseUrl: `${CLOUD}/` }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['use', 'cloud'], h.io)).toBe(0);
    // Two profiles at the cloud site (a file from before one per site): the selection's, the first declared.
    expect(h.out()).toBe(`Active profile: mine (${CLOUD})\n`);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('mine');
    expect(Object.keys(config.profiles)).toEqual(['own', 'mine', 'later']);

    const json = routedHarness([], env);
    expect(await run(['use', 'cloud', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ activeProfile: 'mine' });
    expect(Object.keys(loadConfig(env).profiles)).toEqual(['own', 'mine', 'later']);
  });

  it('`use <name>` switches; an unknown name errors and writes nothing', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
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

  it('config show: each profile’s site and what it holds, by kind, and no key material at all (decision 4)', async () => {
    const env = await tempConfigEnv();
    const path = seedTool(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'http://own/', email: 'ada@x.co' },
        mine: {
          hubKeys: [kept(HUB, 'ada@x.co', key('kept'))],
          connectKeys: { default: { apiKey: key('hub') } }
        }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['config', 'show', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      path,
      defaultProfile: 'own',
      profiles: {
        own: { site: 'http://own', ownKey: true, keptKeys: [], oldSlots: 0 },
        mine: { site: CLOUD, ownKey: false, keptKeys: [{ hub: HUB, email: 'ada@x.co' }], oldSlots: 1 }
      }
    });

    const text = routedHarness([], env);
    expect(await run(['config', 'show'], text.io)).toBe(0);
    expect(text.out().split('\n')[0]).toBe(`config: ${path}`);
    for (const out of [h.out(), text.out()]) {
      for (const tag of ['own', 'kept', 'hub']) {
        expect(out).not.toContain(key(tag).slice(0, 13));
        expect(out).not.toContain(key(tag).slice(-4));
      }
    }
  });

  it('config show names the default the way the listing marks it: the active profile, else the one at the cloud URL, else the implicit cloud row', async () => {
    /** The default config show names, and the rows profiles --json marks default, on one machine. */
    async function defaults(env: Record<string, string>) {
      const show = routedHarness([], env);
      expect(await run(['config', 'show', '--json'], show.io)).toBe(0);
      const listed = routedHarness([], env);
      expect(await run(['profiles', '--json'], listed.io)).toBe(0);
      const rows = (JSON.parse(listed.out()) as { profiles: Array<{ name: string; default: boolean }> })
        .profiles;
      return {
        shown: (JSON.parse(show.out()) as { defaultProfile: string | null }).defaultProfile,
        marked: rows.filter((row) => row.default).map((row) => row.name)
      };
    }
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { a: { baseUrl: 'http://a' } } });
    expect(await defaults(env)).toEqual({ shown: 'cloud', marked: ['cloud'] });
    seedTool(env, { profiles: { a: { baseUrl: 'http://a' }, home: { baseUrl: `${CLOUD}/` } } });
    expect(await defaults(env)).toEqual({ shown: 'home', marked: ['home'] });
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: 'http://a' }, home: { baseUrl: CLOUD } } });
    expect(await defaults(env)).toEqual({ shown: 'a', marked: ['a'] });
  });

  it('the help of logout and use says the default profile and the site', () => {
    const program = cli.buildProgram(routedHarness([]).io, () => undefined, '0.0.0');
    const help = (name: string) => program.commands.find((c) => c.name() === name)!.description();
    expect(help('logout')).toMatch(/^Sign out of the default \(or named\) profile: /);
    expect(help('use')).toBe('Switch the default profile (the site the commands run against)');
    for (const name of ['logout', 'use']) expect(help(name)).not.toMatch(/active profile|instance/);
  });
});

describe('the profiles commands never resolve a command’s context', () => {
  it(`with ${P}_API_KEY exported and no ${P}_URL, the default at another site than the cloud: each answers, and the listing says the key's effect`, async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'own',
      profiles: {
        own: { apiKey: key('own'), baseUrl: 'https://own.example.com' },
        spare: { apiKey: key('spare'), baseUrl: 'https://spare.example.com' }
      }
    });
    const exported = { ...env, [`${P}_API_KEY`]: key('exported') };
    const revoke = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => ({ body: { revoked: true, id: 'k' } })
    };
    // A command that resolves its context is refused there (the key belongs to the cloud)...
    const refused = routedHarness([], exported);
    expect(await run(['whoami'], refused.io)).toBe(1);
    expect(refused.err()).toContain(`${P}_API_KEY is a key of ${CLOUD}`);

    // ...the profiles commands are not: the variable is an effect the listing shows.
    const list = routedHarness([], exported);
    expect(await run(['profiles'], list.io)).toBe(0);
    expect(list.out()).toContain(
      `${P}_API_KEY is exported: commands on ${CLOUD} use it; commands on other sites refuse.`
    );
    const json = routedHarness([], exported);
    expect(await run(['profiles', '--json'], json.io)).toBe(0);
    const listing = JSON.parse(json.out()) as {
      environment: { key: boolean };
      profiles: Array<{ name: string; environment: Array<{ variable: string; effect: string }> }>;
    };
    expect(listing.environment.key).toBe(true);
    expect(Object.fromEntries(listing.profiles.map((p) => [p.name, p.environment]))).toEqual({
      cloud: [{ variable: `${P}_API_KEY`, effect: 'replaces' }],
      own: [{ variable: `${P}_API_KEY`, effect: 'refuses' }],
      spare: [{ variable: `${P}_API_KEY`, effect: 'refuses' }]
    });
    const add = routedHarness([ossInstanceRoute], exported);
    expect(await run(['profiles', 'add', 'https://new.example.com'], add.io)).toBe(0);
    const check = routedHarness([ossInstanceRoute, meRoute()], exported);
    expect(await run(['profiles', '--check'], check.io)).toBe(0);
    const rename = routedHarness([], exported);
    expect(await run(['profiles', 'rename', 'spare', 'second'], rename.io)).toBe(0);
    const remove = routedHarness([revoke], exported);
    expect(await run(['profiles', 'remove', 'second'], remove.io)).toBe(0);
    expect(remove.wire.map((c) => `${c.method} ${c.origin} ${c.auth}`)).toEqual([
      `DELETE https://spare.example.com Bearer ${key('spare')}`
    ]);
    // The exported key never left this machine.
    for (const h of [list, json, add, check, rename, remove]) {
      expect(JSON.stringify(h.wire)).not.toContain(key('exported'));
    }
    expect(Object.keys(loadConfig(env).profiles)).toEqual(['own', 'new.example.com']);
  });
});
