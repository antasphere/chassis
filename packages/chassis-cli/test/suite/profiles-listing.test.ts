import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HUB_TOOL, keysOfProfile, updateConfig as updateCoreConfig } from '@antasphere/cli-core';
import type { ProfileEntry, ProfilesListing } from '@antasphere/chassis-cli';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { ADA, BEA, CY, fleet, HUB_A, HUB_B, OLD, SITE_A, SITE_B, type FleetSite } from './fleet.js';
import { cliVersionOf, kept, newerThan, seedHub, seedTool } from './signin-fixtures.js';

/**
 * `profiles --json` is the contract a client draws (R4, PRDCT-5190): every
 * profile with its site, who signs it in and through what, the CLI version
 * its site speaks beside this CLI's, one state and the one way to fix it,
 * what the environment changes, and which machine answers. These tests run on
 * the fleet of the sign-in suite (hubs and sites served by origin, every key
 * checked to reach its own origin only), on a fixture machine that holds one
 * profile of each kind: two hubs and their logins, the sites of the sign-in
 * suite, a site from before sites named their hub, a self-hosted one, one
 * never reached, one whose hub holds no login, one whose hub holds two, and
 * two profiles at one site.
 */

const { loadConfig } = cli;
const { bin, envPrefix: P, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;
const KEY_VAR = `${P}_API_KEY`;

const HUB_C = 'https://hub-c.example.com';
const SITE_C = 'https://site-c.example.com';
const SELF = 'https://self.example.com';
const NEW = 'https://new.example.com';
const NEVER = 'https://never.example.com';
const LOCAL = 'http://localhost:4100';
const REMOTE = 'https://remote.example.com';
const ZED = 'zed@example.com';
const SEEN = '2026-11-20T10:00:00.000Z';
const MACHINE = 'a-host-name';

let VERSION = '';
let NEWER = '';
let f: ReturnType<typeof fleet>;

/** The fixture's sites: a site's CLI version is this CLI's, a newer one, a pre-release of it, or none. */
const sites = (): FleetSite[] => [
  { origin: SITE_A, names: HUB_A, trusts: HUB_A, cli: VERSION },
  { origin: SITE_B, names: HUB_B, trusts: HUB_B, cli: NEWER },
  { origin: OLD, names: null, trusts: HUB_A },
  { origin: SELF, names: null, trusts: null, cli: `${VERSION}-beta.1` },
  { origin: NEW, names: HUB_C, trusts: HUB_C },
  { origin: SITE_C, names: HUB_A, trusts: HUB_A }
];

beforeAll(async () => {
  VERSION = await cliVersionOf();
  NEWER = newerThan(VERSION);
});

beforeEach(() => {
  f = fleet(sites());
});

afterEach(() => {
  expect(f.violations()).toEqual([]);
});

/** A harness on the fleet, on the machine the listing names. */
function onMachine(env: Record<string, string | undefined>) {
  const h = f.harness(env);
  h.io.hostname = () => MACHINE;
  return h;
}

/** What a site said of itself, as a profile remembers it. */
const facts = (hub: string | null, federated = true, cliVersion: string | null = null) => ({
  hub,
  federated,
  name: 'Inst',
  cliVersion,
  seenAt: SEEN
});

/** The machine of the contract: three logins at two hubs, and one profile of each kind. */
async function contractMachine() {
  const env: Record<string, string> = await tempConfigEnv();
  seedHub(env, {
    activeProfile: 'a',
    profiles: {
      a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA },
      'hub-a-cy': { apiKey: f.hubKey(HUB_A, CY), baseUrl: HUB_A, email: CY },
      b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA }
    }
  });
  const keptA = f.toolKey(SITE_A, ADA);
  const stale = f.toolKey(SITE_A, ZED, 'gone');
  const twin = f.toolKey(SITE_A, ADA, 'own');
  seedTool(env, {
    activeProfile: 'a',
    profiles: {
      // Signed in through hub-a; an old slot no login matches waits for its revoke.
      a: {
        baseUrl: SITE_A,
        site: facts(HUB_A, true, VERSION),
        hubKeys: [kept(HUB_A, ADA, keptA)],
        connectKeys: { gone: { apiKey: stale, email: ZED } }
      },
      // A second profile at site-a (a file from before one profile per site), with a key of its own.
      'a-twin': { baseUrl: `${SITE_A}/`, apiKey: twin, email: ADA, site: facts(HUB_A, true, VERSION) },
      b: { baseUrl: SITE_B, site: facts(HUB_B, true, NEWER) },
      old: { baseUrl: OLD, site: facts(null) },
      self: { baseUrl: SELF, site: facts(null, false, `${VERSION}-beta.1`) },
      new: { baseUrl: NEW, site: facts(HUB_C) },
      c: { baseUrl: SITE_C, site: facts(HUB_A) },
      never: { baseUrl: NEVER }
    }
  });
  return { env, keptA, stale, twin };
}

