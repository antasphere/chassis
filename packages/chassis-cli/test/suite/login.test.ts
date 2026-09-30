import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { redactKey } from '@antasphere/chassis-cli';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meBody,
  meRoute,
  ORG,
  ossInstanceRoute,
  otpRoutes,
  seedHubLogin,
  TOOL_ACCESS_DENIED,
  wsRow
} from './signin-fixtures.js';

/**
 * ONE `login` that ends in the tool (PRDCT-2947): a pasted key, the
 * instance's email code (self-hosted), or the Antasphere sign-in then the
 * exchange (cloud). The profile it signs in on is the instance's, and it
 * becomes the active one.
 */

const { configPath, loadConfig, saveConfig } = cli;
const { envPrefix: P, keyPrefix: K, displayName, cloudUrl } = cli.identity;

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

describe('login with a pasted key', () => {
  it('verifies the key with /me, saves it on the instance profile and makes it active', async () => {
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
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute()], {
      ...env,
      [`${P}_API_KEY`]: inShell
    });
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://inst', '--email', 'ada@x.co'], h.io)).toBe(0);
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
      [`${P}_API_KEY`]: inShell
    });
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const tool = loadConfig(env).profiles.tool;
    expect(tool?.apiKey).toBeUndefined();
    expect(tool?.connectKeys?.default?.apiKey).toBe(minted);
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

  it('--json: the profile, the URL, how, who, where, and the file', async () => {
    const env = await tempConfigEnv();
    const pasted = key('paste');
    const me = meBody();
    const h = routedHarness([meRoute(me)], env);
    expect(await run(['login', '--json', '--api-key', pasted, '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'inst',
      baseUrl: 'http://inst',
      via: 'key',
      user: me.user,
      workspace: me.workspace,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(pasted);
  });

  it('--profile names the profile the key is saved on', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { work: { baseUrl: 'http://inst' } } });
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', key('paste'), '--profile', 'work'], h.io)).toBe(0);
    expect(loadConfig(env)).toEqual({
      activeProfile: 'work',
      profiles: { work: { apiKey: key('paste'), baseUrl: 'http://inst', email: 'ada@x.co' } }
    });
  });
});

