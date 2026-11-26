import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HUB_TOOL,
  keysOfProfile,
  loadConfig as loadCoreConfig,
  updateConfig as updateCoreConfig
} from '@antasphere/cli-core';
import { DEFAULT_HUB_URL, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { fresh, kept, seedHub, seedTool } from './signin-fixtures.js';
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

/**
 * The sign-in follows the site (R2, PRDCT-3521, PRDCT-5192), and the two
 * invariants it rests on, every scenario of this file run on one fleet: two
 * fake hubs and three fake sites, each served by its ORIGIN through the
 * harness (`Route.origin`), and an `afterEach` that fails when any request
 * carried a hub key to another origin than its login's hub, or a tool key
 * (own or kept) to another origin than its site.
 *
 * - `https://hub-a.example.com` and `https://hub-b.example.com` know the hub
 *   keys of their own logins and mint tokens for the sites that trust them.
 * - `https://site-a.example.com` names hub-a, `https://site-b.example.com`
 *   names hub-b, `https://old.example.com` names none (it runs a version from
 *   before sites named theirs) and trusts hub-a. Each mints, serves and
 *   revokes its own keys.
 */

const { loadConfig } = cli;
const { bin, envPrefix: P, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

let f: ReturnType<typeof fleet>;

beforeEach(() => {
  f = fleet();
});

afterEach(() => {
  expect(f.violations()).toEqual([]);
});

/** A machine with a login at each hub (ada at hub-a, bea at hub-b), `active` being the hub file's active one. */
async function twoLogins(active: 'a' | 'b' = 'a') {
  const env: Record<string, string> = await tempConfigEnv();
  const keyA = f.hubKey(HUB_A, ADA);
  const keyB = f.hubKey(HUB_B, BEA);
  seedHub(env, {
    activeProfile: active,
    profiles: {
      a: { apiKey: keyA, baseUrl: HUB_A, email: ADA },
      b: { apiKey: keyB, baseUrl: HUB_B, email: BEA }
    }
  });
  return { env, keyA, keyB };
}

describe('a command signs in with the login at the hub its site names (R2)', () => {
  it.each(['a', 'b'] as const)(
    'the hub file’s active login is %s: --profile a verify answers as ada through hub-a, --profile b verify as bea through hub-b',
    async (active) => {
      const { env, keyA, keyB } = await twoLogins(active);
      seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A }, b: { baseUrl: SITE_B } } });

      const a = f.harness(env);
      expect(await run(['verify', '--profile', 'a'], a.io)).toBe(0);
      expect(a.out()).toBe(`ok — ${ADA} (owner) @ ${SITE_A}\n`);
      expect(trace(a)).toEqual([
        `GET ${SITE_A}/api/v1/instance`,
        `POST ${HUB_A}/api/v1/sso/tool-token`,
        `POST ${SITE_A}/api/v1/sso/cli-connect`,
        `GET ${SITE_A}/api/v1/me`
      ]);
      expect(a.wire[1]?.auth).toBe(`Bearer ${keyA}`);

      const b = f.harness(env);
      expect(await run(['verify', '--profile', 'b'], b.io)).toBe(0);
      expect(b.out()).toBe(`ok — ${BEA} (owner) @ ${SITE_B}\n`);
      expect(b.wire[1]).toMatchObject({ origin: HUB_B, auth: `Bearer ${keyB}` });

      // Each profile keeps its key, filed by its hub and account; the next commands exchange nothing.
      const { profiles } = loadConfig(env);
      expect(profiles.a?.hubKeys?.map((k) => [k.hub, k.email])).toEqual([[HUB_A, ADA]]);
      expect(profiles.b?.hubKeys?.map((k) => [k.hub, k.email])).toEqual([[HUB_B, BEA]]);
      const before = f.exchanges();
      for (const [name, email, site] of [
        ['a', ADA, SITE_A],
        ['b', BEA, SITE_B]
      ] as const) {
        const again = f.harness(env);
        expect(await run(['verify', '--profile', name], again.io)).toBe(0);
        expect(again.out()).toBe(`ok — ${email} (owner) @ ${site}\n`);
        expect(trace(again)).toEqual([`GET ${site}/api/v1/me`]);
      }
      expect(f.exchanges()).toBe(before);
      // Nothing of the hub file moved.
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe(active);
    }
  );

  it('ANTASPHERE_URL naming another hub than the site’s: refused, both named, and not one request', async () => {
    const { env } = await twoLogins();
    seedTool(env, {
      profiles: {
        a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, f.toolKey(SITE_A, ADA))] }
      }
    });
    const h = f.harness({ ...env, ANTASPHERE_URL: HUB_B });
    expect(await run(['verify', '--profile', 'a'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: ${SITE_A} signs in through the Antasphere hub ${HUB_A}, and ANTASPHERE_URL names ${HUB_B}. ` +
        'Unset ANTASPHERE_URL: a site that names its hub decides it.\n'
    );
    expect(h.wire).toEqual([]);
  });

  it('login --hub naming another hub than the site’s: refused after its one discovery read, both named', async () => {
    const { env } = await twoLogins();
    seedTool(env, { profiles: { a: { baseUrl: SITE_A } } });
    const h = f.harness(env);
    expect(await run(['login', '--profile', 'a', '--hub', HUB_B], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: ${SITE_A} signs in through the Antasphere hub ${HUB_A}, and --hub names ${HUB_B}. ` +
        'Drop --hub: a site that names its hub decides it.\n'
    );
    expect(trace(h)).toEqual([`GET ${SITE_A}/api/v1/instance`]);
  });
});