/** `profiles --json` (and `--check`) on a machine. */
async function listing(
  env: Record<string, string | undefined>,
  ...flags: string[]
): Promise<ProfilesListing> {
  const h = onMachine(env);
  expect(await run(['profiles', '--json', ...flags], h.io)).toBe(0);
  return JSON.parse(h.out()) as ProfilesListing;
}

const byName = (l: ProfilesListing): Record<string, ProfileEntry> =>
  Object.fromEntries(l.profiles.map((p) => [p.name, p]));

const sorted = (o: object) => Object.keys(o).sort();

/** The contract's keys, level by level. */
const KEYS = {
  listing: ['cliVersion', 'defaultSite', 'environment', 'logins', 'machine', 'profiles'],
  environment: ['hubUrl', 'key', 'url'],
  login: ['email', 'hub', 'name'],
  profile: ['cliBehind', 'default', 'environment', 'name', 'saved', 'signIn', 'site'],
  site: ['cliVersion', 'federated', 'hub', 'name', 'origin', 'seenAt'],
  signIn: ['email', 'fix', 'hub', 'staleKeys', 'state', 'via'],
  checkedSignIn: ['checked', 'email', 'fix', 'hub', 'person', 'staleKeys', 'state', 'via'],
  fix: ['argv', 'kind'],
  effect: ['effect', 'variable'],
  person: ['email', 'name', 'workspace']
};

/** Every object of a listing carries exactly its level's keys: a field renamed or dropped turns this red. */
function expectContractKeys(l: ProfilesListing, checked: boolean): void {
  expect(sorted(l)).toEqual(KEYS.listing);
  expect(sorted(l.environment)).toEqual(KEYS.environment);
  for (const login of l.logins) expect(sorted(login)).toEqual(KEYS.login);
  for (const p of l.profiles) {
    expect(sorted(p)).toEqual(KEYS.profile);
    expect(sorted(p.site)).toEqual(KEYS.site);
    expect(sorted(p.signIn)).toEqual(checked ? KEYS.checkedSignIn : KEYS.signIn);
    if (p.signIn.fix) expect(sorted(p.signIn.fix)).toEqual(KEYS.fix);
    for (const e of p.environment) expect(sorted(e)).toEqual(KEYS.effect);
    if (p.signIn.person) expect(sorted(p.signIn.person)).toEqual(KEYS.person);
  }
  // Each level above was met at least once.
  expect(l.logins.length).toBeGreaterThan(0);
  expect(l.profiles.some((p) => p.signIn.fix !== null)).toBe(true);
  if (checked) expect(l.profiles.some((p) => p.signIn.person)).toBe(true);
}

const loginFix = (kind: string, name: string, ...more: string[]) => ({
  kind,
  argv: [bin, '--profile', name, 'login', ...more]
});
const CHECK = { kind: 'check', argv: [bin, 'profiles', '--check'] };
const NEVER_SEEN = { name: null, hub: null, federated: null, cliVersion: null, seenAt: null };
const keyVar = (effect: string) => ({ variable: KEY_VAR, effect });
const hubVar = (effect: string) => ({ variable: 'ANTASPHERE_URL', effect });

