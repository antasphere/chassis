import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { cloudInstanceBody, fresh, kept, meBody, MINTED_META, seedHub, seedTool } from './signin-fixtures.js';

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
const { bin, envPrefix: P, keyPrefix: K, cloudUrl } = cli.identity;
const CLOUD = new URL(cloudUrl).origin;

const HUB_A = 'https://hub-a.example.com';
const HUB_B = 'https://hub-b.example.com';
const SITE_A = 'https://site-a.example.com';
const SITE_B = 'https://site-b.example.com';
const OLD = 'https://old.example.com';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const CY = 'cy@example.com';

interface Site {
  origin: string;
  names: string | null;
  trusts: string;
}

const SITES: Site[] = [
  { origin: SITE_A, names: HUB_A, trusts: HUB_A },
  { origin: SITE_B, names: HUB_B, trusts: HUB_B },
  { origin: OLD, names: null, trusts: HUB_A }
];

type Harness = ReturnType<typeof routedHarness>;

const deny = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } }
});
const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
const hostOf = (origin: string) => new URL(origin).hostname.split('.')[0]!;
const nameOf = (email: string) => email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase());

function fleet() {
  const hubKeys = new Map<string, { hub: string; email: string; alive: boolean }>();
  const toolKeys = new Map<string, { site: string; email: string; alive: boolean }>();
  const tokens = new Map<string, { hub: string; email: string; resource: string }>();
  const harnesses: Harness[] = [];
  let seq = 0;
  let exchanges = 0;

  function hubKey(hub: string, email: string): string {
    seq += 1;
    const k = `ant_${hostOf(hub)}${seq}_secretsecretsecret`;
    hubKeys.set(k, { hub, email, alive: true });
    return k;
  }

  function toolKey(site: string, email: string, kind = 'kept'): string {
    seq += 1;
    const k = `${K}_${hostOf(site)}${seq}_${kind}${kind}${kind}`;
    toolKeys.set(k, { site, email, alive: true });
    return k;
  }

  const routes: Route[] = [];
  for (const hub of [HUB_A, HUB_B]) {
    routes.push(
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/sso\/tool-token$/,
        reply: ({ headers, body }) => {
          const who = hubKeys.get(bearer(headers));
          if (!who || who.hub !== hub || !who.alive) return deny(401, 'unauthenticated', 'unknown hub key');
          const resource = (body as { resource?: string }).resource ?? '';
          const site = SITES.find((s) => `${s.origin}/mcp` === resource);
          if (!site || site.trusts !== hub) {
            return deny(400, 'unknown_resource', 'This resource is not a registered tool');
          }
          seq += 1;
          const token = `jwt-${seq}`;
          tokens.set(token, { hub, email: who.email, resource });
          return { body: { token, expiresAt: '2026-11-25T00:02:00.000Z', hubRefreshToken: `hrt-${seq}` } };
        }
      },
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/request$/,
        reply: () => ({ body: { sent: true } })
      },
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/complete$/,
        reply: ({ body }) => {
          const email = (body as { email: string }).email;
          return {
            status: 201,
            body: {
              key: hubKey(hub, email),
              apiKey: MINTED_META,
              user: { id: 'u1', email, name: nameOf(email) },
              workspaceId: 'org-1'
            }
          };
        }
      },
      {
        method: 'DELETE',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: ({ headers }) => {
          const held = hubKeys.get(bearer(headers));
          if (!held || held.hub !== hub || !held.alive) return deny(401, 'unauthenticated', 'unknown key');
          held.alive = false;
          return { body: { revoked: true, id: 'k' } };
        }
      }
    );
  }
  for (const site of SITES) {
    routes.push(
      {
        method: 'GET',
        origin: site.origin,
        path: /\/api\/v1\/instance$/,
        reply: () => ({ body: cloudInstanceBody(site.names ?? undefined) })
      },
      {
        method: 'POST',
        origin: site.origin,
        path: /\/api\/v1\/sso\/cli-connect$/,
        reply: ({ body }) => {
          const token = (body as { token?: string }).token ?? '';
          const claim = tokens.get(token);
          if (!claim || claim.resource !== `${site.origin}/mcp` || claim.hub !== site.trusts) {
            return deny(401, 'invalid_token', 'token refused');
          }
          tokens.delete(token);
          exchanges += 1;
          const k = toolKey(site.origin, claim.email, 'mint');
          return {
            status: 201,
            body: {
              key: k,
              apiKey: MINTED_META,
              user: { id: 'u1', email: claim.email, name: nameOf(claim.email) },
              workspaceId: null
            }
          };
        }
      },
      {
        method: 'GET',
        origin: site.origin,
        path: /\/api\/v1\/me$/,
        reply: ({ headers }) => {
          const held = toolKeys.get(bearer(headers));
          if (!held || held.site !== site.origin || !held.alive) {
            return deny(401, 'invalid_api_key', 'API key not recognized');
          }
          return { body: meBody({ name: nameOf(held.email), email: held.email }) };
        }
      },
      {
        method: 'DELETE',
        origin: site.origin,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: ({ headers }) => {
          const held = toolKeys.get(bearer(headers));
          if (!held || held.site !== site.origin || !held.alive)
            return deny(401, 'unauthenticated', 'unknown key');
          held.alive = false;
          return { body: { revoked: true, id: 'k' } };
        }
      }
    );
  }

  return {
    hubKey,
    toolKey,
    exchanges: () => exchanges,
    alive: (k: string) => hubKeys.get(k)?.alive ?? toolKeys.get(k)?.alive ?? false,
    /** A harness on the fleet, watched by the invariants. */
    harness(env: Record<string, string | undefined>): Harness {
      const h = routedHarness(routes, env);
      harnesses.push(h);
      return h;
    },
    /** Every request of the test's harnesses that carried a key to another origin than its own. */
    violations(): string[] {
      const found: string[] = [];
      for (const h of harnesses) {
        for (const c of h.wire) {
          const carried = `${c.auth ?? ''} ${JSON.stringify(c.body ?? null)} ${c.path}`;
          for (const [k, home] of hubKeys) {
            if (carried.includes(k) && c.origin !== home.hub) {
              found.push(`hub key of ${home.hub} sent to ${c.origin}${c.path}`);
            }
          }
          for (const [k, home] of toolKeys) {
            if (carried.includes(k) && c.origin !== home.site) {
              found.push(`tool key of ${home.site} sent to ${c.origin}${c.path}`);
            }
          }
        }
      }
      return found;
    },
    /** How many requests the test's harnesses sent. */
    requests: () => harnesses.reduce((n, h) => n + h.wire.length, 0)
  };
}

let f: ReturnType<typeof fleet>;

beforeEach(() => {
  f = fleet();
});

afterEach(() => {
  expect(f.violations()).toEqual([]);
});

const trace = (h: Harness) => h.wire.map((c) => `${c.method} ${c.origin}${c.path}`);

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

    const named = f.harness({ ...env, [`${P}_URL`]: SITE_A, [`${P}_API_KEY`]: envKey });
    expect(await run([command, '--api-url', SITE_B], named.io)).toBe(1);
    expect(named.err()).toBe(
      `Error: ${P}_API_KEY is a key of ${SITE_A} (${P}_URL names it), and this command targets ${SITE_B}. ` +
        `Unset ${P}_API_KEY to run on the profile's own sign-in, or set ${P}_URL to the site the key was ` +
        'issued for.\n'
    );
    expect(named.wire).toEqual([]);
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
