import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliConfigError } from '@antasphere/cli-core';
import { redactKey } from '@antasphere/chassis-cli';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';

// The kit's config store, and the literals that spell the tool (its identity).
const { clearConfig, configPath, loadConfig, updateConfig } = cli;
const { tool, keyPrefix: K } = cli.identity;

describe('CLI config store', () => {
  it(`round-trips profiles through $XDG_CONFIG_HOME/antasphere/tools/${tool}.json`, async () => {
    const env = await tempConfigEnv();
    expect(loadConfig(env)).toEqual({ profiles: {} });
    updateConfig(env, () => ({
      activeProfile: 'dev',
      profiles: { dev: { apiKey: `${K}_a_b`, baseUrl: 'http://localhost:3100' } }
    }));
    const loaded = loadConfig(env);
    expect(loaded.activeProfile).toBe('dev');
    expect(loaded.profiles.dev).toEqual({ apiKey: `${K}_a_b`, baseUrl: 'http://localhost:3100' });
  });

  it('every write is one updater: the change sees the file as it is now, and keeps what it does not touch', async () => {
    const env = await tempConfigEnv();
    updateConfig(env, () => ({ profiles: { a: { baseUrl: 'http://a' } } }));
    const { changed, config } = updateConfig(env, (draft) => {
      expect(draft.profiles.a).toEqual({ baseUrl: 'http://a' });
      draft.profiles.b = { baseUrl: 'http://b' };
    });
    expect(changed).toBe(true);
    expect(config.profiles).toEqual({ a: { baseUrl: 'http://a' }, b: { baseUrl: 'http://b' } });
    expect(loadConfig(env)).toEqual(config);
    // A change that changes nothing writes nothing.
    expect(updateConfig(env, () => undefined).changed).toBe(false);
  });

  it('creates the dir 0700 and the file 0600', async () => {
    const env = await tempConfigEnv();
    const { path } = updateConfig(env, () => ({ profiles: { p: { apiKey: `${K}_x_y` } } }));
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    const dir = path.slice(0, path.lastIndexOf('/'));
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME is unset', () => {
    // The tool's namespace of the SHARED antasphere config home
    // (@antasphere/cli-core) — moved there from ~/.config/<legacyConfigDir>/.
    expect(configPath({ HOME: '/home/u' })).toBe(`/home/u/.config/antasphere/tools/${tool}.json`);
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(`/xdg/antasphere/tools/${tool}.json`);
    expect(configPath({})).toBeNull();
  });

  it('a config file that does not parse is an error naming it, never an empty config, and nothing is written', async () => {
    const env = await tempConfigEnv();
    const { path } = updateConfig(env, () => ({ profiles: { p: { baseUrl: 'http://p' } } }));
    writeFileSync(path, 'not json');
    expect(() => loadConfig(env)).toThrow(CliConfigError);
    expect(() => loadConfig(env)).toThrow(path);

    // A command prints it like any usage error, exit 1, and the file is left as it was.
    const h = routedHarness([], env);
    expect(await run(['use', 'p'], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: The config file ${path} is not valid: it is not JSON. Nothing was changed; fix it or move it ` +
        'aside, then retry.\n'
    );
    expect(h.wire).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('not json');
  });

  it('clear removes the file', async () => {
    const env = await tempConfigEnv();
    updateConfig(env, () => ({ profiles: { p: {} } }));
    clearConfig(env);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('redacts keys to prefix…suffix (kept for the tools; no listing of the kit prints a key)', () => {
    expect(redactKey(`${K}_abcdefgh_0123456789abcdefghijklmnop`)).toBe(`${K}_abcdefgh_…mnop`);
    expect(redactKey('short')).toBe('****');
  });
});
