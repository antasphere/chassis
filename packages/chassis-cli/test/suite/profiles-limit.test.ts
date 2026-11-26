import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_TOOL, keysOfProfile, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import type { ProfileSignIn, ProfilesListing } from '@antasphere/chassis-cli';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { ADA, BEA, fleet, HUB_A, HUB_B, SITE_A, SITE_B, trace, type Harness } from './fleet.js';
import { fresh, kept, seedHub, seedTool } from './signin-fixtures.js';

/**
 * Every request `profiles --check` and `profiles add` send (the discovery
 * read, and `--check`'s `/me`) has a limit, `CliIo.requestTimeoutMs` (10 s
 * unless the io gives one): past it the request is aborted, and counts as no
 * answer. So does every revoke the kit sends (`profiles remove`, `logout`, a
 * login's retirement of the keys it replaces, at a site or at a hub): one the
 * limit aborted is handled as one its site did not answer. On the fleet of
 * the sign-in suite, every key checked to reach its own origin only, with
 * sites that hold the connection open and never answer (the way a host that
 * drops packets does), and a limit of 50 ms (300 ms for the revokes).
 */

const { loadConfig } = cli;
const { bin, cloudUrl, displayName } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

/** Nothing ever answers there. */
const QUIET = 'https://quiet.example.com';
/** Nothing ever answers there either, at a loopback address. */
const QUIET_LOCAL = 'http://localhost:4200';
/** Its discovery answers, its `/me` never does. */
const MUTE = 'https://mute.example.com';
const LIMIT_MS = 50;

let f: ReturnType<typeof fleet>;

