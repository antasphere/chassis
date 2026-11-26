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
import { ADA, BEA, fleet, HUB_A, HUB_B, SITE_A, SITE_B, type Harness } from './fleet.js';
import { seedHub, seedTool } from './signin-fixtures.js';

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