describe('the contract of profiles --json (PRDCT-5190)', () => {
  it('the fixture machine: every field at every level, and each state, fix, effect and cliBehind once', async () => {
    const { env } = await contractMachine();
    const exported = { ...env, [KEY_VAR]: f.toolKey(CLOUD, ADA, 'envk'), ANTASPHERE_URL: `${HUB_A}/` };
    const l = await listing(exported);
    expectContractKeys(l, false);

    const siteA = {
      origin: SITE_A,
      name: 'Inst',
      hub: HUB_A,
      federated: true,
      cliVersion: VERSION,
      seenAt: SEEN
    };
    expect(l).toEqual({
      machine: MACHINE,
      cliVersion: VERSION,
      defaultSite: SITE_A,
      environment: { url: null, key: true, hubUrl: HUB_A },
      logins: [
        { hub: HUB_A, email: ADA, name: 'a' },
        { hub: HUB_A, email: CY, name: 'hub-a-cy' },
        { hub: HUB_B, email: BEA, name: 'b' }
      ],
      profiles: [
        {
          name: 'cloud',
          default: false,
          saved: false,
          site: { origin: CLOUD, ...NEVER_SEEN },
          cliBehind: null,
          signIn: { state: 'unknown', via: null, hub: null, email: null, staleKeys: 0, fix: CHECK },
          environment: [keyVar('replaces'), hubVar('replaces')]
        },
        {
          name: 'a',
          default: true,
          saved: true,
          site: siteA,
          cliBehind: false,
          signIn: { state: 'signed_in', via: 'login', hub: HUB_A, email: ADA, staleKeys: 1, fix: null },
          environment: [keyVar('refuses')]
        },
        {
          name: 'a-twin',
          default: false,
          saved: true,
          site: siteA,
          cliBehind: false,
          signIn: {
            state: 'signed_in',
            via: 'key',
            hub: null,
            email: ADA,
            staleKeys: 0,
            fix: { kind: 'remove_profile', argv: [bin, 'profiles', 'remove', 'a-twin'] }
          },
          environment: [keyVar('refuses')]
        },
        {
          name: 'b',
          default: false,
          saved: true,
          site: {
            origin: SITE_B,
            name: 'Inst',
            hub: HUB_B,
            federated: true,
            cliVersion: NEWER,
            seenAt: SEEN
          },
          cliBehind: true,
          signIn: { state: 'will_sign_in', via: 'login', hub: HUB_B, email: BEA, staleKeys: 0, fix: null },
          environment: [keyVar('refuses'), hubVar('refuses')]
        },
        {
          name: 'old',
          default: false,
          saved: true,
          site: { origin: OLD, name: 'Inst', hub: null, federated: true, cliVersion: null, seenAt: SEEN },
          cliBehind: null,
          signIn: {
            state: 'needs_login',
            via: null,
            hub: null,
            email: null,
            staleKeys: 0,
            fix: loginFix('pick_hub', 'old', '--hub')
          },
          environment: [keyVar('refuses'), hubVar('replaces')]
        },
        {
          name: 'self',
          default: false,
          saved: true,
          site: {
            origin: SELF,
            name: 'Inst',
            hub: null,
            federated: false,
            cliVersion: `${VERSION}-beta.1`,
            seenAt: SEEN
          },
          cliBehind: false,
          signIn: {
            state: 'needs_login',
            via: null,
            hub: null,
            email: null,
            staleKeys: 0,
            fix: loginFix('email_code', 'self')
          },
          environment: [keyVar('refuses')]
        },
        {
          name: 'new',
          default: false,
          saved: true,
          site: { origin: NEW, name: 'Inst', hub: HUB_C, federated: true, cliVersion: null, seenAt: SEEN },
          cliBehind: null,
          signIn: {
            state: 'needs_login',
            via: null,
            hub: HUB_C,
            email: null,
            staleKeys: 0,
            fix: loginFix('hub_login', 'new')
          },
          environment: [keyVar('refuses'), hubVar('refuses')]
        },
        {
          name: 'c',
          default: false,
          saved: true,
          site: { origin: SITE_C, name: 'Inst', hub: HUB_A, federated: true, cliVersion: null, seenAt: SEEN },
          cliBehind: null,
          signIn: {
            state: 'needs_login',
            via: null,
            hub: HUB_A,
            email: null,
            staleKeys: 0,
            fix: loginFix('pick_login', 'c', '--email')
          },
          environment: [keyVar('refuses')]
        },
        {
          name: 'never',
          default: false,
          saved: true,
          site: { origin: NEVER, ...NEVER_SEEN },
          cliBehind: null,
          signIn: { state: 'unknown', via: null, hub: null, email: null, staleKeys: 0, fix: CHECK },
          environment: [keyVar('refuses'), hubVar('replaces')]
        }
      ]
    });

    const values = <T>(pick: (p: ProfileEntry) => T | T[]) => new Set(l.profiles.flatMap((p) => pick(p)));
    expect(values((p) => p.signIn.state)).toEqual(
      new Set(['signed_in', 'will_sign_in', 'needs_login', 'unknown'])
    );
    expect(values((p) => p.signIn.fix?.kind ?? null)).toEqual(
      new Set([null, 'check', 'remove_profile', 'pick_hub', 'email_code', 'hub_login', 'pick_login'])
    );
    expect(values((p) => p.environment.map((e) => e.effect))).toEqual(new Set(['replaces', 'refuses']));
    expect(values((p) => p.cliBehind)).toEqual(new Set([true, false, null]));
    // A listing asks nothing of the network.
    expect(f.requests()).toBe(0);
  });

  it('--check: the same contract, with what each site answered (checked, person), every verdict once', async () => {
    const { env, keptA } = await contractMachine();
    // Site-a no longer accepts the kept key of `a` (revoked from its dashboard).
    f.kill(keptA);
    const l = await listing(env, '--check');
    expectContractKeys(l, true);
    const p = byName(l);
    expect(Object.fromEntries(l.profiles.map((e) => [e.name, e.signIn.checked]))).toEqual({
      cloud: 'unreachable',
      a: 'key_refused',
      'a-twin': 'ok',
      b: 'no_key',
      old: 'no_key',
      self: 'no_key',
      new: 'no_key',
      c: 'no_key',
      never: 'unreachable'
    });
    expect(p['a-twin']!.signIn.person).toEqual({ name: 'Ada', email: ADA, workspace: 'Acme' });
    expect(l.profiles.filter((e) => e.name !== 'a-twin').every((e) => e.signIn.person === null)).toBe(true);
    // A refused kept key: the login of its site, which knows the hub and the account by that key.
    expect(p.a!.signIn).toMatchObject({
      state: 'needs_login',
      via: 'login',
      fix: loginFix('hub_login', 'a')
    });
    // A remote site that does not answer is an outage: try again, never a removal.
    expect(p.never!.signIn.fix).toEqual(CHECK);
    expect(p.cloud!.signIn.fix).toEqual(CHECK);
    // The twin stays the one to forget.
    expect(p['a-twin']!.signIn.fix?.kind).toBe('remove_profile');
    // What each answering site said is on its profile now; nothing is remembered for one that did not answer.
    expect(p.b!.site.seenAt).not.toBe(SEEN);
    expect(loadConfig(env).profiles.never?.site).toBeUndefined();
  });

  it('--check never mints, never revokes and never moves a slot: discovery and /me only, the keys of the file unchanged', async () => {
    const { env } = await contractMachine();
    const keysBefore = Object.fromEntries(
      Object.entries(loadConfig(env).profiles).map(([n, prof]) => [n, keysOfProfile(prof)])
    );
    const slotsBefore = loadConfig(env).profiles.a?.connectKeys;
    const h = onMachine(env);
    expect(await run(['profiles', '--check', '--json'], h.io)).toBe(0);
    expect(h.wire.filter((c) => /\/sso\/(tool-token|cli-connect)$/.test(c.path))).toEqual([]);
    expect(h.wire.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(new Set(h.wire.map((c) => c.path))).toEqual(new Set(['/api/v1/instance', '/api/v1/me']));
    // b's login is in place and the first command would mint: --check does not.
    expect(byName(JSON.parse(h.out()) as ProfilesListing).b!.signIn.state).toBe('will_sign_in');
    expect(f.exchanges()).toBe(0);
    const keysAfter = Object.fromEntries(
      Object.entries(loadConfig(env).profiles).map(([n, prof]) => [n, keysOfProfile(prof)])
    );
    expect(keysAfter).toEqual(keysBefore);
    expect(loadConfig(env).profiles.a?.connectKeys).toEqual(slotsBefore);
  });
});

describe('the truth, as it changes (PRDCT-5190, PRDCT-3522, PRDCT-3060)', () => {
  /** Two sites trusting two hubs, and a login at each. */
  async function twoSites() {
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'a',
      profiles: {
        a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA },
        b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA }
      }
    });
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A }, b: { baseUrl: SITE_B } } });
    return env;
  }

  it('two sites trusting two hubs, a login at each: both signed in, each through its own hub; the login of one hub removed, that one line turns needs_login with hub_login, its kept key counted stale, and the other stays', async () => {
    const env = await twoSites();
    for (const name of ['a', 'b'])
      expect(await run(['verify', '--profile', name], f.harness(env).io)).toBe(0);

    const before = byName(await listing(env));
    expect(before.a!.signIn).toEqual({
      state: 'signed_in',
      via: 'login',
      hub: HUB_A,
      email: ADA,
      staleKeys: 0,
      fix: null
    });
    expect(before.b!.signIn).toEqual({
      state: 'signed_in',
      via: 'login',
      hub: HUB_B,
      email: BEA,
      staleKeys: 0,
      fix: null
    });
    const text = onMachine(env);
    expect(await run(['profiles'], text.io)).toBe(0);
    expect(text.out()).toContain(`signed in: ${ADA} at ${HUB_A}`);
    expect(text.out()).toContain(`signed in: ${BEA} at ${HUB_B}`);

    // The login at hub-b ends on this machine. The key b keeps from it is no longer dormant (R2b): the
    // next command on b revokes it on site-b, so the listing counts it.
    updateCoreConfig(env, HUB_TOOL, (config) => {
      delete config.profiles.b;
    });
    const after = byName(await listing(env));
    expect(after.b!.signIn).toEqual({
      state: 'needs_login',
      via: null,
      hub: HUB_B,
      email: null,
      staleKeys: 1,
      fix: loginFix('hub_login', 'b')
    });
    expect(after.a).toEqual(before.a);
    const again = onMachine(env);
    expect(await run(['profiles'], again.io)).toBe(0);
    expect(again.out()).toContain(`signed in: ${ADA} at ${HUB_A}`);
    expect(again.out()).toContain(`needs a sign-in: ${bin} --profile b login`);
  });

  it('a profile signed in through the hub reads signed_in via login once a key was minted (PRDCT-3522)', async () => {
    const env = await twoSites();
    // Before: the login at hub-b is ready, nothing is minted yet (the site's hub learnt from discovery).
    expect(await run(['profiles', '--check'], onMachine(env).io)).toBe(0);
    expect(byName(await listing(env)).b!.signIn).toMatchObject({
      state: 'will_sign_in',
      via: 'login',
      hub: HUB_B
    });

    expect(await run(['verify', '--profile', 'b'], f.harness(env).io)).toBe(0);
    expect(byName(await listing(env)).b!.signIn).toEqual({
      state: 'signed_in',
      via: 'login',
      hub: HUB_B,
      email: BEA,
      staleKeys: 0,
      fix: null
    });
  });

  it('--check, a refused key of its own: the self-hosted site asks its own email code, the site of a hub the login at that hub', async () => {
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, { profiles: { a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA } } });
    const ownSelf = f.toolKey(SELF, ADA, 'own');
    const ownA = f.toolKey(SITE_A, ADA, 'own');
    seedTool(env, {
      activeProfile: 'self',
      profiles: { self: { baseUrl: SELF, apiKey: ownSelf }, a: { baseUrl: SITE_A, apiKey: ownA } }
    });
    f.kill(ownSelf);
    f.kill(ownA);
    const p = byName(await listing(env, '--check'));
    expect(p.self!.signIn).toMatchObject({
      state: 'needs_login',
      via: 'key',
      checked: 'key_refused',
      fix: loginFix('email_code', 'self')
    });
    expect(p.a!.signIn).toMatchObject({
      state: 'needs_login',
      via: 'key',
      checked: 'key_refused',
      fix: loginFix('hub_login', 'a')
    });
  });

  it('after --check, an unreachable profile at http://localhost:<port> gets remove_profile; an unreachable remote one gets check, and neither is sent a key (PRDCT-3060)', async () => {
    f = fleet([
      { origin: LOCAL, names: null, trusts: null, down: true },
      { origin: REMOTE, names: null, trusts: null, down: true }
    ]);
    const env: Record<string, string> = await tempConfigEnv();
    seedTool(env, {
      activeProfile: 'local',
      profiles: {
        local: { baseUrl: LOCAL, apiKey: f.toolKey(LOCAL, ADA, 'own') },
        remote: { baseUrl: REMOTE, apiKey: f.toolKey(REMOTE, ADA, 'own') }
      }
    });
    // From the files alone, both are signed in with their own key.
    const plain = byName(await listing(env));
    expect([plain.local!.signIn.fix, plain.remote!.signIn.fix]).toEqual([null, null]);

    const h = onMachine(env);
    expect(await run(['profiles', '--check', '--json'], h.io)).toBe(0);
    const checked = byName(JSON.parse(h.out()) as ProfilesListing);
    expect(checked.local!.signIn).toMatchObject({
      checked: 'unreachable',
      person: null,
      fix: { kind: 'remove_profile', argv: [bin, 'profiles', 'remove', 'local'] }
    });
    expect(checked.remote!.signIn).toMatchObject({ checked: 'unreachable', person: null, fix: CHECK });
    // Discovery only: a site that does not answer as one of this tool is never sent a key.
    expect(h.wire.filter((c) => c.origin === LOCAL || c.origin === REMOTE).map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/instance'
    ]);

    const text = onMachine(env);
    expect(await run(['profiles', '--check'], text.io)).toBe(0);
    const line = (name: string) =>
      text
        .out()
        .split('\n')
        .find((l) => l.split(/\s{2,}/)[1] === name);
    expect(line('local')).toContain(
      `signed in with its own key; checked: no answer; forget it: ${bin} profiles remove local`
    );
    expect(line('remote')).toContain(
      `signed in with its own key; checked: no answer; try again: ${bin} profiles --check`
    );
  });
});