beforeEach(() => {
  f = fleet([
    { origin: SITE_A, names: HUB_A, trusts: HUB_A },
    { origin: SITE_B, names: HUB_B, trusts: HUB_B },
    { origin: QUIET, names: null, trusts: null, silent: 'all' },
    { origin: QUIET_LOCAL, names: null, trusts: null, silent: 'all' },
    { origin: MUTE, names: HUB_A, trusts: HUB_A, silent: 'me' }
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(f.violations()).toEqual([]);
});

/** A harness on the fleet, with the short limit. */
function limited(env: Record<string, string>): Harness {
  const h = f.harness(env);
  h.io.requestTimeoutMs = LIMIT_MS;
  return h;
}

/** A run, and how long it took (ms). */
async function timed(argv: string[], h: Harness): Promise<{ code: number; ms: number }> {
  const start = Date.now();
  const code = await run(argv, h.io);
  return { code, ms: Date.now() - start };
}

/** The requests a harness sent to one origin, `METHOD path` each. */
const at = (h: Harness, origin: string) =>
  h.wire.filter((c) => c.origin === origin).map((c) => `${c.method} ${c.path}`);

/** A run raced against a wait: its exit code, or `still running` when the wait ends first. */
async function endsWithin(running: Promise<number>, ms: number): Promise<{ code: number } | 'still running'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<'still running'>((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  try {
    return await Promise.race([running.then((code) => ({ code })), wait]);
  } finally {
    clearTimeout(timer);
  }
}

const CHECK = { kind: 'check', argv: [bin, 'profiles', '--check'] };

describe('the limit of each request of profiles --check and profiles add', () => {
  it('profiles --check --json answers within a second: a site that never answers is unreachable (check, or remove_profile at a loopback address), and so is one whose /me never answers; the others are checked as usual', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      profiles: {
        a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA },
        b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA }
      }
    });
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: { baseUrl: SITE_A, hubKeys: [kept(HUB_A, ADA, f.toolKey(SITE_A, ADA))] },
        b: { baseUrl: SITE_B },
        quiet: { baseUrl: QUIET, apiKey: f.toolKey(QUIET, ADA, 'own') },
        local: { baseUrl: QUIET_LOCAL, apiKey: f.toolKey(QUIET_LOCAL, ADA, 'own') },
        mute: { baseUrl: MUTE, apiKey: f.toolKey(MUTE, ADA, 'own') }
      }
    });
    const h = limited(env);
    const { code, ms } = await timed(['profiles', '--check', '--json'], h);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1000);

    const signIn: Record<string, ProfileSignIn> = Object.fromEntries(
      (JSON.parse(h.out()) as ProfilesListing).profiles.map((e) => [e.name, e.signIn])
    );
    expect(Object.fromEntries(Object.entries(signIn).map(([name, s]) => [name, s.checked]))).toEqual({
      // The implicit cloud row: no route answers at the cloud URL here, as usual.
      cloud: 'unreachable',
      a: 'ok',
      b: 'no_key',
      quiet: 'unreachable',
      local: 'unreachable',
      mute: 'unreachable'
    });
    expect(signIn.a).toMatchObject({
      state: 'signed_in',
      via: 'login',
      person: { name: 'Ada', email: ADA, workspace: 'Acme' },
      fix: null
    });
    expect(signIn.b).toMatchObject({ state: 'will_sign_in', hub: HUB_B, person: null, fix: null });
    // No answer within the limit: an outage for a remote site, a leftover at a loopback address.
    expect(signIn.quiet).toMatchObject({ person: null, fix: CHECK });
    expect(signIn.local).toMatchObject({
      person: null,
      fix: { kind: 'remove_profile', argv: [bin, 'profiles', 'remove', 'local'] }
    });
    expect(signIn.mute).toMatchObject({ person: null, fix: CHECK });

    // A site whose discovery does not answer is never sent a key; the /me of the one that answered was.
    expect(at(h, QUIET)).toEqual(['GET /api/v1/instance']);
    expect(at(h, QUIET_LOCAL)).toEqual(['GET /api/v1/instance']);
    expect(at(h, MUTE)).toEqual(['GET /api/v1/instance', 'GET /api/v1/me']);
    // What a site said is remembered; nothing is, for a site that said nothing.
    const { profiles } = loadConfig(env);
    expect(profiles.quiet?.site).toBeUndefined();
    expect(profiles.local?.site).toBeUndefined();
    expect(profiles.mute?.site).toMatchObject({ hub: HUB_A, federated: true });
  });

  it('profiles add of a site that never answers adds it within a second, with no facts and its one line', async () => {
    const env = await tempConfigEnv();
    const h = limited(env);
    const { code, ms } = await timed(['profiles', 'add', QUIET], h);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1000);
    expect(h.out()).toBe(`Profile "quiet.example.com" added: ${QUIET}.\n`);
    expect(h.err()).toBe(
      `Nothing answered at ${QUIET} as a site of ${displayName}: profile "quiet.example.com" is added all the ` +
        'same, and what its site says of itself is read at its first command.\n'
    );
    expect(loadConfig(env)).toEqual({
      activeProfile: 'quiet.example.com',
      profiles: { 'quiet.example.com': { baseUrl: QUIET } }
    });
    expect(at(h, QUIET)).toEqual(['GET /api/v1/instance']);
  });

  it('with no limit given, a request of profiles add is held to 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = f.harness(await tempConfigEnv());
    expect(await run(['profiles', 'add', SITE_A], h.io)).toBe(0);
    expect(timeout.mock.calls).toEqual([[10_000]]);
  });

  it.each([
    [0, 10_000],
    [-1, 10_000],
    [200.5, 10_000],
    [2 ** 31, 10_000],
    [2_147_483_647, 2_147_483_647]
  ])(
    'an io limit of %s: a request of profiles add is held to %s ms, since only an integer from 1 to 2 147 483 647 is a limit and anything else reads as none given (verifier round 4, addition 1 to finding 4; round 5, note 9)',
    async (given, held) => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const h = f.harness(await tempConfigEnv());
      h.io.requestTimeoutMs = given;
      expect(await run(['profiles', 'add', SITE_A], h.io)).toBe(0);
      expect(timeout.mock.calls).toEqual([[held]]);
    }
  );
});

