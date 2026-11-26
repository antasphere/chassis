import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
import {
  ADA,
  BEA,
  CY,
  fleet,
  HUB_A,
  HUB_B,
  OLD,
  SITE_A,
  SITE_B,
  SITES,
  trace,
  type Harness
} from './fleet.js';
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
const { bin, envPrefix: P } = cli.identity;

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

/** The limit the tests of a settle that waits one limit at most give the io: their bound is two of it. */
const STOP_LIMIT_MS = 200;

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

  it('a site that holds the revoke open: cli-core’s revoke is given up at the io’s limit, the command goes on to its sign-in and answers, and the key stays on disk for the next command (verifier round 4, addition 1 to finding 4)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, silent: 'revoke' }, ...SITES.slice(1)]);
    const env: Record<string, string> = await tempConfigEnv();
    // Profile a keeps a key for ada at hub-a, whose login is gone; cy's login at hub-a signs it in.
    seedHub(env, { profiles: { c: { apiKey: f.hubKey(HUB_A, CY), baseUrl: HUB_A, email: CY } } });
    const keptA = f.toolKey(SITE_A, ADA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: { a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, keptA)] } }
    });
    const h = f.harness(env);
    h.io.requestTimeoutMs = LIMIT_MS;
    // Well within cli-core's own limit of 10 s.
    expect(await endsWithin(run(['--profile', 'a', 'verify'], h.io), 2_000)).toEqual({ code: 0 });
    expect(h.out()).toBe(`ok — ${CY} (owner) @ ${SITE_A}\n`);
    expect(revokes(h)).toEqual([`${SITE_A}/api/v1/cli/auth/key`]);
    expect(h.wire.find((c) => c.method === 'DELETE')?.auth).toBe(`Bearer ${keptA}`);
    expect(f.alive(keptA)).toBe(true);
    expect(loadConfig(env).profiles.a?.hubKeys?.map((k) => k.apiKey)).toContain(keptA);
  }, 20_000);
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

  /**
   * Profile a at site-a: its own key, and a key kept at hub-a for each of ada, bea and cy, none of whom
   * holds a login there (bea's is at hub-b): three stale keys, revoked in that order.
   */
  async function ownKeyAndThreeStale() {
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, { profiles: { b: { apiKey: f.hubKey(HUB_B, BEA), baseUrl: HUB_B, email: BEA } } });
    const own = f.toolKey(SITE_A, ADA, 'own');
    const emails = [ADA, BEA, CY];
    const stale = emails.map((email) => f.toolKey(SITE_A, email));
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: {
          baseUrl: SITE_A,
          apiKey: own,
          site: fresh(HUB_A),
          hubKeys: emails.map((email, i) => kept(HUB_A, email, stale[i]!))
        }
      }
    });
    return { env, own, stale };
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

  it('three stale keys at a site that holds every revoke open: the first revoke, given up at the io’s limit, ends the settle; one DELETE, the command answers within two limits, and the three keys stay for the next command (verifier round 5, finding 1)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, silent: 'revoke' }, ...SITES.slice(1)]);
    const { env, own, stale } = await ownKeyAndThreeStale();
    const h = f.harness(env);
    h.io.requestTimeoutMs = STOP_LIMIT_MS;
    expect(await endsWithin(run(['--profile', 'a', 'verify'], h.io), 2 * STOP_LIMIT_MS)).toEqual({ code: 0 });
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe('');
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(h.wire.map((c) => c.auth)).toEqual([`Bearer ${stale[0]}`, `Bearer ${own}`]);
    expect(stale.map((k) => f.alive(k))).toEqual([true, true, true]);
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([own, ...stale]);
  }, 10_000);

  it('the site answers the first stale key’s revoke and holds the second open: the second ends the settle; two DELETEs, the first key forgotten, the second and the third kept for the next command (verifier round 5, finding 1)', async () => {
    const { env, own, stale } = await ownKeyAndThreeStale();
    f.hold(stale[1]!);
    const h = f.harness(env);
    h.io.requestTimeoutMs = STOP_LIMIT_MS;
    expect(await endsWithin(run(['--profile', 'a', 'verify'], h.io), 2 * STOP_LIMIT_MS)).toEqual({ code: 0 });
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe('');
    expect(trace(h)).toEqual([
      `DELETE ${SITE_A}/api/v1/cli/auth/key`,
      `DELETE ${SITE_A}/api/v1/cli/auth/key`,
      `GET ${SITE_A}/api/v1/me`
    ]);
    expect(h.wire.map((c) => c.auth)).toEqual([`Bearer ${stale[0]}`, `Bearer ${stale[1]}`, `Bearer ${own}`]);
    expect(stale.map((k) => f.alive(k))).toEqual([false, true, true]);
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([
      own,
      stale[1],
      stale[2]
    ]);
  }, 10_000);

  it('a stale key another profile at the site holds, after the site gave no answer: still forgotten here with its line, since it sends nothing (verifier round 5, finding 1)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, silent: 'revoke' }, ...SITES.slice(1)]);
    const { env, own, stale } = await ownKeyAndThreeStale();
    // A twin at site-a (a file from before one profile per site) holds the third.
    cli.updateConfig(env, (config) => {
      config.profiles['a-twin'] = { baseUrl: `${SITE_A}/`, hubKeys: [kept(HUB_A, CY, stale[2]!)] };
    });
    const h = f.harness(env);
    h.io.requestTimeoutMs = STOP_LIMIT_MS;
    expect(await endsWithin(run(['--profile', 'a', 'verify'], h.io), 2 * STOP_LIMIT_MS)).toEqual({ code: 0 });
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe(`Kept on ${SITE_A}: profile "a-twin" still holds that key.\n`);
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(h.wire[0]?.auth).toBe(`Bearer ${stale[0]}`);
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([
      own,
      stale[0],
      stale[1]
    ]);
    expect(loadConfig(env).profiles['a-twin']?.hubKeys?.map((k) => k.apiKey)).toEqual([stale[2]]);
    expect(f.alive(stale[2]!)).toBe(true);
  }, 10_000);

  /** The two lines of a revoke the site answered without revoking, in the kit's own words (`revokeOnSite`). */
  const ALREADY_UNUSABLE = 'A stale key this profile kept was already unusable; forgetting it.\n';
  const REFUSED =
    'The instance refused to revoke a stale key this profile kept (forbidden): it STAYS VALID server-side; ' +
    'revoke it from the dashboard. Forgetting the local copy.\n';

  it('the site answers the revoke 401 (the kept key already dead there): its one line, once, and the key forgotten (verifier round 4, note 14)', async () => {
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    f.kill(keptA);
    const h = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe(ALREADY_UNUSABLE);
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(keysOfProfile(loadConfig(env).profiles.a!)).toEqual([{ apiKey: own, kind: 'own' }]);
  });

  it('the site refuses the revoke (403): its one line, once, saying the key stays valid there; the key forgotten here, and the next command sends no revoke (verifier round 4, note 14)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, revokeAnswer: 403 }, ...SITES.slice(1)]);
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe(REFUSED);
    expect(trace(h)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(f.alive(keptA)).toBe(true);
    expect(keysOfProfile(loadConfig(env).profiles.a!)).toEqual([{ apiKey: own, kind: 'own' }]);

    const next = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], next.io)).toBe(0);
    expect(next.err()).toBe('');
    expect(trace(next)).toEqual([`GET ${SITE_A}/api/v1/me`]);
  });

  it('the site fails the revoke (500): no line, the key kept, and the next command sends the revoke again (verifier round 4, note 14)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, revokeAnswer: 500 }, ...SITES.slice(1)]);
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(h.err()).toBe('');
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([own, keptA]);

    const next = f.harness(env);
    expect(await run(['--profile', 'a', 'verify'], next.io)).toBe(0);
    expect(next.err()).toBe('');
    expect(trace(next)).toEqual([`DELETE ${SITE_A}/api/v1/cli/auth/key`, `GET ${SITE_A}/api/v1/me`]);
    expect(next.wire[0]?.auth).toBe(`Bearer ${keptA}`);
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([own, keptA]);
  });

  it('a stale key the site answers 401 for (dead there already) is forgotten: the listing counts it before the command (1), and not after (0) (verifier round 4, finding 9: C2f)', async () => {
    const { env, keptA } = await ownKeyAndGoneLogin();
    f.kill(keptA);
    expect((await entryOf(env, 'a')).signIn.staleKeys).toBe(1);
    expect(await run(['--profile', 'a', 'verify'], f.harness(env).io)).toBe(0);
    expect((await entryOf(env, 'a')).signIn.staleKeys).toBe(0);
  });

  it('a forget that cannot be made (the tool file’s lock held by a live process past the lock’s wait) never fails the command: it answers, exit 0 (verifier round 4, finding 9: C2i)', async () => {
    const { env } = await ownKeyAndGoneLogin();
    const lock = `${cli.configPath(env)}.lock`;
    const holder = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      writeFileSync(
        lock,
        JSON.stringify({ pid: holder.pid, host: hostname(), token: 'another', at: new Date().toISOString() })
      );
      const h = f.harness(env);
      expect(await run(['--profile', 'a', 'verify'], h.io)).toBe(0);
      expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
      expect(h.err()).toBe('');
    } finally {
      holder.kill('SIGKILL');
      rmSync(lock, { force: true });
    }
  }, 30_000);

  it('a command served by an exported key settles nothing: no revoke, and the profile’s keys stay (verifier round 4, finding 9: C2k)', async () => {
    const { env, own, keptA } = await ownKeyAndGoneLogin();
    const envKey = f.toolKey(SITE_A, ADA, 'envk');
    const h = f.harness({ ...env, [`${P}_URL`]: SITE_A, [`${P}_API_KEY`]: envKey });
    expect(await run(['verify'], h.io)).toBe(0);
    expect(h.wire).toEqual([{ method: 'GET', origin: SITE_A, path: '/api/v1/me', auth: `Bearer ${envKey}` }]);
    expect(f.alive(keptA)).toBe(true);
    expect(keysOfProfile(loadConfig(env).profiles.a!).map((k) => k.apiKey)).toEqual([own, keptA]);
  });

  it('a command that makes two requests on the own key settles once: one revoke, before the first, even when the site does not answer it (verifier round 4, finding 9: C2d)', async () => {
    f = fleet([{ origin: SITE_A, names: HUB_A, trusts: HUB_A, down: 'revoke' }, ...SITES.slice(1)]);
    const { env } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    // A workspace named by its name costs one /me before the command's own.
    expect(await run(['--profile', 'a', '--workspace', 'Acme', 'verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
    expect(trace(h)).toEqual([
      `DELETE ${SITE_A}/api/v1/cli/auth/key`,
      `GET ${SITE_A}/api/v1/me`,
      `GET ${SITE_A}/api/v1/me`
    ]);
  });

  it('the command returns only once its revoke has ended, and the stale key is off the disk when it does (verifier round 4, finding 9: C2b)', async () => {
    const { env, own } = await ownKeyAndGoneLogin();
    const h = f.harness(env);
    const events: string[] = [];
    const inner = h.io.fetch!;
    h.io.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const what = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      events.push(`${what} sent`);
      // The revoke takes its time: a command that did not wait for it would return first.
      if (init?.method === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 200));
      const res = await inner(input, init);
      events.push(`${what} answered`);
      return res;
    };
    const code = await run(['--profile', 'a', 'verify'], h.io);
    // What had happened when the command returned, and what the file held then.
    const happened = [...events];
    const onDisk = keysOfProfile(loadConfig(env).profiles.a!);
    expect(code).toBe(0);
    expect(happened).toContain('DELETE /api/v1/cli/auth/key answered');
    expect(onDisk).toEqual([{ apiKey: own, kind: 'own' }]);
  });
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
