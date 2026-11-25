import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { ADA, BEA, fleet, HUB_A, HUB_B, SITE_A, SITE_B, trace } from './fleet.js';
import { cliVersionOf, kept, key, seedHub, seedTool } from './signin-fixtures.js';

/**
 * A profile is a site, and it can be managed (R3, PRDCT-5190): `profiles add`
 * writes the profile of a site with what its discovery says (one profile per
 * site, no sign-in, no key), `profiles rename` moves one whole (its keys, its
 * place, the default), and `profiles remove` revokes every key it holds on
 * its own site, never another origin, then forgets it, naming the default it
 * falls back to. On the fleet of the sign-in suite, every key checked to
 * reach its own origin only, with a remote site and a local one where
 * nothing answers.
 */

const { loadConfig } = cli;
const { bin, cloudUrl, displayName } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;
const LOCAL = 'http://localhost:4100';
const REMOTE = 'https://remote.example.com';

let VERSION = '';
let f: ReturnType<typeof fleet>;

beforeAll(async () => {
  VERSION = await cliVersionOf();
});

beforeEach(() => {
  f = fleet([
    { origin: SITE_A, names: HUB_A, trusts: HUB_A, cli: VERSION },
    { origin: SITE_B, names: HUB_B, trusts: HUB_B },
    { origin: LOCAL, names: null, trusts: null, down: true },
    { origin: REMOTE, names: null, trusts: null, down: true }
  ]);
});

afterEach(() => {
  expect(f.violations()).toEqual([]);
});

const NOT_A_NAME = (n: string) =>
  `Error: "${n}" is not a profile name: 1 to 64 letters, digits, ".", "_", ":", "@" or "-", starting with a ` +
  'letter or a digit.\n';

describe('profiles add (R3)', () => {
  it('writes the profile of a site with what its discovery says, the default of a machine that had none: no sign-in, no key', async () => {
    const env = await tempConfigEnv();
    const h = f.harness(env);
    expect(await run(['profiles', 'add', 'HTTPS://Site-A.example.com/'], h.io)).toBe(0);
    expect(h.out()).toBe(`Profile "site-a.example.com" added: ${SITE_A}.\n`);
    expect(h.err()).toBe('');
    expect(trace(h)).toEqual([`GET ${SITE_A}/api/v1/instance`]);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('site-a.example.com');
    expect(config.profiles).toEqual({
      'site-a.example.com': {
        baseUrl: SITE_A,
        site: { hub: HUB_A, federated: true, name: 'Inst', cliVersion: VERSION, seenAt: expect.any(String) }
      }
    });
  });

  it('--name, and --json answers the new profile’s entry of the contract; on a machine with profiles the default stays, and a line says how to move it', async () => {
    const env = await tempConfigEnv();
    seedHub(env, { profiles: { b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA } } });
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    const h = f.harness(env);
    expect(await run(['profiles', 'add', SITE_B, '--name', 'work', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      name: 'work',
      default: false,
      saved: true,
      site: {
        origin: SITE_B,
        name: 'Inst',
        hub: HUB_B,
        federated: true,
        cliVersion: null,
        seenAt: expect.any(String)
      },
      cliBehind: null,
      // The login at the hub the site names is in place: the first command signs in by itself.
      signIn: { state: 'will_sign_in', via: 'login', hub: HUB_B, email: BEA, staleKeys: 0, fix: null },
      environment: []
    });
    expect(h.err()).toBe(`The default profile stays "a" (${bin} use work makes "work" the default).\n`);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('a');
    expect(Object.keys(config.profiles)).toEqual(['a', 'work']);
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/instance']);
  });

  it('one profile per site, a free and valid name, an http(s) address: each refused before any request, nothing written', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: `${SITE_A}/` }, b: { baseUrl: SITE_B } } });
    const before = JSON.stringify(loadConfig(env));
    const cases: Array<[string[], string]> = [
      [
        ['profiles', 'add', SITE_A],
        `Error: Profile "a" is already ${SITE_A}. One profile per site: ${bin} profiles rename a <name> names ` +
          'it differently.\n'
      ],
      [
        ['profiles', 'add', 'https://SITE-A.example.com', '--name', 'second'],
        `Error: Profile "a" is already ${SITE_A}. One profile per site: ${bin} profiles rename a second names ` +
          'it differently.\n'
      ],
      [
        ['profiles', 'add', 'https://other.example.com', '--name', 'b'],
        `Error: Profile "b" already exists (${SITE_B}).\n`
      ],
      [['profiles', 'add', 'https://other.example.com', '--name', 'work/two'], NOT_A_NAME('work/two')],
      [
        ['profiles', 'add', 'ftp://files.example.com'],
        'Error: "ftp://files.example.com" is not the address of a site: give its http:// or https:// URL.\n'
      ],
      [
        ['profiles', 'add', 'not a url'],
        'Error: "not a url" is not the address of a site: give its http:// or https:// URL.\n'
      ]
    ];
    for (const [argv, sentence] of cases) {
      const h = f.harness(env);
      expect(await run(argv, h.io)).toBe(1);
      expect(h.err()).toBe(sentence);
      expect(h.wire).toEqual([]);
    }
    expect(JSON.stringify(loadConfig(env))).toBe(before);
  });

  it('a site that does not answer is added all the same, with no facts, and stderr says so', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    const h = f.harness(env);
    expect(await run(['profiles', 'add', LOCAL], h.io)).toBe(0);
    expect(h.out()).toBe(`Profile "localhost:4100" added: ${LOCAL}.\n`);
    expect(h.err()).toBe(
      `Nothing answered at ${LOCAL} as a site of ${displayName}: profile "localhost:4100" is added all the ` +
        'same, and what its site says of itself is read at its first command.\n' +
        `The default profile stays "a" (${bin} use localhost:4100 makes "localhost:4100" the default).\n`
    );
    expect(loadConfig(env).profiles['localhost:4100']).toEqual({ baseUrl: LOCAL });
  });
});

