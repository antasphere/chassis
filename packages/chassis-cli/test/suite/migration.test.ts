import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';

// The kit's config store, and the literals that spell the tool (its identity).
const { configPath, loadConfig, saveConfig } = cli;
const { tool, legacyConfigDir, keyPrefix: K } = cli.identity;

/**
 * The one-shot legacy-config import: profiles saved by pre-cli-core builds
 * at `$XDG_CONFIG_HOME/<legacyConfigDir>/config.json` are picked up on first run,
 * NON-destructively (the legacy file stays in place), then never again once
 * the shared home has the tool's profiles.
 */

const LEGACY = {
  activeProfile: 'work',
  profiles: {
    work: { apiKey: `${K}_abcdefgh_0123456789abcdef`, baseUrl: 'http://legacy-inst' }
  }
};

const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
  role: 'owner',
  via: 'api_key',
  scopes: ['presentations:read'],
  apiKeyExpiresAt: null
};

const meRoute: Route = { method: 'GET', path: /\/api\/v1\/me$/, reply: () => ({ body: ME }) };

async function writeLegacy(env: Record<string, string>, content: unknown): Promise<string> {
  const dir = join(env.XDG_CONFIG_HOME!, legacyConfigDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(content, null, 2));
  return path;
}

describe('legacy config migration', () => {
  it('a first run imports the legacy profile and commands ride it', async () => {
    const env = await tempConfigEnv();
    const legacyPath = await writeLegacy(env, LEGACY);
    const h = routedHarness([meRoute], env);
    const code = await run(['whoami'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    // whoami resolved the migrated profile's baseUrl + key.
    expect(h.out()).toContain('http://legacy-inst');
    // The shared-home file now exists with the imported content…
    expect(loadConfig(env)).toEqual(LEGACY);
    expect(configPath(env)).toBe(join(env.XDG_CONFIG_HOME!, 'antasphere', 'tools', `${tool}.json`));
    // …and the legacy file is untouched (non-destructive).
    expect(existsSync(legacyPath)).toBe(true);
    expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toEqual(LEGACY);
  });

  it('profiles lists the imported profiles; the import happens once', async () => {
    const env = await tempConfigEnv();
    await writeLegacy(env, LEGACY);
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    expect(h.out()).toContain('work');
    expect(h.out()).toContain('http://legacy-inst');

    // A later login under a new name does NOT get clobbered by a re-import.
    saveConfig(env, {
      activeProfile: 'new',
      profiles: {
        ...loadConfig(env).profiles,
        new: { apiKey: `${K}_new_key_1234567890`, baseUrl: 'http://new' }
      }
    });
    const h2 = routedHarness([], env);
    expect(await run(['profiles'], h2.io)).toBe(0);
    expect(loadConfig(env).activeProfile).toBe('new');
  });

  it(`the legacy file is ignored once the shared home has ${tool} profiles`, async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'current',
      profiles: { current: { apiKey: `${K}_current_key_12345`, baseUrl: 'http://current' } }
    });
    await writeLegacy(env, LEGACY);
    const h = routedHarness([meRoute], env);
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.out()).toContain('http://current');
    expect(loadConfig(env).profiles.work).toBeUndefined();
  });
});
