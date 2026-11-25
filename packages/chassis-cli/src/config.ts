import {
  clearConfig as coreClearConfig,
  configPath as coreConfigPath,
  loadConfig as coreLoadConfig,
  migrateLegacyConfig,
  updateConfig as coreUpdateConfig,
  type CliConfig,
  type CliEnv
} from '@antasphere/cli-core';
import type { CliIdentity } from './identity.js';

/**
 * The tool CLI's profiles live in the tool's own namespace (`identity.tool`)
 * of the shared Antasphere config home owned by @antasphere/cli-core:
 * `$XDG_CONFIG_HOME/antasphere/tools/<tool>.json` (default
 * `~/.config/antasphere/tools/<tool>.json`), 0700 dirs / 0600 file, fully
 * env-injected.
 *
 * ONE writer (R0): every change of the file is `updateConfig`, cli-core's
 * locked read-modify-write bound to the tool, so twenty commands writing at
 * once each keep what they wrote. Nothing here saves a copy read earlier. A
 * file that exists and does not parse is cli-core's `CliConfigError` naming
 * it (a usage error: the runner prints it, exit 1), never an empty config.
 *
 * Migration: the pre-cli-core config lived at
 * `$XDG_CONFIG_HOME/<legacyConfigDir>/config.json`. On any config read or
 * update, if that file still exists, holds at least one profile, and the
 * shared home has no profiles of the tool yet, it is imported once,
 * NON-destructively (the legacy file stays in place for older CLI builds; it
 * just stops being read).
 */

export { redactKey } from '@antasphere/cli-core';
export type {
  CliConfig,
  CliConnectKey,
  CliEnv,
  CliHubKey,
  CliProfile,
  CliSiteFacts
} from '@antasphere/cli-core';

/** What one `updateConfig` came to: the file, whether it changed, and what it holds now. */
export interface CliConfigUpdate {
  path: string;
  changed: boolean;
  config: CliConfig;
}

/** The config functions of one tool (its namespace, its legacy directory). */
export interface CliConfigStore {
  configPath(env: CliEnv): string | null;
  loadConfig(env: CliEnv): CliConfig;
  /**
   * The one way to change the tool's file (cli-core `updateConfig`): `change`
   * gets the file as it is now, under its lock, and changes it in place or
   * returns the config to write; nothing is written when nothing changed.
   */
  updateConfig(env: CliEnv, change: (config: CliConfig) => CliConfig | void): CliConfigUpdate;
  clearConfig(env: CliEnv): void;
}

export function createConfig(identity: CliIdentity): CliConfigStore {
  const TOOL = identity.tool;
  const LEGACY = { tool: TOOL, legacyDir: identity.legacyConfigDir };

  /** The one-shot legacy import (itself one `updateConfig`), before any read or update. */
  function migrate(env: CliEnv): void {
    try {
      migrateLegacyConfig(env, LEGACY);
    } catch {
      // A failed import must never break a read — worst case the user signs
      // in again; the legacy file is untouched either way. A shared file that
      // does not parse throws again, and is named, from the read itself.
    }
  }

  /** Where the config lives for this environment; null when no home is known. */
  function configPath(env: CliEnv): string | null {
    return coreConfigPath(env, TOOL);
  }

  /** Load the config (after the one-shot legacy import); a missing file is empty, a broken one throws. */
  function loadConfig(env: CliEnv): CliConfig {
    migrate(env);
    return coreLoadConfig(env, TOOL);
  }

  /** Change the config under its lock (0700 dirs / 0600 file). Throws when no home is known. */
  function updateConfig(env: CliEnv, change: (config: CliConfig) => CliConfig | void): CliConfigUpdate {
    migrate(env);
    return coreUpdateConfig(env, TOOL, change);
  }

  /** Delete the config file (config clear), under its lock. No-op when absent. */
  function clearConfig(env: CliEnv): void {
    coreClearConfig(env, TOOL);
  }

  return { configPath, loadConfig, updateConfig, clearConfig };
}
