import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  kept,
  key,
  meBody,
  meRoute,
  namingInstanceRoute,
  ORG,
  ossInstanceRoute,
  otpRoutes,
  seedHub,
  seedHubLogin,
  seedTool,
  TOOL_ACCESS_DENIED,
  wsRow
} from './signin-fixtures.js';

/**
 * ONE `login` that ends in the tool (PRDCT-2947): a pasted key, the site's
 * own email code (a site that signs in by itself), or the Antasphere login
 * at the hub the SITE names then the exchange (R2). The profile it signs in
 * on is the site's, and a login never moves the default profile nor the hub
 * file's active login, except for the first of a machine (R3).
 */

const { configPath, loadConfig } = cli;
const { bin, envPrefix: P, keyPrefix: K, displayName, cloudUrl } = cli.identity;

/** A scripted prompt: answers in order, questions recorded. */
function scripted(h: ReturnType<typeof routedHarness>, answers: string[]): string[] {
  const asked: string[] = [];
  h.io.prompt = async (q) => {
    asked.push(q);
    return answers.shift() ?? '';
  };
  return asked;
}

/** A second Antasphere account's hub key (PRDCT-3032). */
const BOB_HUB_KEY = 'ant_bobkey12_secretsecretsecret1234';

/** The routes as given, every answer that names a person naming `email` instead. */
function answeringAs(email: string, routes: Route[]): Route[] {
  return routes.map((r) => ({
    ...r,
    reply: (call) => {
      const answer = r.reply(call);
      const body = answer.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object' || !('user' in body)) return answer;
      return { ...answer, body: { ...body, user: { ...(body.user as object), email } } };
    }
  }));
}

const revokeOk: Route = {
  method: 'DELETE',
  path: /\/api\/v1\/cli\/auth\/key$/,
  reply: () => ({ body: { revoked: true, id: 'k' } })
};