describe('a site that names no hub', () => {
  it('login --hub names the hub it signs in at, and its kept key carries that hub from then on', async () => {
    const { env, keyA } = await twoLogins('b');
    seedTool(env, { activeProfile: 'old', profiles: { old: { baseUrl: OLD } } });
    const h = f.harness(env);
    expect(await run(['login', '--hub', HUB_A], h.io)).toBe(0);
    expect(h.out()).toBe(`Signed in as Ada <${ADA}> in Acme on ${OLD}.\n`);
    expect(h.wire.find((c) => c.path === '/api/v1/sso/tool-token')).toMatchObject({
      origin: HUB_A,
      auth: `Bearer ${keyA}`
    });

    const next = f.harness(env);
    expect(await run(['verify'], next.io)).toBe(0);
    expect(next.out()).toBe(`ok — ${ADA} (owner) @ ${OLD}\n`);
    expect(trace(next)).toEqual([`GET ${OLD}/api/v1/me`]);
  });

  it('ANTASPHERE_URL names the hub it signs in at', async () => {
    const { env } = await twoLogins('b');
    seedTool(env, { activeProfile: 'old', profiles: { old: { baseUrl: OLD } } });
    const h = f.harness({ ...env, ANTASPHERE_URL: HUB_A });
    expect(await run(['verify'], h.io)).toBe(0);
    expect(h.out()).toBe(`ok — ${ADA} (owner) @ ${OLD}\n`);
    expect(h.wire.find((c) => c.path === '/api/v1/sso/tool-token')?.origin).toBe(HUB_A);
  });

  it('with nothing that names it: the sentence naming the logins and the one command, and no exchange — never a guess, even with one login', async () => {
    const { env } = await twoLogins();
    seedTool(env, { activeProfile: 'old', profiles: { old: { baseUrl: OLD } } });
    const h = f.harness(env);
    expect(await run(['verify'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: ${OLD} names no Antasphere hub (it runs a version from before sites named theirs), and profile ` +
        `"old" has never signed in there. This machine holds 2 Antasphere logins: ${ADA} at ${HUB_A}, ${BEA} ` +
        `at ${HUB_B}. Pick the hub this site trusts: ${bin} --profile old login --hub <hub>.\n`
    );
    expect(trace(h)).toEqual([`GET ${OLD}/api/v1/instance`]);

    const one: Record<string, string> = await tempConfigEnv();
    seedHub(one, { profiles: { a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA } } });
    seedTool(one, { activeProfile: 'old', profiles: { old: { baseUrl: OLD } } });
    const single = f.harness(one);
    expect(await run(['verify'], single.io)).toBe(1);
    expect(single.err()).toContain(`This machine holds 1 Antasphere login: ${ADA} at ${HUB_A}.`);
    expect(single.wire.some((c) => c.path === '/api/v1/sso/tool-token')).toBe(false);
  });
});

describe('whoami names the login of the site’s hub, never another (PRDCT-3364)', () => {
  it('the hub file’s active login is bea at hub-b; on site-a whoami names ada at hub-a, in its text and its JSON', async () => {
    const { env } = await twoLogins('b');
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, f.toolKey(SITE_A, ADA))] }
      }
    });
    const h = f.harness(env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe(`Ada <${ADA}>`);
    expect(h.out()).toContain(`  signed in with: the Antasphere login ${ADA} at ${HUB_A} (kept key)\n`);
    expect(h.out()).not.toContain(BEA);
    expect(h.out()).not.toContain(HUB_B);

    const json = f.harness(env);
    expect(await run(['whoami', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({
      credentialSource: 'hub-cache',
      profile: 'a',
      login: { hub: HUB_A, email: ADA }
    });
    expect(json.out()).not.toContain(BEA);
  });

  it('a fresh sign-in on site-b names bea at hub-b, whatever is active', async () => {
    const { env } = await twoLogins('a');
    seedTool(env, { profiles: { b: { baseUrl: SITE_B } } });
    const h = f.harness(env);
    expect(await run(['whoami', '--profile', 'b'], h.io)).toBe(0);
    expect(h.out()).toContain(`  signed in with: the Antasphere login ${BEA} at ${HUB_B} (fresh sign-in)\n`);
    expect(h.out()).not.toContain(ADA);
  });
});

describe('logout revokes on the profile’s own site, --all at the login’s own hub, and nowhere else', () => {
  async function signedIn() {
    const { env, keyA, keyB } = await twoLogins('a');
    const own = f.toolKey(SITE_A, ADA, 'own');
    const keptA = f.toolKey(SITE_A, ADA);
    const keptB = f.toolKey(SITE_B, BEA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: { baseUrl: SITE_A, apiKey: own, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, keptA)] },
        b: { baseUrl: SITE_B, site: fresh(HUB_B), hubKeys: [kept(HUB_B, BEA, keptB)] }
      }
    });
    return { env, keyA, keyB, own, keptA, keptB };
  }

  it('logout: every key of the profile revoked on site-a alone; the logins and the other profile untouched', async () => {
    const { env, keyA, keyB, own, keptA, keptB } = await signedIn();
    const h = f.harness(env);
    expect(await run(['logout', '--profile', 'a'], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.origin}`)).toEqual([`DELETE ${SITE_A}`, `DELETE ${SITE_A}`]);
    expect([f.alive(own), f.alive(keptA)]).toEqual([false, false]);
    expect([f.alive(keyA), f.alive(keyB), f.alive(keptB)]).toEqual([true, true, true]);
    expect(h.out()).toBe(
      `Logged out of profile "a" on ${SITE_A} (2 keys revoked server-side). The Antasphere login ${ADA} at ` +
        `${HUB_A} stays for the whole tool family.\n`
    );
    expect(loadConfig(env).profiles.a).toEqual({ baseUrl: SITE_A, site: expect.any(Object) });
  });

  it('logout --all: the keys on site-a, then ada’s login at hub-a, its entry and the active mark gone; bea’s login stays', async () => {
    const { env, keyA, keyB, keptB } = await signedIn();
    const h = f.harness(env);
    expect(await run(['logout', '--profile', 'a', '--all', '--json'], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.origin}`)).toEqual([
      `DELETE ${SITE_A}`,
      `DELETE ${SITE_A}`,
      `DELETE ${HUB_A}`
    ]);
    expect(h.wire[2]?.auth).toBe(`Bearer ${keyA}`);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'a',
      baseUrl: SITE_A,
      revoked: 2,
      refused: 0,
      forgotten: true,
      logins: [{ hub: HUB_A, email: ADA, revoked: true }]
    });
    expect([f.alive(keyA), f.alive(keyB), f.alive(keptB)]).toEqual([false, true, true]);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      profiles: { b: { apiKey: keyB, baseUrl: HUB_B, email: BEA } }
    });
  });

  it('logout on a site that does not answer: exit 1 naming it, and every key stays on disk, alive, for the next attempt', async () => {
    const DOWN = 'https://down.example.com';
    f = fleet([...SITES, { origin: DOWN, names: HUB_A, trusts: HUB_A, down: true }]);
    const env: Record<string, string> = await tempConfigEnv();
    const own = f.toolKey(DOWN, ADA, 'own');
    const keptD = f.toolKey(DOWN, ADA);
    seedTool(env, {
      activeProfile: 'd',
      profiles: { d: { baseUrl: DOWN, apiKey: own, hubKeys: [kept(HUB_A, ADA, keptD)] } }
    });
    const h = f.harness(env);
    expect(await run(['logout'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Nothing answers at ${DOWN} (profile "d"). Check the address, or try again.\n`
    );
    expect(keysOfProfile(loadConfig(env).profiles.d).map((k) => k.apiKey)).toEqual([own, keptD]);
    expect([f.alive(own), f.alive(keptD)]).toEqual([true, true]);
  });
});

describe('login --email replaces the login at its hub only (ruling 3)', () => {
  it('cy replaces ada at hub-a: the line, ada’s hub key revoked at hub-a, ada’s kept key on site-a; bea at hub-b untouched', async () => {
    const { env, keyA, keyB } = await twoLogins('b');
    const keptA = f.toolKey(SITE_A, ADA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: { a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, keptA)] } }
    });
    const h = f.harness(env);
    h.io.prompt = async () => '123456';
    expect(await run(['login', '--email', CY], h.io)).toBe(0);
    expect(h.err()).toContain(`Replacing the Antasphere login ${ADA} with ${CY}.\n`);
    expect(h.out()).toBe(`Signed in as Cy <${CY}> in Acme on ${SITE_A}.\n`);
    expect([f.alive(keyA), f.alive(keptA), f.alive(keyB)]).toEqual([false, false, true]);
    const hubConfig = loadCoreConfig(env, HUB_TOOL);
    expect(hubConfig.activeProfile).toBe('b');
    expect(Object.keys(hubConfig.profiles)).toEqual(['a', 'b']);
    expect(hubConfig.profiles.a).toMatchObject({ baseUrl: HUB_A, email: CY });
    expect(hubConfig.profiles.b).toEqual({ apiKey: keyB, baseUrl: HUB_B, email: BEA });
    expect(loadConfig(env).profiles.a?.hubKeys?.map((k) => [k.hub, k.email])).toEqual([[HUB_A, CY]]);
  });

  it('cy replaces ada while the hub file holds an entry whose hub cannot be told: the replacement revokes ada’s kept key on site-a itself (unknown is not gone, so nothing else would)', async () => {
    const env: Record<string, string> = await tempConfigEnv();
    const keyA = f.hubKey(HUB_A, ADA);
    seedHub(env, {
      activeProfile: 'a',
      profiles: {
        a: { apiKey: keyA, baseUrl: HUB_A, email: ADA },
        smudged: {
          apiKey: f.hubKey(HUB_A, 'zed@example.com'),
          baseUrl: 'not a url',
          email: 'zed@example.com'
        }
      }
    });
    const keptA = f.toolKey(SITE_A, ADA);
    seedTool(env, {
      activeProfile: 'a',
      profiles: { a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, keptA)] } }
    });
    const h = f.harness(env);
    h.io.prompt = async () => '123456';
    expect(await run(['login', '--email', CY], h.io)).toBe(0);
    expect(h.err()).toContain(`Replacing the Antasphere login ${ADA} with ${CY}.\n`);
    expect(h.wire.filter((c) => c.method === 'DELETE').map((c) => `${c.origin} ${c.auth}`)).toEqual([
      `${HUB_A} Bearer ${keyA}`,
      `${SITE_A} Bearer ${keptA}`
    ]);
    expect([f.alive(keyA), f.alive(keptA)]).toEqual([false, false]);
    expect(loadConfig(env).profiles.a?.hubKeys?.map((k) => [k.hub, k.email])).toEqual([[HUB_A, CY]]);
  });

  it('--email naming an account not signed in at the site’s hub, which holds two logins the profile never used: the sentence names both and the two ways out, and nothing is asked nor sent but the discovery read', async () => {
    const ZED = 'zed@example.com';
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, {
      profiles: {
        a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA },
        c: { apiKey: f.hubKey(HUB_A, CY), baseUrl: HUB_A, email: CY }
      }
    });
    const sentence = (flag: string) =>
      `Error: ${ZED} is not signed in at ${HUB_A}, which holds two logins (${ADA}, ${CY}). Run ${bin} ${flag} ` +
      `login --email with one of them, or sign one of them out first so that ${ZED} replaces it.\n`;

    // On a profile of the site on disk, the sentence names it by --profile...
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A, site: fresh(HUB_A) } } });
    const h = f.harness(env);
    const asked: string[] = [];
    h.io.prompt = async (question) => {
      asked.push(question);
      return '123456';
    };
    expect(await run(['login', '--email', ZED], h.io)).toBe(1);
    expect(h.err()).toBe(sentence('--profile a'));
    expect(trace(h)).toEqual([`GET ${SITE_A}/api/v1/instance`]);
    expect(asked).toEqual([]);

    // ...and with none on disk there, by the site.
    seedTool(env, { activeProfile: 'b', profiles: { b: { baseUrl: SITE_B } } });
    const bySite = f.harness(env);
    expect(await run(['login', '--api-url', SITE_A, '--email', ZED], bySite.io)).toBe(1);
    expect(bySite.err()).toBe(sentence(`--api-url ${SITE_A}`));
    expect(trace(bySite)).toEqual([`GET ${SITE_A}/api/v1/instance`]);
    expect(Object.keys(loadCoreConfig(env, HUB_TOOL).profiles)).toEqual(['a', 'c']);
  });
});

