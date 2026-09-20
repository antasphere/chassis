import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { run } from './minimal-host.js';
import { cli, registerTool, VERSION } from './minimal-tool.js';

/**
 * The minimal `things` tool, pinned by RAW BYTES (PRDCT-2530, verifier F-4 /
 * F-2 / M18). This file is HOST-SPECIFIC: it sits beside the host, outside
 * `test/suite`, so it runs in this package only and never under a tool.
 *
 * The suite reads the identity from the kit under test, so it cannot tell a
 * wrong identity VALUE from a right one. Here nothing reads `cli.identity`:
 * every expectation is a literal ('things', 'Things', 'THINGS', 'thk'), which
 * proves from the chassis side that the six parameters are live. The tool's
 * CLI package carries the mirror with its own literals
 * (`packages/cli/test/identity.test.ts`).
 */

const CLOUD_INSTANCE = {
  name: 'Things Cloud',
  instanceId: 'i1',
  edition: 'cloud',
  version: '1.0.0',
  apiVersion: 'v1',
  setupRequired: false,
  auth: {
    methods: ['antasphere', 'api-key', 'oauth'],
    passwordReset: false,
    emailChange: false,
    twoFactor: false
  },
  features: { mcp: true, oauth: true, files: true }
};

const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
  role: 'owner',
  via: 'api_key',
  scopes: ['items:read'],
  apiKeyExpiresAt: null
};

const meRoute: Route = { method: 'GET', path: /\/api\/v1\/me$/, reply: () => ({ body: ME }) };

const LEGACY = {
  activeProfile: 'work',
  profiles: { work: { apiKey: 'thk_abcdefgh_0123456789abcdef', baseUrl: 'http://legacy-inst' } }
};

describe('the `things` identity, by its observable bytes', () => {
  it('legacyConfigDir: a config left at $XDG_CONFIG_HOME/things/config.json is imported', async () => {
    const env = await tempConfigEnv();
    const dir = join(env.XDG_CONFIG_HOME!, 'things');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify(LEGACY, null, 2));
    const h = routedHarness([meRoute], env);
    const code = await run(['whoami'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('http://legacy-inst');
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: 'http://legacy-inst',
        path: '/api/v1/me',
        auth: 'Bearer thk_abcdefgh_0123456789abcdef'
      }
    ]);
  });

  it('tool: the profiles live in $XDG_CONFIG_HOME/antasphere/tools/things.json', async () => {
    const env = await tempConfigEnv();
    const dir = join(env.XDG_CONFIG_HOME!, 'things');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify(LEGACY, null, 2));
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    const saved = await readFile(join(env.XDG_CONFIG_HOME!, 'antasphere', 'tools', 'things.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(LEGACY);
  });

  it('bin: the program is called `things`', async () => {
    const h = routedHarness([]);
    expect(await run(['--help'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe('Usage: things [options] [command]');
  });

  it('envPrefix: THINGS_URL and THINGS_API_KEY are the variables that are read', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute], {
      ...env,
      THINGS_URL: 'http://from-env',
      THINGS_API_KEY: 'thk_envkey12_0123456789abcdef'
    });
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: 'http://from-env',
        path: '/api/v1/me',
        auth: 'Bearer thk_envkey12_0123456789abcdef'
      }
    ]);
  });

  it('displayName, keyPrefix, envPrefix: the missing-hub-login sentence, whole', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [{ method: 'GET', path: /\/api\/v1\/instance$/, reply: () => ({ body: CLOUD_INSTANCE }) }],
      env
    );
    expect(await run(['files', 'list', '--api-url', 'http://tool'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: This Things instance signs in through the Antasphere hub. Run `antasphere login` once, ' +
        'then retry — or pass --api-key <thk_…> / set THINGS_API_KEY.\n'
    );
  });

  it('bin again: the 401 hint names `things verify` (M18)', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/me$/,
        reply: () => ({ status: 401, body: { error: { code: 'invalid_api_key', message: 'bad key' } } })
      }
    ]);
    expect(await run(['whoami', '--url', 'http://x', '--api-key', 'thk_k_s'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: bad key (check the key: `things verify`)\n');
  });
});

/** Every top-level command, in the order `--help` and the completion scripts print them. */
const COMMANDS = [
  // generic: identity and profiles, then the workspace selection
  'auth',
  'login',
  'logout',
  'whoami',
  'verify',
  'use',
  'profiles',
  'config',
  'workspaces',
  'workspace',
  // the tool's own group, at the seam
  'things',
  // generic: the platform substrate, then completion LAST
  'instance',
  'export',
  'files',
  'completion'
];

describe('the order of the top-level commands (F-2)', () => {
  it('the built program registers them in this order', () => {
    const h = routedHarness([]);
    expect(cli.buildProgram(h.io, registerTool, VERSION).commands.map((c) => c.name())).toEqual(COMMANDS);
  });

  it('`--help` lists them in this order, `help` last', async () => {
    const h = routedHarness([]);
    expect(await run(['--help'], h.io)).toBe(0);
    const block = h.out().split('Commands:\n')[1]!;
    const names = block
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/[ |]/)[0]);
    expect(names).toEqual([...COMMANDS, 'help']);
  });

  it('`completion bash` offers them in this order', async () => {
    const h = routedHarness([]);
    expect(await run(['completion', 'bash'], h.io)).toBe(0);
    expect(h.out()).toContain(`compgen -W "${COMMANDS.join(' ')}" -- "$cur"`);
  });
});
