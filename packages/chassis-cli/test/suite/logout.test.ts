import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { HUB_KEY, key, seedHubLogin } from './signin-fixtures.js';

/**
 * `logout` revokes what it forgets (PRDCT-2947): every key the selected
 * profile holds, the tool's own and the ones the hub exchange cached, is
 * self-revoked on the PROFILE's instance, never anywhere else; then the
 * profile keeps its instance and loses its credentials.
 */

const { loadConfig, saveConfig } = cli;
const { envPrefix: P } = cli.identity;

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
  saveConfig(env, {
    activeProfile: 'work',
    profiles: { work: profile, other: { apiKey: key('other'), baseUrl: 'http://other' } }
  });
  return { ...env, ...extra };
}

const FULL = {
  apiKey: OWN,
  baseUrl: 'http://inst',
  email: 'ada@x.co',
  connectKeys: { default: { apiKey: CONN_A }, personal: { apiKey: CONN_B } }
};

describe('logout', () => {
  it('revokes the cached hub keys, then the profile key, on the profile instance; keeps the profile', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'DELETE', origin: 'http://inst', path: '/api/v1/cli/auth/key', auth: `Bearer ${CONN_A}` },
      { method: 'DELETE', origin: 'http://inst', path: '/api/v1/cli/auth/key', auth: `Bearer ${CONN_B}` },
      { method: 'DELETE', origin: 'http://inst', path: '/api/v1/cli/auth/key', auth: `Bearer ${OWN}` }
    ]);
    expect(h.out()).toBe('Logged out of profile "work" on http://inst (3 keys revoked server-side).\n');
    expect(h.err()).toBe('');
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('work');
    expect(config.profiles.work).toEqual({ baseUrl: 'http://inst' });
    // Another profile, and the Antasphere login itself, are untouched.
    expect(config.profiles.other?.apiKey).toBe(key('other'));
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('one key: "1 key"', async () => {
    const env = await seeded({ apiKey: OWN, baseUrl: 'http://inst' });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.out()).toBe('Logged out of profile "work" on http://inst (1 key revoked server-side).\n');
  });

  it(`never sends a key to the URL of --api-url's instance when --profile names the profile, nor to ${P}_URL`, async () => {
    const env = await seeded(FULL, { [`${P}_URL`]: 'http://elsewhere' });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout', '--profile', 'work', '--api-url', 'http://flagged'], h.io)).toBe(0);
    expect(new Set(h.wire.map((c) => c.origin))).toEqual(new Set(['http://inst']));
    expect(h.wire).toHaveLength(3);
  });

  it('--api-url selects the profile of that instance', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout', '--api-url', 'http://other/'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      {
        method: 'DELETE',
        origin: 'http://other',
        path: '/api/v1/cli/auth/key',
        auth: `Bearer ${key('other')}`
      }
    ]);
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
      'the key of the Antasphere login "default" was already unusable; forgetting it.\n' +
        'the profile key was already unusable; forgetting it.\n'
    );
    expect(h.out()).toBe('Logged out of profile "work" on http://inst (1 key revoked server-side).\n');
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

  it('--json: the counts, the hub logins, forgotten', async () => {
    const env = await seeded(FULL);
    const h = routedHarness([revokeRoute({ [CONN_B]: refusal(403, 'endpoint_not_allowed') })], env);
    expect(await run(['logout', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'work',
      baseUrl: 'http://inst',
      revoked: 2,
      refused: 1,
      hubProfiles: ['default', 'personal'],
      forgotten: true
    });
  });

  it('a profile with no instance of its own revokes on the cloud URL', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { activeProfile: 'mine', profiles: { mine: { apiKey: OWN } } });
    const h = routedHarness([revokeRoute()], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire.map((c) => c.origin)).toEqual([new URL(cli.identity.cloudUrl).origin]);
  });
});