describe('a new hub key is filed under the hub its email code ran at, even when its entry left the hub file meanwhile (F1)', () => {
  /** A site whose discovery names the default hub, and a second site that names hub-a. */
  const CLOUD_SITE = 'https://cloud-site.example.com';
  const SITE_C = 'https://site-c.example.com';

  beforeEach(() => {
    f = fleet(
      [
        ...SITES,
        { origin: CLOUD_SITE, names: DEFAULT_HUB_URL, trusts: DEFAULT_HUB_URL },
        { origin: SITE_C, names: HUB_A, trusts: HUB_A }
      ],
      [HUB_A, HUB_B, DEFAULT_HUB_URL]
    );
  });

  /** The code's prompt: while the person reads the mail, another command signs the login "a" out. */
  function signedOutDuringTheCode(h: Harness, env: Record<string, string>, email = ''): void {
    h.io.prompt = async (question) => {
      if (/mail/i.test(question)) return email;
      updateCoreConfig(env, HUB_TOOL, (config) => {
        delete config.profiles.a;
      });
      return '123456';
    };
  }

  /** The requests of some harnesses that carried a key, `METHOD origin+path` each. */
  const carrying = (key: string, ...hs: Harness[]) =>
    hs.flatMap((h) =>
      h.wire.filter((c) => c.auth === `Bearer ${key}`).map((c) => `${c.method} ${c.origin}${c.path}`)
    );

  /**
   * The entry "a" holds the new hub key, at hub-a; the next command on a site that names hub-a sends it
   * to hub-a and nowhere else, and one on a site that names the default hub sends it nowhere.
   */
  async function filedAtHubA(env: Record<string, string>, login: Harness, email: string): Promise<void> {
    const entry = loadCoreConfig(env, HUB_TOOL).profiles.a;
    expect(entry).toMatchObject({ baseUrl: HUB_A, email });
    const minted = entry?.apiKey ?? '';
    expect(f.keys()).toContain(minted);

    const next = f.harness(env);
    expect(await run(['--api-url', SITE_C, 'verify'], next.io)).toBe(0);
    expect(next.out()).toBe(`ok — ${email} (owner) @ ${SITE_C}\n`);
    expect(carrying(minted, next)).toEqual([`POST ${HUB_A}/api/v1/sso/tool-token`]);

    const cloud = f.harness(env);
    expect(await run(['--api-url', CLOUD_SITE, 'verify'], cloud.io)).toBe(1);
    expect(cloud.err()).toBe(
      `Error: ${CLOUD_SITE} signs in through the Antasphere hub ${DEFAULT_HUB_URL}, and this machine holds no ` +
        `Antasphere login there. Run ${bin} --api-url ${CLOUD_SITE} login to sign in.\n`
    );
    expect(carrying(minted, cloud)).toEqual([]);
    // Every request that carried it, the login's own included, went to hub-a.
    expect(
      new Set(carrying(minted, login, next, cloud).map((c) => new URL(c.split(' ')[1]!).origin))
    ).toEqual(new Set([HUB_A]));
  }

  it('login --email cy replaces ada at hub-a while another command signs ada out during the code: cy’s key is filed at hub-a, and sent nowhere else', async () => {
    const env: Record<string, string> = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: f.hubKey(HUB_A, ADA), baseUrl: HUB_A, email: ADA } }
    });
    seedTool(env, {
      activeProfile: 'a',
      profiles: {
        a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, f.toolKey(SITE_A, ADA))] }
      }
    });
    const h = f.harness(env);
    signedOutDuringTheCode(h, env);
    expect(await run(['login', '--email', CY], h.io)).toBe(0);
    expect(h.err()).toContain(`Replacing the Antasphere login ${ADA} with ${CY}.\n`);
    expect(h.out()).toBe(`Signed in as Cy <${CY}> in Acme on ${SITE_A}.\n`);
    await filedAtHubA(env, h, CY);
  });

  it('a stored hub key hub-a rejects, signed in again while another command signs that login out during the code: the new key is filed at hub-a, and sent nowhere else', async () => {
    const env: Record<string, string> = await tempConfigEnv();
    // A hub key hub-a no longer knows (revoked from its dashboard).
    seedHub(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: 'ant_gone_secretsecretsecret', baseUrl: HUB_A, email: ADA } }
    });
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A, site: fresh(HUB_A) } } });
    const h = f.harness(env);
    signedOutDuringTheCode(h, env, ADA);
    expect(await run(['login'], h.io)).toBe(0);
    expect(h.err()).toContain('The stored Antasphere login was rejected: signing in again.\n');
    expect(h.out()).toBe(`Signed in as Ada <${ADA}> in Acme on ${SITE_A}.\n`);
    await filedAtHubA(env, h, ADA);
  });
});