describe('profiles rename', () => {
  it('the profile moves whole, its keys and its place kept, and the default follows; its next command is served from its kept key', async () => {
    const env = await tempConfigEnv();
    seedHub(env, { profiles: { a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA } } });
    const keptA = f.toolKey(SITE_A, ADA);
    const profileA = {
      baseUrl: SITE_A,
      site: {
        hub: HUB_A,
        federated: true,
        name: 'Inst',
        cliVersion: VERSION,
        seenAt: new Date().toISOString()
      },
      hubKeys: [kept(HUB_A, ADA, keptA)]
    };
    seedTool(env, {
      activeProfile: 'a',
      profiles: { first: { baseUrl: SITE_B }, a: profileA, last: { baseUrl: 'https://last.example.com' } }
    });
    const h = f.harness(env);
    expect(await run(['profiles', 'rename', 'a', 'work', '--json'], h.io)).toBe(0);
    const answer = JSON.parse(h.out()) as { renamed: unknown; profile: Record<string, unknown> };
    expect(answer.renamed).toEqual({ from: 'a', to: 'work' });
    expect(answer.profile).toMatchObject({
      name: 'work',
      default: true,
      saved: true,
      signIn: { state: 'signed_in', via: 'login', hub: HUB_A, email: ADA, fix: null }
    });
    const config = loadConfig(env);
    expect(Object.keys(config.profiles)).toEqual(['first', 'work', 'last']);
    expect(config.profiles.work).toEqual(profileA);
    expect(config.activeProfile).toBe('work');
    expect(h.wire).toEqual([]);

    // Its keys went with it: the next command is served from the kept key, with no exchange.
    const next = f.harness(env);
    expect(await run(['verify'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET ${SITE_A}/api/v1/me`]);
    expect(f.exchanges()).toBe(0);

    const text = f.harness(env);
    expect(await run(['profiles', 'rename', 'work', 'job'], text.io)).toBe(0);
    expect(text.out()).toBe(`Profile "work" is now "job" (${SITE_A}).\n`);
  });

  it('the implicit cloud profile is written first, then renamed', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    const h = f.harness(env);
    expect(await run(['profiles', 'rename', 'cloud', 'home'], h.io)).toBe(0);
    expect(h.out()).toBe(`Profile "cloud" is now "home" (${CLOUD}).\n`);
    expect(loadConfig(env)).toEqual({
      activeProfile: 'a',
      profiles: { a: { baseUrl: SITE_A }, home: { baseUrl: CLOUD } }
    });
  });

  it('an unknown profile, a taken name, an invalid one: refused, nothing written', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A }, b: { baseUrl: SITE_B } } });
    const before = JSON.stringify(loadConfig(env));
    for (const [argv, sentence] of [
      [['profiles', 'rename', 'nope', 'x'], `Error: Unknown profile "nope" — run \`${bin} profiles\`.\n`],
      [['profiles', 'rename', 'a', 'b'], `Error: Profile "b" already exists (${SITE_B}).\n`],
      [['profiles', 'rename', 'a', 'a b'], NOT_A_NAME('a b')]
    ] as Array<[string[], string]>) {
      const h = f.harness(env);
      expect(await run(argv, h.io)).toBe(1);
      expect(h.err()).toBe(sentence);
    }
    expect(JSON.stringify(loadConfig(env))).toBe(before);
  });
});

