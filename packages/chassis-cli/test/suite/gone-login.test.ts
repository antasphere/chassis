import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HUB_TOOL,
  keysOfProfile,
  updateConfig as updateCoreConfig,
  type CliProfile
} from '@antasphere/cli-core';
import type { ProfileEntry, ProfilesListing } from '@antasphere/chassis-cli';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { ADA, BEA, fleet, HUB_A, HUB_B, OLD, SITE_A, SITE_B, SITES, trace, type Harness } from './fleet.js';
import { fresh, kept, seedHub, seedTool } from './signin-fixtures.js';

/**
 * A login that leaves the machine and comes back (the coordinator's rulings
 * R2b and R2c, PRDCT-5192), on the fleet of the sign-in suite: two fake hubs
 * and three fake sites served by their origin (site-a names hub-a, site-b
 * names hub-b, old names none and trusts hub-a), and an `afterEach` that
 * fails when any request carried a hub key to another origin than its
 * login's hub, or a tool key to another origin than its site.
 *
 * - R2b: a kept key whose login is gone (no login at that key's hub with that
 *   key's address) is no longer dormant. The next command that resolves a
 *   credential on the profile revokes it on the profile's OWN site and
 *   forgets it, then goes on (an error included); the listing counts it in
 *   `staleKeys` until then. A login that comes back mints a new key.
 * - R2c: a profile remembers the origin of the hub of its last successful
 *   exchange (`lastHub`). A site that names no hub signs in at `--hub`, else
 *   `ANTASPHERE_URL`, else the hub of its newest kept key still in place,
 *   else that remembered hub while a login is in place there, else the
 *   pick-a-hub error, which then says the hub the profile last signed in
 *   through. A site that names its hub ignores the field.
 */

const { loadConfig } = cli;
const { bin } = cli.identity;

let f: ReturnType<typeof fleet>;

beforeEach(() => {
  f = fleet();
});

afterEach(() => {
  expect(f.violations()).toEqual([]);
});

/** ada's login at hub-a (`a`) and bea's at hub-b (`b`), `active` the hub file's active one. */
async function twoLogins(active: 'a' | 'b' = 'a') {
  const env: Record<string, string> = await tempConfigEnv();
  const logins: Record<'a' | 'b', CliProfile> = {
    a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA },
    b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA }
  };
  seedHub(env, { activeProfile: active, profiles: { ...logins } });
  return { env, logins };
}

/** A login leaves this machine: its entry goes from the hub file (its hub key stays alive at its hub). */
function signOut(env: Record<string, string>, name: string): void {
  updateCoreConfig(env, HUB_TOOL, (config) => {
    delete config.profiles[name];
  });
}

/** The same login back on this machine: its entry, as it was. */
function signBackIn(env: Record<string, string>, name: string, entry: CliProfile): void {
  updateCoreConfig(env, HUB_TOOL, (config) => {
    config.profiles[name] = { ...entry };
  });
}

/** One profile's entry of `profiles --json`. */
async function entryOf(env: Record<string, string>, name: string): Promise<ProfileEntry> {
  const h = f.harness(env);
  expect(await run(['profiles', '--json'], h.io)).toBe(0);
  const entry = (JSON.parse(h.out()) as ProfilesListing).profiles.find((p) => p.name === name);
  expect(entry).toBeDefined();
  return entry!;
}

/** The revoke requests of a harness, `origin+path` each. */
const revokes = (h: Harness) =>
  h.wire.filter((c) => c.method === 'DELETE').map((c) => `${c.origin}${c.path}`);

/** The tool-token requests of a harness: the hub each went to, and the key it carried. */
const toolTokens = (h: Harness) =>
  h.wire.filter((c) => c.path.endsWith('/sso/tool-token')).map((c) => [c.origin, c.auth]);

/** The kept keys of a profile, as `[hub, email]`. */
const keptOf = (env: Record<string, string>, name: string) =>
  (loadConfig(env).profiles[name]?.hubKeys ?? []).map((k) => [k.hub, k.email]);

/** The limit of each request the tests that shorten it give the io (`CliIo.requestTimeoutMs`). */
const LIMIT_MS = 50;

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