describe('a profile and a URL, a key and a site: refused before any request (PRDCT-3039, PRDCT-3044, PRDCT-5192)', () => {
  // A command that does not sign in, one that signs in on demand, and the one that signs in.
  const COMMANDS = [['logout'], ['verify'], ['login']] as const;

  it.each(COMMANDS)(
    '%s: --profile naming a saved profile at another site than the URL given',
    async (command) => {
      const { env } = await twoLogins();
      seedTool(env, {
        activeProfile: 'a',
        profiles: {
          a: { baseUrl: SITE_A, site: fresh(HUB_A), hubKeys: [kept(HUB_A, ADA, f.toolKey(SITE_A, ADA))] }
        }
      });
      const before = JSON.stringify(loadConfig(env));
      const sentence = (back: string) =>
        `Error: Profile "a" is the site ${SITE_A}, and this command targets ${SITE_B}. Drop --profile to run on ` +
        `the profile of ${SITE_B}, or ${back} to run on "a".\n`;
      for (const [args, extra, back] of [
        [['--api-url', SITE_B], {}, 'drop --api-url'],
        [['--url', `${SITE_B}/`], {}, 'drop --url'],
        [[], { [`${P}_URL`]: SITE_B }, `unset ${P}_URL`]
      ] as const) {
        const h = f.harness({ ...env, ...extra });
        expect(await run([command, '--profile', 'a', ...args], h.io)).toBe(1);
        expect(h.err()).toBe(sentence(back));
        expect(h.wire).toEqual([]);
      }
      expect(JSON.stringify(loadConfig(env))).toBe(before);
    }
  );

  it.each(COMMANDS)('%s: an exported key whose site is not the command’s', async (command) => {
    const { env } = await twoLogins();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    const envKey = f.toolKey(SITE_A, ADA, 'envk');

    const cloud = f.harness({ ...env, [`${P}_API_KEY`]: envKey });
    expect(await run([command], cloud.io)).toBe(1);
    expect(cloud.err()).toBe(
      `Error: ${P}_API_KEY is a key of ${CLOUD} (${P}_URL is not set, so it belongs to the cloud), and this ` +
        `command targets ${SITE_A}. Unset ${P}_API_KEY to run on the profile's own sign-in, or set ${P}_URL to ` +
        'the site the key was issued for.\n'
    );
    expect(cloud.wire).toEqual([]);

    // With <PREFIX>_URL set, only the URL flag sends the command elsewhere: dropping it is the way back.
    for (const flag of ['--api-url', '--url']) {
      const named = f.harness({ ...env, [`${P}_URL`]: SITE_A, [`${P}_API_KEY`]: envKey });
      expect(await run([command, flag, SITE_B], named.io)).toBe(1);
      expect(named.err()).toBe(
        `Error: ${P}_API_KEY is a key of ${SITE_A} (${P}_URL names it), and this command targets ${SITE_B}. ` +
          `Drop ${flag} to run on ${SITE_A}, or unset ${P}_API_KEY.\n`
      );
      expect(named.wire).toEqual([]);
    }
    expect(f.alive(envKey)).toBe(true);
  });

  it('the exported key paired with its site goes there; a key on the command line goes where the command goes', async () => {
    const { env } = await twoLogins();
    seedTool(env, { activeProfile: 'a', profiles: { a: { baseUrl: SITE_A } } });
    const envKey = f.toolKey(SITE_A, ADA, 'envk');
    const lineKey = f.toolKey(SITE_B, BEA, 'line');

    const paired = f.harness({ ...env, [`${P}_URL`]: SITE_A, [`${P}_API_KEY`]: envKey });
    expect(await run(['verify'], paired.io)).toBe(0);
    expect(paired.wire).toEqual([
      { method: 'GET', origin: SITE_A, path: '/api/v1/me', auth: `Bearer ${envKey}` }
    ]);

    // With a key on the command line, the exported one is not read at all.
    const line = f.harness({ ...env, [`${P}_API_KEY`]: envKey });
    expect(await run(['verify', '--api-url', SITE_B, '--api-key', lineKey], line.io)).toBe(0);
    expect(line.out()).toBe(`ok — ${BEA} (owner) @ ${SITE_B}\n`);
    expect(line.wire).toEqual([
      { method: 'GET', origin: SITE_B, path: '/api/v1/me', auth: `Bearer ${lineKey}` }
    ]);
    expect(f.requests()).toBe(2);
  });
});
