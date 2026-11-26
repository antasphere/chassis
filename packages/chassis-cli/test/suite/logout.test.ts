import { describe, expect, it } from 'vitest';
import {
  HUB_TOOL,
  loadConfig as loadCoreConfig,
  updateConfig as updateCoreConfig
} from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { HUB, HUB_KEY, kept, key, seedHubLogin, seedTool } from './signin-fixtures.js';

/**
 * `logout` revokes what it forgets (PRDCT-2947): every key the selected
 * profile holds (cli-core `keysOfProfile`: its own key, its kept keys, its
 * old slots) is self-revoked on the PROFILE's site, never anywhere else, with
 * no lock held; then they are forgotten, compare-and-remove, and the profile
 * keeps its site. `--all` also ends the logins its kept keys came from, each
 * revoked at its own hub.
 */

const { loadConfig } = cli;
const { envPrefix: P, displayName } = cli.identity;

/** What a plain logout adds when the profile's kept key came from the login at `HUB`. */
const STAYS = ` The Antasphere login ada@x.co at ${HUB} stays for the whole tool family.`;

const OWN = key('own');
const CONN_A = key('conna');
const CONN_B = key('connb');

/** DELETE /cli/auth/key, answering per presented key (default 200). */
function revokeRoute(answers: Record<string, { status: number; body: unknown }> = {}): Route {
  return {
    method: 'DELETE',
    path: /\/api\/v1\/cli\/auth\/key$/,
    reply: ({ headers }) => {
      const presented = headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '';
      return answers[presented] ?? { body: { revoked: true, id: 'k1' } };
    }
  };
}

const refusal = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });

async function seeded(profile: Record<string, unknown>, extra: Record<string, string> = {}) {
  const env = await tempConfigEnv();
  seedHubLogin(env);
  seedTool(env, {
    activeProfile: 'work',
    profiles: { work: profile, other: { apiKey: key('other'), baseUrl: 'http://other' } }
  });
  return { ...env, ...extra };
}

/** Every kind of key: its own, one kept for the login at `HUB`, one old slot of no login in place. */
const FULL = {
  apiKey: OWN,
  baseUrl: 'http://inst',
  email: 'ada@x.co',
  hubKeys: [kept(HUB, 'ada@x.co', CONN_A)],
  connectKeys: { personal: { apiKey: CONN_B } }
};

const DELETE = (origin: string, apiKey: string) => ({
  method: 'DELETE',
  origin,
  path: '/api/v1/cli/auth/key',
  auth: `Bearer ${apiKey}`
});