describe('the text listing (one look)', () => {
  it('the fixture machine, with a key and a hub exported', async () => {
    const { env } = await contractMachine();
    const exported = { ...env, [KEY_VAR]: f.toolKey(CLOUD, ADA, 'envk'), ANTASPHERE_URL: HUB_A };
    const h = onMachine(exported);
    expect(await run(['profiles'], h.io)).toBe(0);
    const [table, footer] = h.out().split('\n\n');
    expect(table!.split('\n').map((l) => l.split(/\s{2,}/))).toEqual([
      ['', 'PROFILE', 'SITE', 'SIGN-IN', 'SITE CLI'],
      ['', 'cloud', CLOUD, `not reached yet: ${bin} profiles --check`, '-'],
      ['*', 'a', SITE_A, `signed in: ${ADA} at ${HUB_A}`, VERSION],
      [
        '',
        'a-twin',
        SITE_A,
        `signed in with its own key; a second profile at this site, forget it: ${bin} profiles remove a-twin`,
        VERSION
      ],
      ['', 'b', SITE_B, `signs in at the next command: ${BEA} at ${HUB_B}`, `${NEWER} (newer than this CLI)`],
      ['', 'old', OLD, `needs a sign-in: ${bin} --profile old login --hub <hub>`, '-'],
      ['', 'self', SELF, `needs a sign-in: ${bin} --profile self login`, `${VERSION}-beta.1`],
      ['', 'new', NEW, `needs a sign-in: ${bin} --profile new login`, '-'],
      ['', 'c', SITE_C, `needs a sign-in: ${bin} --profile c login --email <address>`, '-'],
      ['', 'never', NEVER, `not reached yet: ${bin} profiles --check`, '-']
    ]);
    expect(footer).toBe(
      `This CLI ${VERSION} on ${MACHINE}.\n` +
        `${KEY_VAR} is exported: commands on ${CLOUD} use it; commands on other sites refuse.\n` +
        `ANTASPHERE_URL is exported: profiles whose site names no hub sign in at ${HUB_A}; commands on sites ` +
        'that name another hub refuse.\n' +
        `Antasphere logins: ${ADA} at ${HUB_A} (a), ${CY} at ${HUB_A} (hub-a-cy), ${BEA} at ${HUB_B} (b).\n`
    );
  });

  it(`${P}_URL exported: its line, and the key it pairs`, async () => {
    const env: Record<string, string> = await tempConfigEnv();
    seedTool(env, { activeProfile: 'b', profiles: { b: { baseUrl: SITE_B } } });
    const h = onMachine({ ...env, [`${P}_URL`]: `${SITE_A}/`, [KEY_VAR]: f.toolKey(SITE_A, ADA, 'envk') });
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(h.out().split('\n\n')[1]).toBe(
      `This CLI ${VERSION} on ${MACHINE}.\n` +
        `${P}_URL is exported: commands that name no site run on ${SITE_A}, and --profile naming another site ` +
        'refuses.\n' +
        `${KEY_VAR} is exported: commands on ${SITE_A} use it; commands on other sites refuse.\n` +
        'No Antasphere login on this machine.\n'
    );
    expect(JSON.parse(await jsonOf(h.io.env)).environment).toEqual({ url: SITE_A, key: true, hubUrl: null });
  });
});

