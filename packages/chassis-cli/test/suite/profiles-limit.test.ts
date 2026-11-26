import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileSignIn, ProfilesListing } from '@antasphere/chassis-cli';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { ADA, BEA, fleet, HUB_A, HUB_B, SITE_A, SITE_B, type Harness } from './fleet.js';
import { kept, seedHub, seedTool } from './signin-fixtures.js';

/**
 * Every request `profiles --check` and `profiles add` send (the discovery
 * read, and `--check`'s `/me`) has a limit, `CliIo.requestTimeoutMs` (10 s
 * unless the io gives one): past it the request is aborted, and counts as no
 * answer. On the fleet of the sign-in suite, every key checked to reach its
 * own origin only, with sites that hold the connection open and never answer
 * (the way a host that drops packets does), and a limit of 50 ms.
 */

const { loadConfig } = cli;
const { bin, displayName } = cli.identity;

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
});