describe('R2b · a kept key whose login is gone is revoked by the next command, on its own site', () => {
  /** Profile b at site-b (it names hub-b), signed in once through bea's login there: the key it keeps. */
  async function signedInOnB() {
    const { env, logins } = await twoLogins();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A }, b: { baseUrl: SITE_B } } });
    expect(await run(['--profile', 'b', 'verify'], f.harness(env).io)).toBe(0);
    const keptB = loadConfig(env).profiles.b?.hubKeys?.[0]?.apiKey ?? '';
    expect(keptOf(env, 'b')).toEqual([[HUB_B, BEA]]);
    expect(f.alive(keptB)).toBe(true);
    return { env, logins, keptB };
  }

  const NO_LOGIN_AT_HUB_B =
    `Error: ${SITE_B} signs in through the Antasphere hub ${HUB_B}, and this machine holds no Antasphere ` +
    `login there. Run ${bin} --profile b login to sign in.\n`;

  it('the login at hub-b removed, --profile b verify: exactly one revoke, on site-b; the key forgotten; the needs-login error. The login back, verify again: exactly one exchange, at hub-b, and the command answers', async () => {
    const { env, logins, keptB } = await signedInOnB();

    signOut(env, 'b');
    const h = f.harness(env);
    expect(await run(['--profile', 'b', 'verify'], h.io)).toBe(1);
    expect(h.err()).toBe(NO_LOGIN_AT_HUB_B);
    expect(revokes(h)).toEqual([`${SITE_B}/api/v1/cli/auth/key`]);
    expect(h.wire.find((c) => c.method === 'DELETE')?.auth).toBe(`Bearer ${keptB}`);
    // Nothing of that command went anywhere but the profile's own site, and nothing was minted.
    expect(new Set(h.wire.map((c) => c.origin))).toEqual(new Set([SITE_B]));
    expect(toolTokens(h)).toEqual([]);
    expect(f.alive(keptB)).toBe(false);
    expect(keysOfProfile(loadConfig(env).profiles.b!)).toEqual([]);

    signBackIn(env, 'b', logins.b);
    const exchanged = f.exchanges();
    const back = f.harness(env);
    expect(await run(['--profile', 'b', 'verify'], back.io)).toBe(0);
    expect(back.out()).toBe(`ok — ${BEA} (owner) @ ${SITE_B}\n`);
    expect(f.exchanges()).toBe(exchanged + 1);
    expect(toolTokens(back)).toEqual([[HUB_B, `Bearer ${logins.b.apiKey}`]]);
    expect(revokes(back)).toEqual([]);
    // A login that comes back mints a new key, kept for its account at its hub.
    expect(keptOf(env, 'b')).toEqual([[HUB_B, BEA]]);
    expect(loadConfig(env).profiles.b?.hubKeys?.[0]?.apiKey).not.toBe(keptB);
  });

  it('the listing counts that key before the command (staleKeys 1), and nothing once the command revoked it (0)', async () => {
    const { env } = await signedInOnB();
    const needsLogin = (staleKeys: number) => ({
      state: 'needs_login',
      via: null,
      hub: HUB_B,
      email: null,
      staleKeys,
      fix: { kind: 'hub_login', argv: [bin, '--profile', 'b', 'login'] }
    });

    signOut(env, 'b');
    expect((await entryOf(env, 'b')).signIn).toEqual(needsLogin(1));
    // The listing itself revokes nothing.
    expect(f.alive(loadConfig(env).profiles.b?.hubKeys?.[0]?.apiKey ?? '')).toBe(true);

    expect(await run(['--profile', 'b', 'verify'], f.harness(env).io)).toBe(1);
    expect((await entryOf(env, 'b')).signIn).toEqual(needsLogin(0));
  });
});

