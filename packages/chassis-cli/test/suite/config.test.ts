import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactKey } from '@antasphere/chassis-cli';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli } from '@chassis-cli-test/host';

// The kit's config store, and the literals that spell the tool (its identity).
const { clearConfig, configPath, loadConfig, saveConfig } = cli;
const { tool, keyPrefix: K } = cli.identity;

describe('CLI config store', () => {
  it(`round-trips profiles through $XDG_CONFIG_HOME/antasphere/tools/${tool}.json`, async () => {
    const env = await tempConfigEnv();
    expect(loadConfig(env)).toEqual({ profiles: {} });
    saveConfig(env, {
      activeProfile: 'dev',
      profiles: { dev: { apiKey: `${K}_a_b`, baseUrl: 'http://localhost:3100' } }
    });
    const loaded = loadConfig(env);
    expect(loaded.activeProfile).toBe('dev');
    expect(loaded.profiles.dev).toEqual({ apiKey: `${K}_a_b`, baseUrl: 'http://localhost:3100' });
  });

  it('creates the dir 0700 and the file 0600', async () => {
    const env = await tempConfigEnv();
    const path = saveConfig(env, { profiles: { p: { apiKey: `${K}_x_y` } } });
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

  it('treats a corrupt config file as empty instead of crashing', async () => {
    const env = await tempConfigEnv();
    const path = saveConfig(env, { profiles: {} });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, 'not json');
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('clear removes the file', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { p: {} } });
    clearConfig(env);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('redacts keys to prefix…suffix', () => {
    expect(redactKey(`${K}_abcdefgh_0123456789abcdefghijklmnop`)).toBe(`${K}_abcdefgh_…mnop`);
    expect(redactKey('short')).toBe('****');
  });
});