describe('every revoke the kit sends is held to the io’s limit, and one it aborted is handled as a site that does not answer (verifier round 5, note 5)', () => {
  /** The io's limit here; each bound is one limit more than the revokes held open on the command's way. */
  const REVOKE_LIMIT_MS = 300;
  /** The runner's line for an error no sentence of the kit names: Node's own, for a request its limit aborted. */
  const ABORTED = 'Error: The operation was aborted due to timeout\n';

  /** The fleet: site-a (it names hub-a) holds every revoke open, unless it `answers`. */
  function siteA(revokes: 'held' | 'answers'): void {
    f = fleet([
      {
        origin: SITE_A,
        names: HUB_A,
        trusts: HUB_A,
        ...(revokes === 'held' ? { silent: 'revoke' as const } : {})
      },
      { origin: SITE_B, names: HUB_B, trusts: HUB_B }
    ]);
  }

  /** Profile p at site-a, the default, holding `keys`; ada's login at hub-a. */
  async function onP(keys: Record<string, unknown>) {
    const env: Record<string, string> = await tempConfigEnv();
    const hubKey = f.hubKey(HUB_A, ADA);
    seedHub(env, { profiles: { a: { apiKey: hubKey, baseUrl: HUB_A, email: ADA } } });
    seedTool(env, { activeProfile: 'p', profiles: { p: { baseUrl: SITE_A, site: fresh(HUB_A), ...keys } } });
    return { env, hubKey };
  }

  /** A harness on the fleet, with the revokes' limit. */
  function held(env: Record<string, string>): Harness {
    const h = f.harness(env);
    h.io.requestTimeoutMs = REVOKE_LIMIT_MS;
    return h;
  }

  /** The revokes of a harness, `origin key` each. */
  const deletes = (h: Harness) =>
    h.wire.filter((c) => c.method === 'DELETE').map((c) => `${c.origin} ${c.auth}`);

  it('profiles remove: the profile is forgotten, and its key, alive, is said to stay valid there', async () => {
    siteA('held');
    const own = f.toolKey(SITE_A, ADA, 'own');
    const { env } = await onP({ apiKey: own });
    const h = held(env);
    expect(await endsWithin(run(['profiles', 'remove', 'p'], h.io), 2 * REVOKE_LIMIT_MS)).toEqual({
      code: 0
    });
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`]);
    expect(h.out()).toBe(
      `Profile "p" removed (${SITE_A}): 0 keys revoked there.\nThe default is now "cloud" (${CLOUD}).\n`
    );
    expect(h.err()).toBe(
      `Could not reach ${SITE_A} to revoke 1 key: it stays valid there until revoked from its dashboard.\n`
    );
    expect(f.alive(own)).toBe(true);
    expect(loadConfig(env).profiles.p).toBeUndefined();
  });

  it('logout: exit 1, and the key stays on the profile, alive, for the next attempt', async () => {
    siteA('held');
    const own = f.toolKey(SITE_A, ADA, 'own');
    const { env } = await onP({ apiKey: own, email: ADA });
    const h = held(env);
    expect(await endsWithin(run(['--profile', 'p', 'logout'], h.io), 2 * REVOKE_LIMIT_MS)).toEqual({
      code: 1
    });
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`]);
    expect(h.out()).toBe('');
    expect(h.err()).toBe(ABORTED);
    expect(f.alive(own)).toBe(true);
    expect(keysOfProfile(loadConfig(env).profiles.p!)).toEqual([{ apiKey: own, kind: 'own' }]);
  });

  it('a pasted key replacing the own key: the paste is saved, and the replaced key, alive, is said to stay valid there', async () => {
    siteA('held');
    const own = f.toolKey(SITE_A, ADA, 'own');
    const pasted = f.toolKey(SITE_A, ADA, 'paste');
    const { env } = await onP({ apiKey: own });
    const h = held(env);
    expect(
      await endsWithin(run(['--profile', 'p', 'login', '--api-key', pasted], h.io), 2 * REVOKE_LIMIT_MS)
    ).toEqual({ code: 0 });
    expect(trace(h)).toEqual([`GET ${SITE_A}/api/v1/me`, `DELETE ${SITE_A}/api/v1/cli/auth/key`]);
    expect(deletes(h)).toEqual([`${SITE_A} Bearer ${own}`]);
    expect(h.err()).toBe(
      `Could not reach ${SITE_A} to revoke the replaced key: it stays valid there until revoked from its ` +
        'dashboard.\n'
    );
    expect(f.alive(own)).toBe(true);
    expect(loadConfig(env).profiles.p?.apiKey).toBe(pasted);
  });

  it('a hub login, the kept key of its slot before the exchange: that key stays on the profile, alive, and the login answers', async () => {
    siteA('held');
    const keptA = f.toolKey(SITE_A, ADA);
    const { env } = await onP({ hubKeys: [kept(HUB_A, ADA, keptA)] });
    const h = held(env);
    expect(await endsWithin(run(['--profile', 'p', 'login'], h.io), 2 * REVOKE_LIMIT_MS)).toEqual({
      code: 0
    });
    expect(h.out()).toBe(`Signed in as Ada <${ADA}> in Acme on ${SITE_A}.\n`);
    expect(deletes(h)).toEqual([`${SITE_A} Bearer ${keptA}`]);
    expect(f.alive(keptA)).toBe(true);
    expect(keysOfProfile(loadConfig(env).profiles.p!).map((k) => k.apiKey)).toEqual([keptA]);
  });

  it('a hub login, the own key once the exchange succeeded: the own key stays on the profile, alive, beside the new kept key', async () => {
    siteA('held');
    const own = f.toolKey(SITE_A, ADA, 'own');
    const { env } = await onP({ apiKey: own });
    const h = held(env);
    expect(await endsWithin(run(['--profile', 'p', 'login'], h.io), 2 * REVOKE_LIMIT_MS)).toEqual({
      code: 0
    });
    expect(h.out()).toBe(`Signed in as Ada <${ADA}> in Acme on ${SITE_A}.\n`);
    expect(h.err()).toBe(`Connected to ${SITE_A} as ${ADA} via Antasphere.\n`);
    expect(deletes(h)).toEqual([`${SITE_A} Bearer ${own}`]);
    expect(f.alive(own)).toBe(true);
    const p = loadConfig(env).profiles.p;
    expect(p?.apiKey).toBe(own);
    expect(p?.hubKeys?.map((k) => [k.hub, k.email])).toEqual([[HUB_A, ADA]]);
  });

  it('login --email replacing ada with bea: the revoke of ada’s hub key at hub-a, held open there, and those of her kept key on site-a are each given up; both keys stay alive, her kept key on the profile, and bea signs in', async () => {
    siteA('held');
    const keptA = f.toolKey(SITE_A, ADA);
    const { env, hubKey } = await onP({ hubKeys: [kept(HUB_A, ADA, keptA)] });
    f.hold(hubKey);
    const h = held(env);
    h.io.prompt = async () => '123456';
    // Three revokes held open: the kit's at hub-a and at site-a, then cli-core's at site-a.
    expect(
      await endsWithin(run(['--profile', 'p', 'login', '--email', BEA], h.io), 4 * REVOKE_LIMIT_MS)
    ).toEqual({ code: 0 });
    expect(h.out()).toBe(`Signed in as Bea <${BEA}> in Acme on ${SITE_A}.\n`);
    expect(deletes(h)).toEqual([
      `${HUB_A} Bearer ${hubKey}`,
      `${SITE_A} Bearer ${keptA}`,
      `${SITE_A} Bearer ${keptA}`
    ]);
    expect([f.alive(hubKey), f.alive(keptA)]).toEqual([true, true]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles.a).toMatchObject({ baseUrl: HUB_A, email: BEA });
    expect(loadConfig(env).profiles.p?.hubKeys?.map((k) => [k.email, k.apiKey === keptA])).toEqual([
      [ADA, true],
      [BEA, false]
    ]);
  });

  it('logout --all, the hub key of the login at hub-a held open there: exit 1, the login and its key stay in the hub file, alive; the profile’s kept key, revoked on site-a, is forgotten', async () => {
    siteA('answers');
    const keptA = f.toolKey(SITE_A, ADA);
    const { env, hubKey } = await onP({ hubKeys: [kept(HUB_A, ADA, keptA)] });
    f.hold(hubKey);
    const h = held(env);
    expect(await endsWithin(run(['--profile', 'p', 'logout', '--all'], h.io), 2 * REVOKE_LIMIT_MS)).toEqual({
      code: 1
    });
    expect(deletes(h)).toEqual([`${SITE_A} Bearer ${keptA}`, `${HUB_A} Bearer ${hubKey}`]);
    expect(h.err()).toBe(ABORTED);
    expect([f.alive(keptA), f.alive(hubKey)]).toEqual([false, true]);
    expect(keysOfProfile(loadConfig(env).profiles.p!)).toEqual([]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles).toEqual({
      a: { apiKey: hubKey, baseUrl: HUB_A, email: ADA }
    });
  });
});