describe('R2b · a profile that serves its own key revokes a gone login’s kept key too, before its first request (F2)', () => {
  /** Profile a at site-a: its own key, and a key kept for ada at hub-a, whose login is gone (bea's at hub-b stays). */
  async function ownKeyAndGoneLogin() {
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, { profiles: { b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA } } });
    const own = f.toolKey(SITE_A, ADA, 'own');
    const keptA = f.toolKey(SITE_A, ADA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: { baseUrl: SITE_A, apiKey: own, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, keptA)] }
      }
    });
    return { env, own, keptA };
  }

  it('verify sends one revoke, of the kept key, on site-a, before its /me, and nothing elsewhere; the key forgotten, the listing counts 0, and the next command revokes nothing', async () => {
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    expect((await entryOf(env, 'a')).signIn.staleKeys).toBe(1);

    const h = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe('');
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(h.wire.map((c) => c.auth)).toEqual([`Bearer ${keptA}`, `Bearer ${own}`]);
    expect([f.alive(keptA), f.alive(own)]).toEqual([false, true]);
    expect(keysOfProfile(loadConfig(env).profiles.a!)).toEqual([{ apiKey: own, kind: 'own' }]);
    expect((await entryOf(env, 'a')).signIn).toEqual({
      state: 'signed_in',
      via: 'key',
      hub: null,
      email: null,
      staleKeys: 0,
      fix: null
    });

    const next = f.harness(env);
    expect(await run(['--profile', 'a', 'whoami', '--json'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET ${SITE_A}/api/v1/me`]);
  });

  it('a site that does not answer the revoke: the command still answers, the key stays, and the listing still counts it', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, down: 'revoke' }, ...SITES.slice(1)]);
    const { env, keptA } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(f.alive(keptA)).toBe(true);
    expect(loadConfig(env).profiles.a?.hubKeys?.map((k) => k.apiKey)).toEqual([keptA]);
    expect((await entryOf(env, 'a')).signIn.staleKeys).toBe(1);
  });

  it('a site that holds the revoke open: the revoke is given up at the io’s limit, the command goes on to its own request and answers, and the key stays on disk for the next command (verifier round 4, finding 4)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, silent: 'revoke' }, ...SITES.slice(1)]);
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    h.io.requestTimeoutMs = LIMIT_MS;
    expect(await endsWithin(run(['--profile', 'a', 'verify'], h.io), 2_000)).toEqual({ code: 0 });
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe('');
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(h.wire.map((c) => c.auth)).toEqual([`Bearer ${keptA}`, `Bearer ${own}`]);
    expect(f.alive(keptA)).toBe(true);
    expect(loadConfig(env).profiles.a?.hubKeys?.map((k) => k.apiKey)).toEqual([keptA]);
  }, 10_000);
});

describe('R2c · a site that names no hub signs in again at the hub its profile last signed in through', () => {
  const PICK_HUB = { kind: 'pick_hub', argv: [bin, '--profile', 'old', 'login', '--hub'] };

  it('old signed in once with login --hub hub-a; the login removed, a command revokes its kept key on old and the pick-a-hub error says it last signed in through hub-a; the login back, verify: exactly one exchange, at hub-a, no pick-a-hub error, the hub key at hub-a only', async () => {
    // The hub file's active login is bea's at hub-b: it plays no part.
    const { env, logins } = await twoLogins('b');
    seedTool(env, { activeProfile: 'old', profiles: { old: { baseUrl: OLD } } });
    expect(await run(['login', '--hub', HUB_A], f.harness(env).io)).toBe(0);
    const keptOld = loadConfig(env).profiles.old?.hubKeys?.[0]?.apiKey ?? '';
    expect(keptOf(env, 'old')).toEqual([[HUB_A, ADA]]);
    expect(loadConfig(env).profiles.old?.lastHub).toBe(HUB_A);

    signOut(env, 'a');
    // From the files alone: no hub to sign in at, and the kept key counted for its revoke.
    const needsHub = (staleKeys: number) => ({
      state: 'needs_login',
      via: null,
      hub: null,
      email: null,
      staleKeys,
      fix: PICK_HUB
    });
    expect((await entryOf(env, 'old')).signIn).toEqual(needsHub(1));

    const h = f.harness(env);
    expect(await run(['verify'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: ${OLD} names no Antasphere hub (it runs a version from before sites named theirs), and profile ` +
        `"old" last signed in through ${HUB_A}, where this machine holds no login now. This machine holds 1 ` +
        `Antasphere login: ${BEA} at ${HUB_B}. Pick the hub this site trusts: ${bin} --profile old login ` +
        '--hub <hub>.\n'
    );
    expect(revokes(h)).toEqual([`${OLD}/api/v1/cli/auth/key`]);
    expect(h.wire.find((c) => c.method === 'DELETE')?.auth).toBe(`Bearer ${keptOld}`);
    expect(toolTokens(h)).toEqual([]);
    expect(f.alive(keptOld)).toBe(false);
    expect(keysOfProfile(loadConfig(env).profiles.old!)).toEqual([]);
    // What the profile remembers of its last sign-in outlives the key.
    expect(loadConfig(env).profiles.old?.lastHub).toBe(HUB_A);
    expect((await entryOf(env, 'old')).signIn).toEqual(needsHub(0));

    signBackIn(env, 'a', logins.a);
    // A login is in place at the remembered hub again: the next command signs in there by itself.
    expect((await entryOf(env, 'old')).signIn).toEqual({
      state: 'will_sign_in',
      via: 'login',
      hub: HUB_A,
      email: ADA,
      staleKeys: 0,
      fix: null
    });

    const exchanged = f.exchanges();
    const back = f.harness(env);
    expect(await run(['verify'], back.io)).toBe(0);
    expect(back.out()).toBe(`ok — ${ADA} (owner) @ ${OLD}\n`);
    expect(back.err()).toBe(`Connected to ${OLD} as ${ADA} via Antasphere.\n`);
    expect(trace(back)).toEqual([
      `GET ${OLD}/api/v1/instance`,
      `POST ${HUB_A}/api/v1/sso/tool-token`,
      `POST ${OLD}/api/v1/sso/cli-connect`,
      `GET ${OLD}/api/v1/me`
    ]);
    expect(f.exchanges()).toBe(exchanged + 1);
    // ada's hub key reaches hub-a's origin, and no other.
    expect(back.wire.filter((c) => c.auth === `Bearer ${logins.a.apiKey}`).map((c) => c.origin)).toEqual([
      HUB_A
    ]);
    expect(keptOf(env, 'old')).toEqual([[HUB_A, ADA]]);
  });

  it('a site that names hub-b ignores a lastHub of hub-a: the listing and the command sign in at hub-b, and nothing reaches hub-a', async () => {
    const { env, logins } = await twoLogins('a');
    seedTool(env, {
      activeProfile: 'b',
      profiles: { b: { baseUrl: SITE_B, site: fresh(HUB_B), lastHub: HUB_A } }
    });
    expect((await entryOf(env, 'b')).signIn).toEqual({
      state: 'will_sign_in',
      via: 'login',
      hub: HUB_B,
      email: BEA,
      staleKeys: 0,
      fix: null
    });

    const h = f.harness(env);
    expect(await run(['verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${BEA} (owner) @ ${SITE_B}\n`);
    expect(trace(h)).toEqual([
      `GET ${SITE_B}/api/v1/instance`,
      `POST ${HUB_B}/api/v1/sso/tool-token`,
      `POST ${SITE_B}/api/v1/sso/cli-connect`,
      `GET ${SITE_B}/api/v1/me`
    ]);
    expect(toolTokens(h)).toEqual([[HUB_B, `Bearer ${logins.b.apiKey}`]]);
    expect(h.wire.some((c) => c.auth === `Bearer ${logins.a.apiKey}`)).toBe(false);
    // The exchange went through hub-b: that is the hub the profile remembers now.
    expect(loadConfig(env).profiles.b?.lastHub).toBe(HUB_B);
    expect(keptOf(env, 'b')).toEqual([[HUB_B, BEA]]);
  });

  it('the same, on a profile that never reached its site: its discovery names hub-b, and the command signs in there', async () => {
    const { env, logins } = await twoLogins('a');
    seedTool(env, { activeProfile: 'b', profiles: { b: { baseUrl: SITE_B, lastHub: HUB_A } } });
    const h = f.harness(env);
    expect(await run(['verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${BEA} (owner) @ ${SITE_B}\n`);
    expect(toolTokens(h)).toEqual([[HUB_B, `Bearer ${logins.b.apiKey}`]]);
    expect(h.wire.some((c) => c.origin === HUB_A)).toBe(false);
    expect(loadConfig(env).profiles.b?.lastHub).toBe(HUB_B);
  });
});