describe('profiles remove', () => {
  it('every key it holds is revoked on its own site and never on another origin; it goes, and the default it falls back to is named', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA } }
    });
    const own = f.toolKey(SITE_A, ADA, 'own');
    const keptA = f.toolKey(SITE_A, ADA);
    const old = f.toolKey(SITE_A, ADA, 'old');
    const keptB = f.toolKey(SITE_B, BEA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: {
          baseUrl: SITE_A,
          apiKey: own,
          hubKeys: [kept(HUB_A, ADA, keptA)],
          connectKeys: { a: { apiKey: old, email: ADA } }
        },
        b: { baseUrl: SITE_B, hubKeys: [kept(HUB_B, BEA, keptB)] },
        mine: { baseUrl: `${CLOUD}/` }
      }
    });
    const h = f.harness(env);
    expect(await run(['profiles', 'remove', 'a'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `DELETE ${SITE_A}/api/v1/cli/auth/key`,
      `DELETE ${SITE_A}/api/v1/cli/auth/key`,
      `DELETE ${SITE_A}/api/v1/cli/auth/key`
    ]);
    expect([f.alive(own), f.alive(keptA), f.alive(old)]).toEqual([false, false, false]);
    expect(f.alive(keptB)).toBe(true);
    expect(h.out()).toBe(
      `Profile "a" removed (${SITE_A}): 3 keys revoked there.\nThe default is now "mine" (${CLOUD}).\n`
    );
    expect(h.err()).toBe('');
    const config = loadConfig(env);
    expect(config.activeProfile).toBeUndefined();
    expect(Object.keys(config.profiles)).toEqual(['b', 'mine']);

    // A profile that is not the default: no line about the default.
    const other = f.harness(env);
    expect(await run(['profiles', 'remove', 'b', '--json'], other.io)).toBe(0);
    expect(JSON.parse(other.out())).toEqual({
      removed: 'b',
      site: SITE_B,
      revoked: 1,
      unrevoked: 0,
      defaultSite: CLOUD
    });
    expect(f.alive(keptB)).toBe(false);
    expect(other.wire.map((c) => c.origin)).toEqual([SITE_B]);
  });

  it('the last profile goes: the default falls back to the implicit cloud profile, and says so', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'b', profiles: { b: { baseUrl: SITE_B } } });
    const h = f.harness(env);
    expect(await run(['profiles', 'remove', 'b'], h.io)).toBe(0);
    expect(h.out()).toBe(
      `Profile "b" removed (${SITE_B}): it held no key.\nThe default is now "cloud" (${CLOUD}).\n`
    );
    expect(h.wire).toEqual([]);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('a site that does not answer: the profile is forgotten all the same; remote, its keys stay valid there, said; local, they die with it', async () => {
    const env = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'remote',
      profiles: {
        remote: {
          baseUrl: REMOTE,
          apiKey: f.toolKey(REMOTE, ADA, 'own'),
          hubKeys: [kept(HUB_A, ADA, f.toolKey(REMOTE, ADA))]
        },
        local: { baseUrl: LOCAL, apiKey: f.toolKey(LOCAL, ADA, 'own') }
      }
    });
    const remote = f.harness(env);
    expect(await run(['profiles', 'remove', 'remote'], remote.io)).toBe(0);
    // Once the site gave no answer, the second key is not tried.
    expect(trace(remote)).toEqual([`DELETE ${REMOTE}/api/v1/cli/auth/key`]);
    expect(remote.err()).toBe(
      `Could not reach ${REMOTE} to revoke 2 keys: they stay valid there until revoked from its dashboard.\n`
    );
    expect(remote.out()).toBe(
      `Profile "remote" removed (${REMOTE}): 0 keys revoked there.\nThe default is now "cloud" (${CLOUD}).\n`
    );

    const local = f.harness(env);
    expect(await run(['profiles', 'remove', 'local', '--json'], local.io)).toBe(0);
    expect(local.err()).toBe(`Nothing answers at ${LOCAL}; its keys die with it.\n`);
    expect(JSON.parse(local.out())).toEqual({
      removed: 'local',
      site: LOCAL,
      revoked: 0,
      unrevoked: 1,
      defaultSite: CLOUD
    });
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('a key another command gave the profile while it was being removed is never lost: the profile stays with it, and the command says to run it again', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { a: { baseUrl: SITE_A, apiKey: key('own') } } });
    let raced = false;
    const racing: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => {
        if (!raced) {
          raced = true;
          // Another tab signs in on the profile while its own key is being revoked.
          cli.updateConfig(env, (config) => {
            config.profiles.a!.hubKeys = [kept(HUB_A, ADA, key('meanwhile'))];
          });
        }
        return { body: { revoked: true, id: 'k' } };
      }
    };
    const h = routedHarness([racing], env);
    expect(await run(['profiles', 'remove', 'a'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: Profile "a" took 1 key while it was being removed (another command signed in on it), so it ' +
        `stays, with that one: run ${bin} profiles remove a again.\n`
    );
    expect(loadConfig(env).profiles).toEqual({
      a: { baseUrl: SITE_A, hubKeys: [kept(HUB_A, ADA, key('meanwhile'))] }
    });
  });

  it('an unknown profile is refused, and so is the implicit cloud one, which is not on disk', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    for (const name of ['nope', 'cloud']) {
      const h = f.harness(env);
      expect(await run(['profiles', 'remove', name], h.io)).toBe(1);
      expect(h.err()).toBe(`Error: Unknown profile "${name}" — run \`${bin} profiles\`.\n`);
      expect(h.wire).toEqual([]);
    }
    expect(Object.keys(loadConfig(env).profiles)).toEqual(['a']);
  });
});

describe('profiles, its subcommands and its options', () => {
  it('an unknown word after profiles is refused, never read as the listing', async () => {
    const h = f.harness(await tempConfigEnv());
    expect(await run(['profiles', 'lst'], h.io)).toBe(1);
    expect(h.err()).toBe(`Error: Unknown command "profiles lst" — run \`${bin} profiles --help\`.\n`);
    expect(h.out()).toBe('');
  });

  it('--help names the listing’s options and the three subcommands', async () => {
    // Read from the built tree: a subcommand's own --help exits the process.
    const h = f.harness(await tempConfigEnv());
    const profiles = cli
      .buildProgram(h.io, () => undefined, '0.0.0')
      .commands.find((c) => c.name() === 'profiles')!;
    const help = profiles.helpInformation();
    expect(help).toContain('--check');
    for (const sub of ['add [options] <url>', 'rename <old> <new>', 'remove <name>'])
      expect(help).toContain(sub);
  });
});