describe('login on a self-hosted instance: the email code', () => {
  it('asks the email and the code, mints the key, saves it on the instance profile', async () => {
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
    expect(h.out()).toBe(
      'Signed in as Ada <ada@x.co> in Acme on http://inst.\n' +
        `API key "CLI login" (${redactKey(minted)}) saved to profile "inst" (${configPath(env)}).\n`
    );
    expect(h.out()).not.toContain(minted);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles.inst).toEqual({ apiKey: minted, baseUrl: 'http://inst', email: 'ada@x.co' });
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
      baseUrl: 'http://inst',
      via: 'otp',
      user: me.user,
      workspace: me.workspace,
      keyName: 'CLI login',
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
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
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
    // CLI's way (cli-core `selectProfile`: ANTASPHERE_URL=http://hub makes
    // the profile of that host, `hub`).
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'hub',
      profiles: { hub: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co', workspaceId: ORG } }
    });
    // The tool's key is cached on the instance profile, which is the active one.
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('tool');
    expect(config.profiles.tool?.baseUrl).toBe('http://tool');
    expect(config.profiles.tool?.apiKey).toBeUndefined();
    expect(config.profiles.tool?.connectKeys?.hub).toMatchObject({ apiKey: minted, email: 'ada@x.co' });
  });

  it('a clean machine: the hub profile `cloud` at account.antasphere.com', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
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
    expect(loadConfig(env).profiles.tool?.connectKeys?.cloud?.apiKey).toBe(key('tool'));
  });

  it('a stored hub login the hub rejects, with no ANTASPHERE_URL: re-signs in at the STORED hub URL, and the profile keeps its other fields', async () => {
    const env = await tempConfigEnv();
    saveCoreConfig(env, HUB_TOOL, {
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
    expect(loadConfig(env).profiles.tool?.connectKeys?.default?.apiKey).toBe(key('tool'));
  });

  it('a login revokes and replaces a cached key the instance no longer accepts (verifier round 1, F3)', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const dead = key('dead');
    const minted = key('tool');
    saveConfig(env, {
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
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${dead}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    const tool = loadConfig(env).profiles.tool;
    expect(Object.keys(tool?.connectKeys ?? {})).toEqual(['default']);
    expect(tool?.connectKeys?.default?.apiKey).toBe(minted);
    expect(JSON.stringify(loadConfig(env))).not.toContain(dead);
  });

  it('a login with a live cached key revokes it too, and ends with one new key on the profile', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const live = key('live');
    const minted = key('tool');
    saveConfig(env, {
      activeProfile: 'tool',
      profiles: { tool: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: live } } } }
    });
    const h = routedHarness(
      [
        cloudInstanceRoute,
        { method: 'DELETE', path: /\/api\/v1\/cli\/auth\/key$/, reply: () => ({ body: { revoked: true } }) },
        ...exchangeRoutes([minted]),
        meRoute()
      ],
      env
    );
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(h.wire.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', origin: 'http://tool', path: '/api/v1/cli/auth/key', auth: `Bearer ${live}` }
    ]);
    expect(h.wire.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(1);
    expect(h.wire.at(-1)).toMatchObject({ path: '/api/v1/me', auth: `Bearer ${minted}` });
    expect(loadConfig(env).profiles.tool?.connectKeys).toEqual({
      default: expect.objectContaining({ apiKey: minted })
    });
  });

  it('F9: --profile naming another instance than --api-url is refused before any request, and nothing moves', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const cached = key('cached');
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: cached } } } }
    });
    const before = JSON.stringify(loadConfig(env));
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    expect(await run(['login', '--profile', 'work', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([]);
    expect(h.err()).toBe(
      'Error: Profile "work" is the instance http://tool, and this login targets http://other. ' +
        'Drop --profile to sign in on the profile of http://other, or drop --api-url to sign in on "work".\n'
    );
    expect(JSON.stringify(loadConfig(env))).toBe(before);
  });

  it('F9: the same refusal for a pasted key: the profile is never repointed and the key goes nowhere', async () => {
    const env = await hubEnv();
    const own = `${K}_ownkey12_0123456789abcdefghij`;
    const pasted = `${K}_pasted12_0123456789abcdefghij`;
    saveConfig(env, { activeProfile: 'work', profiles: { work: { baseUrl: 'http://tool', apiKey: own } } });
    const h = routedHarness([meRoute()], env);
    expect(
      await run(['login', '--profile', 'work', '--api-url', 'http://other', '--api-key', pasted], h.io)
    ).toBe(1);
    expect(h.wire).toEqual([]);
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: 'http://tool', apiKey: own });
  });

  it('the hub profile keeps the name the hub CLI made active', async () => {
    const env = await hubEnv();
    saveCoreConfig(env, HUB_TOOL, { activeProfile: 'work', profiles: { work: { baseUrl: HUB } } });
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
    expect(loadConfig(env).profiles.tool?.connectKeys?.work?.apiKey).toBe(key('tool'));
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
    expect(config.profiles.cloud?.connectKeys?.default?.apiKey).toBe(minted);
    expect(h.out()).toBe(`Signed in as Ada <ada@x.co> in Acme on ${origin}.\n`);
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
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
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

  it('--email naming ANOTHER account than the stored login signs that account in afresh, and the cached key of the old one is revoked and replaced (PRDCT-3032)', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const old = key('adakey');
    const minted = key('bobkey');
    saveConfig(env, {
      activeProfile: 'tool',
      profiles: {
        tool: { baseUrl: 'http://tool', connectKeys: { default: { apiKey: old, email: 'ada@x.co' } } }
      }
    });
    const h = routedHarness(
      [
        cloudInstanceRoute,
        { method: 'DELETE', path: /\/api\/v1\/cli\/auth\/key$/, reply: () => ({ body: { revoked: true } }) },
        ...answeringAs('bob@x.co', [...otpRoutes(BOB_HUB_KEY, ORG), ...exchangeRoutes([minted])]),
        meRoute()
      ],
      env
    );
    const asked = scripted(h, ['123456']);
    expect(await run(['login', '--email', 'bob@x.co', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual(['Code: ']);
    expect(h.err()).toContain('Replacing the Antasphere login ada@x.co with bob@x.co.\n');
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      `DELETE http://tool/api/v1/cli/auth/key Bearer ${old}`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${BOB_HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.wire[1]?.body).toEqual({ email: 'bob@x.co' });
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default).toEqual({
      apiKey: BOB_HUB_KEY,
      baseUrl: HUB,
      email: 'bob@x.co',
      workspaceId: ORG
    });
    const tool = loadConfig(env).profiles.tool;
    expect(Object.keys(tool?.connectKeys ?? {})).toEqual(['default']);
    expect(tool?.connectKeys?.default).toMatchObject({ apiKey: minted, email: 'bob@x.co' });
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
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${key('tool')}`
    ]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(HUB_KEY);
  });

  it('--json: via antasphere, the hub profile, the workspaces', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const me = meBody({ workspaces: ORG_ROWS });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute(me)], env);
    expect(await run(['login', '--json', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'tool',
      baseUrl: 'http://tool',
      via: 'antasphere',
      hubProfile: 'default',
      user: me.user,
      workspace: me.workspace,
      workspaces: me.workspaces,
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

describe('the old sign-in pair is gone', () => {
  it.each([['login-request'], ['login-complete']])('`auth %s` is an unknown command', async (sub) => {
    const h = routedHarness([ossInstanceRoute] as Route[]);
    expect(await run(['auth', sub, '--email', 'ada@x.co'], h.io)).toBe(1);
    expect(h.err()).toContain("unknown command 'auth'");
    expect(h.wire).toEqual([]);
  });
});