describe('no key, redacted or not', () => {
  it('no output of profiles, config show or whoami carries any part of a key', async () => {
    const { env } = await contractMachine();
    const outputs: string[] = [];
    for (const argv of [
      ['profiles'],
      ['profiles', '--json'],
      ['profiles', '--check'],
      ['profiles', '--check', '--json'],
      ['config', 'show'],
      ['config', 'show', '--json'],
      ['whoami', '--profile', 'a'],
      ['whoami', '--profile', 'a', '--json'],
      ['whoami', '--profile', 'a-twin'],
      ['whoami', '--profile', 'a-twin', '--json']
    ]) {
      const h = onMachine(env);
      expect(await run(argv, h.io)).toBe(0);
      outputs.push(h.out(), h.err());
    }
    const all = outputs.join('\n');
    expect(f.keys().length).toBeGreaterThan(5);
    for (const k of f.keys()) {
      // Neither the key nor its redaction (its first 13 characters, its last 8).
      expect(all).not.toContain(k.slice(0, 13));
      expect(all).not.toContain(k.slice(-8));
    }
  });
});

/** `profiles --json` of an environment, as text. */
async function jsonOf(env: Record<string, string | undefined>): Promise<string> {
  const h = onMachine(env);
  expect(await run(['profiles', '--json'], h.io)).toBe(0);
  return h.out();
}