const trace = (h: ReturnType<typeof routedHarness>) =>
  h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`);

/** The line a login says when its profile is not the default (R3). */
const stays = (p: string, d: string) =>
  `Signed in on profile "${p}". The default profile stays "${d}" (${bin} use ${p} makes "${p}" the default).\n`;

describe('login with a pasted key', () => {
  it('verifies the key with /me, saves it on the instance profile, the default of a machine with no profile', async () => {
    const env = await tempConfigEnv();
    const pasted = key('paste');
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', pasted, '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://inst', path: '/api/v1/me', auth: `Bearer ${pasted}` }
    ]);
    expect(h.out()).toBe(
      `Signed in as Ada <ada@x.co> in Acme on http://inst.\nKey saved to profile "inst" (${configPath(env)}).\n`
    );
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles).toEqual({ inst: { apiKey: pasted, baseUrl: 'http://inst', email: 'ada@x.co' } });
  });

  it(`${P}_API_KEY is never taken as a paste: on a self-hosted instance the email code runs (verifier round 1, F8)`, async () => {
    const env = await tempConfigEnv();
    const inShell = key('envkey');
    const minted = key('minted');
    // The exported key is paired with its site (R2): <PREFIX>_URL names it.
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute()], {
      ...env,
      [`${P}_URL`]: 'http://inst',
      [`${P}_API_KEY`]: inShell
    });
    scripted(h, ['123456']);
    expect(await run(['login', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET /api/v1/instance -',
      'POST /api/v1/cli/auth/request -',
      'POST /api/v1/cli/auth/complete -',
      `GET /api/v1/me Bearer ${minted}`
    ]);
    expect(loadConfig(env).profiles.inst).toEqual({
      apiKey: minted,
      baseUrl: 'http://inst',
      email: 'ada@x.co'
    });
    expect(JSON.stringify(loadConfig(env))).not.toContain(inShell);
  });

  it(`${P}_API_KEY is never taken as a paste: on the cloud the Antasphere path runs`, async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHubLogin(env);
    const inShell = key('envkey');
    const minted = key('tool');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], {
      ...env,
      [`${P}_URL`]: 'http://tool',
      [`${P}_API_KEY`]: inShell
    });
    expect(await run(['login', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.apiKey).toBeUndefined();
    expect(tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(inShell);
  });

  it('reads the key from --api-key-stdin', async () => {
    const env = await tempConfigEnv();
    const pasted = key('stdin');
    const h = routedHarness([meRoute()], env);
    h.io.readStdin = async () => `${pasted}\n`;
    expect(await run(['login', '--api-key-stdin', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.wire[0]?.auth).toBe(`Bearer ${pasted}`);
    expect(loadConfig(env).profiles.inst?.apiKey).toBe(pasted);
  });

  it('a person with no name reads as the email alone', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute(meBody({ name: '' }))], env);
    expect(await run(['login', '--api-key', key('paste'), '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe('Signed in as ada@x.co in Acme on http://inst.');
  });

  it(`refuses a key that is not a ${displayName} key, before any request`, async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', 'zzz_not_ours', '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(h.err()).toBe(`Error: That is not a ${displayName} key: it should start with ${K}_.\n`);
    expect(h.wire).toEqual([]);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('a key the instance refuses is never saved', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: () => ({
            status: 401,
            body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
          })
        }
      ],
      env
    );
    expect(await run(['login', '--api-key', key('bad'), '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('--json: the profile, the site, how, who, where, whether it became the default, and the file', async () => {
    const env = await tempConfigEnv();
    const pasted = key('paste');
    const me = meBody();
    const h = routedHarness([meRoute(me)], env);
    expect(await run(['login', '--json', '--api-key', pasted, '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'inst',
      site: 'http://inst',
      via: 'key',
      login: null,
      user: me.user,
      workspace: me.workspace,
      madeDefault: true,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(pasted);
  });

  it('--profile names the profile the key is saved on, and the default does not move to it', async () => {
    const env = await tempConfigEnv();
    seedTool(env, { profiles: { work: { baseUrl: 'http://inst' } } });
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', key('paste'), '--profile', 'work'], h.io)).toBe(0);
    expect(loadConfig(env)).toEqual({
      profiles: { work: { apiKey: key('paste'), baseUrl: 'http://inst', email: 'ada@x.co' } }
    });
    // With no default chosen, a command typed by hand runs on the cloud's profile: that stays.
    expect(h.err()).toBe(stays('work', 'cloud'));
  });

  it('a pasted key replacing the profile’s own key revokes the old one on the profile’s site, and there only', async () => {
    const env = await tempConfigEnv();
    const old = key('old');
    const pasted = key('paste');
    seedTool(env, {
      activeProfile: 'inst',
      profiles: {
        inst: { apiKey: old, baseUrl: 'http://inst' },
        other: { apiKey: key('other'), baseUrl: 'http://o' }
      }
    });
    const h = routedHarness([meRoute(), revokeOk], env);
    expect(await run(['login', '--api-key', pasted], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      `GET http://inst/api/v1/me Bearer ${pasted}`,
      `DELETE http://inst/api/v1/cli/auth/key Bearer ${old}`
    ]);
    expect(h.err()).toBe('');
    expect(loadConfig(env).profiles.inst).toEqual({
      apiKey: pasted,
      baseUrl: 'http://inst',
      email: 'ada@x.co'
    });
    expect(JSON.stringify(loadConfig(env))).not.toContain(old);

    // The same key pasted again replaces nothing: nothing is revoked.
    const again = routedHarness([meRoute(), revokeOk], env);
    expect(await run(['login', '--api-key', pasted], again.io)).toBe(0);
    expect(again.wire.map((c) => c.method)).toEqual(['GET']);
  });

  it('a site that does not revoke the replaced key says it stays valid there; the new key is saved all the same', async () => {
    const env = await tempConfigEnv();
    const old = key('old');
    seedTool(env, { activeProfile: 'inst', profiles: { inst: { apiKey: old, baseUrl: 'http://inst' } } });
    const nothing: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => {
        throw new TypeError('fetch failed');
      }
    };
    const h = routedHarness([meRoute(), nothing], env);
    expect(await run(['login', '--api-key', key('paste')], h.io)).toBe(0);
    expect(h.err()).toBe(
      'Could not reach http://inst to revoke the replaced key: it stays valid there until revoked from its ' +
        'dashboard.\n'
    );
    expect(loadConfig(env).profiles.inst?.apiKey).toBe(key('paste'));
    expect(h.err()).not.toContain(old.slice(0, 13));
  });
});

describe('login on a self-hosted instance: the email code', () => {
  it('asks the email and the code, mints the key, saves it on the instance profile, named and never shown', async () => {
    const env = await tempConfigEnv();
    const minted = key('minted');
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute()], env);
    const asked = scripted(h, ['ada@x.co', '123456']);
    expect(await run(['login', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(asked).toEqual(['Email: ', 'Code: ']);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://inst', path: '/api/v1/instance', auth: undefined },
      {
        method: 'POST',
        origin: 'http://inst',
        path: '/api/v1/cli/auth/request',
        auth: undefined,
        body: { email: 'ada@x.co' }
      },
      {
        method: 'POST',
        origin: 'http://inst',
        path: '/api/v1/cli/auth/complete',
        auth: undefined,
        body: { email: 'ada@x.co', otp: '123456' }
      },
      { method: 'GET', origin: 'http://inst', path: '/api/v1/me', auth: `Bearer ${minted}` }
    ]);
    expect(h.err()).toBe('A sign-in code was sent to ada@x.co (if that account exists on http://inst).\n');
    // The key is named by the name the site gave it; no part of it is printed.
    expect(h.out()).toBe(
      'Signed in as Ada <ada@x.co> in Acme on http://inst.\n' +
        `API key "CLI login" saved to profile "inst" (${configPath(env)}).\n`
    );
    expect(h.out()).not.toContain(minted.slice(0, 12));
    expect(h.out()).not.toContain(minted.slice(-4));
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles.inst).toEqual({ apiKey: minted, baseUrl: 'http://inst', email: 'ada@x.co' });
  });

  it('a re-login revokes the key it replaces on the profile’s site, once the new one is saved', async () => {
    const env = await tempConfigEnv();
    const old = key('old');
    const minted = key('minted');
    seedTool(env, { activeProfile: 'inst', profiles: { inst: { apiKey: old, baseUrl: 'http://inst' } } });
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute(), revokeOk], env);
    scripted(h, ['123456']);
    expect(await run(['login', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://inst/api/v1/instance -',
      'POST http://inst/api/v1/cli/auth/request -',
      'POST http://inst/api/v1/cli/auth/complete -',
      `GET http://inst/api/v1/me Bearer ${minted}`,
      `DELETE http://inst/api/v1/cli/auth/key Bearer ${old}`
    ]);
    expect(loadConfig(env).profiles.inst).toEqual({
      apiKey: minted,
      baseUrl: 'http://inst',
      email: 'ada@x.co',
      // What the site said of itself, remembered by the login on a profile already on disk.
      site: expect.objectContaining({ federated: false })
    });
    expect(JSON.stringify(loadConfig(env))).not.toContain(old);
  });

  it('--email skips the first question; --key-name and --expires-in-days reach the mint', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(key('minted')), meRoute()], env);
    const asked = scripted(h, ['654321']);
    expect(
      await run(
        [
          'login',
          '--api-url',
          'http://inst',
          '--email',
          'ada@x.co',
          '--key-name',
          'laptop',
          '--expires-in-days',
          '30'
        ],
        h.io
      )
    ).toBe(0);
    expect(asked).toEqual(['Code: ']);
    expect(h.wire.find((c) => c.path.endsWith('/complete'))?.body).toEqual({
      email: 'ada@x.co',
      otp: '654321',
      keyName: 'laptop',
      expiresInDays: 30
    });
  });

  it('--json never carries the key', async () => {
    const env = await tempConfigEnv();
    const minted = key('minted');
    const me = meBody();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute(me)], env);
    scripted(h, ['123456']);
    expect(await run(['login', '--json', '--api-url', 'http://inst', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'inst',
      site: 'http://inst',
      via: 'otp',
      login: null,
      user: me.user,
      workspace: me.workspace,
      keyName: 'CLI login',
      madeDefault: true,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(minted);
  });

  it('an instance whose discovery does not answer is signed in the self-hosted way', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([...otpRoutes(key('minted')), meRoute()], env);
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://inst', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/cli/auth/request',
      '/api/v1/cli/auth/complete',
      '/api/v1/me'
    ]);
  });

  it('with no prompt wired, the question is a clean error and nothing is requested', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(key('minted')), meRoute()], env);
    expect(await run(['login', '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: This command is interactive — no prompt available (pass the value as a flag).\n'
    );
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/instance']);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });
});