describe('logout', () => {
  it('revokes its own key, its kept key and its old slot on the profile’s site; keeps the profile', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      DELETE('http://inst', OWN),
      DELETE('http://inst', CONN_A),
      DELETE('http://inst', CONN_B)
    ]);
    expect(h.out()).toBe(
      `Logged out of profile "work" on http://inst (3 keys revoked server-side).${STAYS}\n`
    );
    expect(h.err()).toBe('');
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('work');
    expect(config.profiles.work).toEqual({ baseUrl: 'http://inst' });
    // Another profile, and the Antasphere login itself, are untouched.
    expect(config.profiles.other?.apiKey).toBe(key('other'));
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('one key of its own: "1 key", and no login is named (none signed this profile in)', async () => {
    const env = await seeded({ apiKey: OWN, baseUrl: 'http://inst' });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.out()).toBe('Logged out of profile "work" on http://inst (1 key revoked server-side).\n');
  });

  it(`--profile with a URL of another site (--api-url or ${P}_URL) is refused before any request, and nothing is forgotten`, async () => {
    for (const [args, extra] of [
      [['--api-url', 'http://flagged'], {}],
      [[], { [`${P}_URL`]: 'http://elsewhere' }]
    ] as const) {
      const env = await seeded(FULL, extra);
      const before = JSON.stringify(loadConfig(env));
      const h = routedHarness([revokeRoute()], env);
      expect(await run(['logout', '--profile', 'work', ...args], h.io)).toBe(1);
      expect(h.err()).toMatch(/^Error: Profile "work" is the site http:\/\/inst, and this command targets /);
      expect(h.wire).toEqual([]);
      expect(JSON.stringify(loadConfig(env))).toBe(before);
    }
  });

  it('--api-url selects the profile of that instance', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout', '--api-url', 'http://other/'], h.io)).toBe(0);
    expect(h.wire).toEqual([DELETE('http://other', key('other'))]);
    expect(h.out()).toBe('Logged out of profile "other" on http://other (1 key revoked server-side).\n');
    expect(loadConfig(env).profiles.work?.apiKey).toBe(OWN);
  });

  it('no profile on disk: nothing to log out of, nothing sent', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: No profile to log out of.\n');
    expect(h.wire).toEqual([]);
  });

  it('a profile that holds no key says so and sends nothing', async () => {
    const env = await seeded({ baseUrl: 'http://inst' });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.out()).toBe('Profile "work" held no key.\n');
    expect(h.wire).toEqual([]);
  });

  it('a 401 on a revoke: already unusable, forgotten', async () => {
    const env = await seeded(FULL);
    const h = routedHarness(
      [
        revokeRoute({
          [CONN_A]: refusal(401, 'invalid_api_key'),
          [OWN]: refusal(401, 'invalid_api_key')
        })
      ],
      env
    );
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.err()).toBe(
      'the profile key was already unusable; forgetting it.\n' +
        `the key kept for ada@x.co at ${HUB} was already unusable; forgetting it.\n`
    );
    expect(h.out()).toBe(
      `Logged out of profile "work" on http://inst (1 key revoked server-side).${STAYS}\n`
    );
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: 'http://inst' });
  });

  it('a 403 on a revoke: the key STAYS VALID, said on stderr and in the summary; the local copy goes', async () => {
    const env = await seeded({ apiKey: OWN, baseUrl: 'http://inst' });
    const h = routedHarness([revokeRoute({ [OWN]: refusal(403, 'endpoint_not_allowed') })], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.err()).toBe(
      'The instance refused to revoke the profile key (endpoint_not_allowed): it STAYS VALID server-side; ' +
        'revoke it from the dashboard. Forgetting the local copy.\n'
    );
    expect(h.out()).toBe(
      'Logged out of profile "work" on http://inst — 1 key could NOT be revoked and stay valid.\n'
    );
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: 'http://inst' });
  });

  it('--json: the counts, forgotten; with --all, the logins it ended', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute({ [CONN_B]: refusal(403, 'endpoint_not_allowed') })], env);
    expect(await run(['logout', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'work',
      baseUrl: 'http://inst',
      revoked: 2,
      refused: 1,
      forgotten: true
    });

    const all = await seeded(FULL);
    const ended = routedHarness([revokeRoute()], all);
    expect(await run(['logout', '--all', '--json'], ended.io)).toBe(0);
    expect(JSON.parse(ended.out())).toEqual({
      profile: 'work',
      baseUrl: 'http://inst',
      revoked: 3,
      refused: 0,
      forgotten: true,
      logins: [{ hub: HUB, email: 'ada@x.co', revoked: true }]
    });
  });

  it('no profile of the tool, an Antasphere login stored: names the command that ends it, exit 1, nothing sent (PRDCT-3032)', async () => {
    for (const args of [[], ['--all']]) {
      const env = await tempConfigEnv();
      seedHubLogin(env);
      const h = routedHarness([revokeRoute()], env);
      expect(await run(['logout', ...args], h.io)).toBe(1);
      expect(h.err()).toBe(
        `Error: Nothing of ${displayName}'s to sign out of on this machine. The Antasphere login ada@x.co at ` +
          `${HUB} stays for the whole tool family: \`antasphere logout\` ends it.\n`
      );
      expect(h.wire).toEqual([]);
      expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
    }
  });

  it("--all on a profile with a kept key: the tool's key revoked on the instance, then the hub key at its hub; both cleared (PRDCT-3032)", async () => {
    const env = await seeded({ baseUrl: 'http://inst', hubKeys: [kept(HUB, 'ada@x.co', CONN_A)] });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(h.wire).toEqual([DELETE('http://inst', CONN_A), DELETE(HUB, HUB_KEY)]);
    expect(h.out()).toBe(
      'Logged out of profile "work" on http://inst (1 key revoked server-side). ' +
        `The Antasphere login ada@x.co at ${HUB} is revoked and forgotten.\n`
    );
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: 'http://inst' });
    const hub = loadCoreConfig(env, HUB_TOOL);
    expect(hub.profiles).toEqual({});
    expect(hub.activeProfile).toBeUndefined();
  });

  it('--all while another command signs in again on the same login entry: the entry goes only while it still holds the key revoked, so the new login stays', async () => {
    const env = await seeded({ baseUrl: 'http://inst', hubKeys: [kept(HUB, 'ada@x.co', CONN_A)] });
    const NEW_HUB_KEY = 'ant_newkey12_secretsecretsecret1234';
    const hubRevoke: Route = {
      method: 'DELETE',
      origin: HUB,
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => {
        // Another command signs in again at the hub, on the same entry, while this one revokes the old key.
        updateCoreConfig(env, HUB_TOOL, (config) => {
          config.profiles.default = { apiKey: NEW_HUB_KEY, baseUrl: HUB, email: 'ada@x.co' };
        });
        return { body: { revoked: true, id: 'k2' } };
      }
    };
    const h = routedHarness([hubRevoke, revokeRoute()], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(h.wire).toEqual([DELETE('http://inst', CONN_A), DELETE(HUB, HUB_KEY)]);
    const hub = loadCoreConfig(env, HUB_TOOL);
    expect(hub.profiles.default).toEqual({ apiKey: NEW_HUB_KEY, baseUrl: HUB, email: 'ada@x.co' });
    expect(hub.activeProfile).toBe('default');
  });

  it('--all on a profile whose keys came from no login in place: no login is ended, and that is said', async () => {
    const env = await seeded({
      apiKey: OWN,
      baseUrl: 'http://inst',
      hubKeys: [kept(HUB, 'bea@x.co', CONN_A)]
    });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout', '--all'], h.io)).toBe(0);
    expect(h.wire).toEqual([DELETE('http://inst', OWN), DELETE('http://inst', CONN_A)]);
    expect(h.out()).toBe(
      'Logged out of profile "work" on http://inst (2 keys revoked server-side). No Antasphere login to end.\n'
    );
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('the same profile, a plain logout: the tool key alone is revoked, the Antasphere login stays and is named (PRDCT-3032)', async () => {
    const env = await seeded({ baseUrl: 'http://inst', hubKeys: [kept(HUB, 'ada@x.co', CONN_A)] });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire).toEqual([DELETE('http://inst', CONN_A)]);
    expect(h.out()).toBe(
      `Logged out of profile "work" on http://inst (1 key revoked server-side).${STAYS}\n`
    );
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('a profile with no instance of its own revokes on the cloud URL', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { activeProfile: 'mine', profiles: { mine: { apiKey: OWN } } });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire.map((c) => c.origin)).toEqual([new URL(cli.identity.cloudUrl).origin]);
  });
});