describe('login on the cloud: the Antasphere sign-in, then the exchange', () => {
  const hubEnv = async () => ({ ...(await tempConfigEnv()), ANTASPHERE_URL: HUB });
  const ORG_ROWS = [
    wsRow('w1', 'Acme', { default: true, hubOrigin: true, centralAccountId: ORG }),
    wsRow('w2', 'Beta', { hubOrigin: true, centralAccountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
  ];

  it('with no Antasphere login: the hub email code, the hub profile written as the hub CLI writes it, then the exchange', async () => {
    const env = await hubEnv();
    const minted = key('tool');
    const h = routedHarness(
      [
        cloudInstanceRoute,
        ...otpRoutes(HUB_KEY, ORG),
        ...exchangeRoutes([minted]),
        meRoute(meBody({ workspaces: ORG_ROWS }))
      ],
      env
    );
    const asked = scripted(h, ['ada@x.co', '123456']);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual(['Antasphere email: ', 'Code: ']);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.wire[2]?.body).toEqual({ email: 'ada@x.co', otp: '123456' });
    expect(h.err()).toContain(
      'A sign-in code was sent to ada@x.co (if that Antasphere account can receive mail).\n'
    );
    expect(h.out()).toBe(
      `Signed in as Ada <ada@x.co> in Acme (organization ${ORG}) on http://tool.\n` +
        'Your workspaces: Acme, Beta. Pass --org <name> (or --workspace <name>) to work in another.\n'
    );
    // The hub profile: exactly what `antasphere login` writes, named the hub
    // CLI's way (cli-core `freshProfileName`: the profile of the host, `hub`),
    // and the hub file's active login, since it held none.
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'hub',
      profiles: { hub: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co', workspaceId: ORG } }
    });
    // The tool's key is kept on the instance profile, the default of a machine that had none.
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('tool');
    expect(config.profiles.tool?.baseUrl).toBe('http://tool');
    expect(config.profiles.tool?.apiKey).toBeUndefined();
    expect(config.profiles.tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
  });

  it('a clean machine, a site that names no hub: the sentence that picks one, nothing asked, nothing sent but discovery', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    const asked = scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(1);
    // No profile of that site is on disk: the way out names the site, which makes it (--profile would refuse).
    expect(h.err()).toBe(
      'Error: http://tool names no Antasphere hub (it runs a version from before sites named theirs), and ' +
        'profile "tool" has never signed in there. This machine holds no Antasphere login. Pick the hub this ' +
        `site trusts: ${bin} --api-url http://tool login --hub <hub>.\n`
    );
    expect(asked).toEqual([]);
    expect(trace(h)).toEqual(['GET http://tool/api/v1/instance -']);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({ profiles: {} });
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('a clean machine, a site that names the cloud hub: the login `cloud` at account.antasphere.com', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [
        namingInstanceRoute('https://account.antasphere.com'),
        ...otpRoutes(HUB_KEY, ORG),
        ...exchangeRoutes([key('tool')]),
        meRoute()
      ],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire[1]).toMatchObject({
      origin: 'https://account.antasphere.com',
      path: '/api/v1/cli/auth/request'
    });
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'cloud',
      profiles: {
        cloud: {
          apiKey: HUB_KEY,
          baseUrl: 'https://account.antasphere.com',
          email: 'ada@x.co',
          workspaceId: ORG
        }
      }
    });
    expect(loadConfig(env).profiles.tool?.hubKeys?.[0]?.apiKey).toBe(key('tool'));
  });

  it('a stored hub login the hub rejects: re-signs in at the hub the site names, and the login keeps its other fields', async () => {
    const env = await tempConfigEnv();
    seedHub(env, {
      activeProfile: 'default',
      profiles: {
        default: {
          apiKey: HUB_KEY,
          baseUrl: HUB,
          email: 'ada@x.co',
          connectKeys: { other: { apiKey: 'kept' } },
          // A field this CLI does not know: the hub CLI's spread keeps it, so must this one.
          label: 'mine'
        } as Record<string, unknown>,
        spare: { baseUrl: 'http://spare' }
      }
    });
    const fresh = 'ant_freshkey_secretsecretsecret1234';
    const h = routedHarness(
      [
        namingInstanceRoute(HUB),
        ...otpRoutes(fresh, ORG),
        ...exchangeRoutes([key('tool')], {
          toolToken: (n) =>
            n === 1
              ? { status: 401, body: { error: { code: 'unauthenticated', message: 'bad key' } } }
              : undefined
        }),
        meRoute()
      ],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.err()).toContain('The stored Antasphere login was rejected: signing in again.\n');
    expect(h.wire.filter((c) => c.path.startsWith('/api/v1/cli/auth/')).map((c) => c.origin)).toEqual([
      HUB,
      HUB
    ]);
    expect(h.wire.some((c) => c.origin === 'https://account.antasphere.com')).toBe(false);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'default',
      profiles: {
        default: {
          apiKey: fresh,
          baseUrl: HUB,
          email: 'ada@x.co',
          workspaceId: ORG,
          connectKeys: { other: { apiKey: 'kept' } },
          label: 'mine'
        },
        spare: { baseUrl: 'http://spare' }
      }
    });
    expect(loadConfig(env).profiles.tool?.hubKeys?.[0]?.apiKey).toBe(key('tool'));
  });

  it('a login revokes and replaces an old-shape key the instance no longer accepts (verifier round 1, F3)', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const dead = key('dead');
    const minted = key('tool');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: { tool: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: dead } } } }
    });
    const refused = {
      status: 401,
      body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
    };
    const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '');
    const h = routedHarness(
      [
        cloudInstanceRoute,
        { method: 'DELETE', path: /\/api\/v1\/cli\/auth\/key$/, reply: () => refused },
        ...exchangeRoutes([minted]),
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: ({ headers }) => (bearer(headers) === minted ? { body: meBody() } : refused)
        }
      ],
      env
    );
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${dead}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.connectKeys).toBeUndefined();
    expect(tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(dead);
  });

  it('a login with a live kept key revokes it too, and ends with one new key on the profile', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const live = key('live');
    const minted = key('tool');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: { tool: { baseUrl: 'http://tool', hubKeys: [kept(HUB, 'ada@x.co', live)] } }
    });
    const h = routedHarness([cloudInstanceRoute, revokeOk, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', origin: 'http://tool', path: '/api/v1/cli/auth/key', auth: `Bearer ${live}` }
    ]);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    expect(h.wire.at(-1)).toMatchObject({ path: '/api/v1/me', auth: `Bearer ${minted}` });
    expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
      { hub: HUB, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
  });

  it('F9: --profile naming another instance than --api-url is refused before any request, and nothing moves', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const cached = key('cached');
    seedTool(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', hubKeys: [kept(HUB, 'ada@x.co', cached)] } }
    });
    const before = JSON.stringify(loadConfig(env));
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    expect(await run(['login', '--profile', 'work', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([]);
    expect(h.err()).toBe(
      'Error: Profile "work" is the site http://tool, and this command targets http://other. ' +
        'Drop --profile to run on the profile of http://other, or drop --api-url to run on "work".\n'
    );
    expect(JSON.stringify(loadConfig(env))).toBe(before);
  });

  it('F9: the same refusal for a pasted key: the profile is never repointed and the key goes nowhere', async () => {
    const env = await hubEnv();
    const own = `${K}_ownkey12_0123456789abcdefghij`;
    const pasted = `${K}_pasted12_0123456789abcdefghij`;
    seedTool(env, { activeProfile: 'work', profiles: { work: { baseUrl: 'http://tool', apiKey: own } } });
    const h = routedHarness([meRoute()], env);
    expect(
      await run(['login', '--profile', 'work', '--api-url', 'http://other', '--api-key', pasted], h.io)
    ).toBe(1);
    expect(h.wire).toEqual([]);
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: 'http://tool', apiKey: own });
  });

  it('a signed-out entry of the hub CLI at that hub takes the new login, under its name, and the active login stays', async () => {
    const env = await hubEnv();
    seedHub(env, { activeProfile: 'work', profiles: { work: { baseUrl: HUB } } });
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'work',
      profiles: { work: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co', workspaceId: ORG } }
    });
    expect(loadConfig(env).profiles.tool?.hubKeys?.[0]?.apiKey).toBe(key('tool'));
  });

  it('with no URL at all, signs in on the implicit cloud profile at the cloud URL', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const minted = key('tool');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['login'], h.io)).toBe(0);
    const origin = new URL(cloudUrl).origin;
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path}`)).toEqual([
      `GET ${origin}/api/v1/instance`,
      `GET ${origin}/api/v1/instance`,
      `POST ${HUB}/api/v1/sso/tool-token`,
      `POST ${origin}/api/v1/sso/cli-connect`,
      `GET ${origin}/api/v1/me`
    ]);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(Object.keys(config.profiles)).toEqual(['cloud']);
    expect(config.profiles.cloud?.baseUrl).toBe(origin);
    expect(config.profiles.cloud?.hubKeys?.[0]?.apiKey).toBe(minted);
    expect(h.out()).toBe(`Signed in as Ada <ada@x.co> in Acme on ${origin}.\n`);
    // The first profile of the machine is its default: no line about the default.
    expect(h.err()).toBe(`Connected to ${origin} as ada@x.co via Antasphere.\n`);
  });

  it('with an Antasphere login stored: no question, the exchange alone', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    const asked = scripted(h, []);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual([]);
    expect(h.wire.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/instance',
      '/api/v1/sso/tool-token',
      '/api/v1/sso/cli-connect',
      '/api/v1/me'
    ]);
  });

  it('a stored Antasphere login the hub rejects: signs in again, then the exchange again', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const fresh = 'ant_freshkey_secretsecretsecret1234';
    const h = routedHarness(
      [
        cloudInstanceRoute,
        ...otpRoutes(fresh, ORG),
        ...exchangeRoutes([key('tool')], {
          toolToken: (n) =>
            n === 1
              ? { status: 401, body: { error: { code: 'unauthenticated', message: 'bad key' } } }
              : undefined
        }),
        meRoute()
      ],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.err()).toContain('The stored Antasphere login was rejected: signing in again.\n');
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${fresh}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${key('tool')}`
    ]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(fresh);
  });

  it('--email naming ANOTHER account than the login at that hub REPLACES it: the line, the old hub key revoked at its hub, the old account’s key revoked on the site (PRDCT-3032, ruling 3)', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const old = key('adakey');
    const minted = key('bobkey');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: {
        tool: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: old, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness(
      [
        cloudInstanceRoute,
        revokeOk,
        ...answeringAs('bob@x.co', [...otpRoutes(BOB_HUB_KEY, ORG), ...exchangeRoutes([minted])]),
        meRoute()
      ],
      env
    );
    const asked = scripted(h, ['123456']);
    expect(await run(['login', '--email', 'bob@x.co', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual(['Code: ']);
    expect(h.err()).toContain('Replacing the Antasphere login ada@x.co with bob@x.co.\n');
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      `DELETE ${HUB}/api/v1/cli/auth/key Bearer ${HUB_KEY}`,
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${old}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${BOB_HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.wire[1]?.body).toEqual({ email: 'bob@x.co' });
    // The same entry, the new key and address: never a second login beside the first.
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'default',
      profiles: { default: { apiKey: BOB_HUB_KEY, baseUrl: HUB, email: 'bob@x.co', workspaceId: ORG } }
    });
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.connectKeys).toBeUndefined();
    expect(tool?.hubKeys).toEqual([
      { hub: HUB, email: 'bob@x.co', apiKey: minted, mintedAt: expect.any(String) }
    ]);
    expect(JSON.stringify(loadConfig(env))).not.toContain(old);
    expect(JSON.stringify(loadCoreConfig(env, HUB_TOOL))).not.toContain(HUB_KEY);
  });

  it('--email naming the SAME account as the stored login (any case): no question, no new sign-in, the exchange alone', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(BOB_HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    const asked = scripted(h, []);
    expect(await run(['login', '--email', 'ADA@X.co', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual([]);
    expect(h.err()).not.toContain('Replacing');
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${key('tool')}`
    ]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('--json: via login, the login, the workspaces, whether it became the default', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const me = meBody({ workspaces: ORG_ROWS });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute(me)], env);
    expect(await run(['login', '--json', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'tool',
      site: 'http://tool',
      via: 'login',
      login: { hub: HUB, email: 'ada@x.co' },
      user: me.user,
      workspace: me.workspace,
      workspaces: me.workspaces,
      madeDefault: true,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(key('tool'));
  });

  it('a hub refusal of the person is its own sentence, and exit 3', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [cloudInstanceRoute, ...exchangeRoutes([key('tool')], { toolToken: () => TOOL_ACCESS_DENIED })],
      env
    );
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(3);
    expect(h.err()).toBe(`Error: This account has no access to ${displayName} in any of its organizations\n`);
    expect(loadConfig(env).profiles.tool).toBeUndefined();
  });
});

describe('a login never moves a default (R3)', () => {
  const HOME_KEY = key('home');

  /** A machine whose default is `home`, at another site than the one the login signs in on. */
  async function homeEnv(): Promise<Record<string, string>> {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedTool(env, {
      activeProfile: 'home',
      profiles: { home: { baseUrl: 'http://home', apiKey: HOME_KEY } }
    });
    return env;
  }

  it('through the hub: the default stays, the line says so, and the profile is written beside it', async () => {
    const env = await homeEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.err()).toBe('Connected to http://tool as ada@x.co via Antasphere.\n' + stays('tool', 'home'));
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('home');
    expect(Object.keys(config.profiles)).toEqual(['home', 'tool']);
    expect(config.profiles.home).toEqual({ baseUrl: 'http://home', apiKey: HOME_KEY });
  });

  it('--json says madeDefault: false', async () => {
    const env = await homeEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    expect(await run(['login', '--json', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ profile: 'tool', via: 'login', madeDefault: false });
    expect(loadConfig(env).activeProfile).toBe('home');
  });

  it('with the site’s own email code, and with a pasted key: the default stays, the line says so', async () => {
    const env = await homeEnv();
    const otp = routedHarness([ossInstanceRoute, ...otpRoutes(key('minted')), meRoute()], env);
    scripted(otp, ['123456']);
    expect(await run(['login', '--api-url', 'http://inst', '--email', 'ada@x.co'], otp.io)).toBe(0);
    expect(otp.err()).toBe(
      'A sign-in code was sent to ada@x.co (if that account exists on http://inst).\n' + stays('inst', 'home')
    );

    const paste = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', key('paste'), '--api-url', 'http://other'], paste.io)).toBe(0);
    expect(paste.err()).toBe(stays('other', 'home'));
    expect(loadConfig(env).activeProfile).toBe('home');
  });

  it('on the default profile itself: no line', async () => {
    const env = await homeEnv();
    const h = routedHarness([meRoute(), revokeOk], env);
    expect(await run(['login', '--api-key', key('paste')], h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(loadConfig(env).profiles.home?.apiKey).toBe(key('paste'));
    // The key it replaced is revoked on the profile's site.
    expect(h.wire.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', origin: 'http://home', path: '/api/v1/cli/auth/key', auth: `Bearer ${HOME_KEY}` }
    ]);
  });

  it('the hub file’s active login never moves: a login at another hub than the active one is used, and a new one is written beside it', async () => {
    const env = await tempConfigEnv();
    const CLOUD_HUB_KEY = 'ant_cloudk12_secretsecretsecret1234';
    seedHub(env, {
      activeProfile: 'cloud',
      profiles: {
        cloud: { apiKey: CLOUD_HUB_KEY, baseUrl: 'https://account.antasphere.com', email: 'ada@x.co' }
      }
    });
    const h = routedHarness(
      [namingInstanceRoute(HUB), ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.path === '/api/v1/cli/auth/request').map((c) => c.origin)).toEqual([HUB]);
    expect(h.wire.some((c) => c.auth === `Bearer ${CLOUD_HUB_KEY}`)).toBe(false);
    const hubConfig = loadCoreConfig(env, HUB_TOOL);
    expect(hubConfig.activeProfile).toBe('cloud');
    expect(Object.keys(hubConfig.profiles)).toEqual(['cloud', 'hub']);
    expect(hubConfig.profiles.hub).toEqual({
      apiKey: HUB_KEY,
      baseUrl: HUB,
      email: 'ada@x.co',
      workspaceId: ORG
    });
  });

  it('one profile per site: a login at a site that has a profile signs in on it, under its own name', async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHubLogin(env);
    seedTool(env, { activeProfile: 'mine', profiles: { mine: { baseUrl: 'http://tool/' } } });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    expect(await run(['login', '--api-url', 'HTTP://TOOL'], h.io)).toBe(0);
    const config = loadConfig(env);
    expect(Object.keys(config.profiles)).toEqual(['mine']);
    expect(config.profiles.mine?.hubKeys?.[0]?.apiKey).toBe(key('tool'));
    expect(h.err()).toBe('Connected to http://tool as ada@x.co via Antasphere.\n');
  });

  it('a hub login on a profile holding a stale key of its own revokes and forgets it, and the next whoami answers through the login (PRDCT-3522)', async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHubLogin(env);
    const stale = key('stale');
    const minted = key('tool');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: { tool: { baseUrl: 'http://tool', apiKey: stale, email: 'ada@x.co' } }
    });
    const unknown = {
      status: 401,
      body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
    };
    const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '');
    const routes: Route[] = [
      cloudInstanceRoute,
      { method: 'DELETE', path: /\/api\/v1\/cli\/auth\/key$/, reply: () => unknown },
      ...exchangeRoutes([minted]),
      {
        method: 'GET',
        path: /\/api\/v1\/me$/,
        reply: ({ headers }) => (bearer(headers) === minted ? { body: meBody() } : unknown)
      }
    ];
    const h = routedHarness(routes, env);
    expect(await run(['login'], h.io)).toBe(0);
    // The own key goes once the exchange succeeded, never before it.
    expect(trace(h)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${stale}`,
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.apiKey).toBeUndefined();
    expect(tool?.email).toBeUndefined();
    expect(JSON.stringify(loadConfig(env))).not.toContain(stale);

    const next = routedHarness(routes, env);
    expect(await run(['whoami'], next.io)).toBe(0);
    expect(trace(next)).toEqual([`GET http://tool/api/v1/me Bearer ${minted}`]);
    expect(next.out()).toContain(`  signed in with: the Antasphere login ada@x.co at ${HUB} (kept key)\n`);
  });

  it('an exchange the hub refuses leaves the own key on the profile, alive on its site; a successful one revokes it there, then forgets it (lane review of part 1)', async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    seedHubLogin(env);
    const own = key('own');
    const minted = key('tool');
    seedTool(env, {
      activeProfile: 'tool',
      profiles: { tool: { baseUrl: 'http://tool', apiKey: own, email: 'ada@x.co' } }
    });
    const dead = new Set<string>();
    const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? '';
    const revokeOnTool: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: ({ headers }) => {
        dead.add(bearer(headers));
        return { body: { revoked: true, id: 'k' } };
      }
    };

    const refused = routedHarness(
      [
        cloudInstanceRoute,
        revokeOnTool,
        ...exchangeRoutes([minted], { toolToken: () => TOOL_ACCESS_DENIED }),
        meRoute()
      ],
      env
    );
    expect(await run(['login'], refused.io)).toBe(3);
    expect(refused.wire.some((c) => c.method === 'DELETE')).toBe(false);
    expect(dead.has(own)).toBe(false);
    expect(loadConfig(env).profiles.tool).toMatchObject({ apiKey: own, email: 'ada@x.co' });

    const ok = routedHarness([cloudInstanceRoute, revokeOnTool, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['login'], ok.io)).toBe(0);
    expect(ok.wire.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', origin: 'http://tool', path: '/api/v1/cli/auth/key', auth: `Bearer ${own}` }
    ]);
    expect(trace(ok).indexOf(`DELETE http://tool/api/v1/cli/auth/key Bearer ${own}`)).toBeGreaterThan(
      trace(ok).indexOf('POST http://tool/api/v1/sso/cli-connect -')
    );
    expect(dead.has(own)).toBe(true);
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.apiKey).toBeUndefined();
    expect(tool?.email).toBeUndefined();
    expect(tool?.hubKeys?.map((k) => k.apiKey)).toEqual([minted]);
  });

  it('no output of a login carries any part of a key', async () => {
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: HUB };
    const minted = key('tool');
    const otpKey = key('otpkey');
    const pasted = key('paste');
    const outputs: string[] = [];
    const record = (h: ReturnType<typeof routedHarness>) => outputs.push(h.out(), h.err());
    for (const json of [[], ['--json']]) {
      const hub = routedHarness(
        [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([minted]), meRoute()],
        env
      );
      scripted(hub, ['ada@x.co', '123456']);
      expect(await run(['login', ...json, '--api-url', 'http://tool'], hub.io)).toBe(0);
      record(hub);
      const self = routedHarness([ossInstanceRoute, ...otpRoutes(otpKey), meRoute()], env);
      scripted(self, ['ada@x.co', '123456']);
      expect(await run(['login', ...json, '--api-url', 'http://inst'], self.io)).toBe(0);
      record(self);
      const paste = routedHarness([meRoute()], env);
      expect(await run(['login', ...json, '--api-url', 'http://own', '--api-key', pasted], paste.io)).toBe(0);
      record(paste);
    }
    const all = outputs.join('\n');
    for (const secret of [minted, otpKey, pasted, HUB_KEY]) {
      // Neither the key nor its redaction (its first 13 characters, its last 4).
      expect(all).not.toContain(secret.slice(0, 13));
      expect(all).not.toContain(secret.slice(-8));
    }
    // Every seed above is on disk, so the scan looked at real runs.
    expect(Object.keys(loadConfig(env).profiles).sort()).toEqual(['inst', 'own', 'tool']);
  });
});

describe('the old sign-in pair is gone', () => {
  it.each([['login-request'], ['login-complete']])('`auth %s` is an unknown command', async (sub) => {
    const h = routedHarness([ossInstanceRoute] as Route[]);
    expect(await run(['auth', sub, '--email', 'ada@x.co'], h.io)).toBe(1);
    expect(h.err()).toContain("unknown command 'auth'");
    expect(h.wire).toEqual([]);
  });
});
