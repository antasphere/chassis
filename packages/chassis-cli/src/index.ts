import type { ChassisClient, ClientOptions } from '@antasphere/chassis-sdk';
import { createConfig, type CliConfigStore } from './config.js';
import { createContext, type CliContextKit } from './context.js';
import type { CliIdentity } from './identity.js';
import { createWorkspace, type CliWorkspace } from './workspace.js';

/**
 * `@antasphere/chassis-cli`: the generic half of a tool's command line. The
 * profiles and the config file, the context (instance, key, workspace), the
 * workspace selection, secrets on stdin, the contained writes, the browser
 * opener. A tool instantiates it ONCE (`defineCli`) with its identity and
 * its client, and its command modules read the kit that comes back.
 */

export type { CliIdentity } from './identity.js';
export { redactKey, type CliConfigStore } from './config.js';
export type { CliConfig, CliConnectKey, CliEnv, CliProfile } from './config.js';
export {
  CliUsageError,
  fmtBytes,
  printJson,
  sanitizeForTty,
  setStdinApiKey,
  stdinApiKey,
  table,
  ttySafeIo,
  type CliContext,
  type CliContextKit,
  type CliIo
} from './context.js';
export {
  findWorkspace,
  isWorkspaceId,
  matchWorkspace,
  workspaceLines,
  type CliWorkspace,
  type MeResponse,
  type MeWorkspace,
  type WorkspaceSelection,
  type WorkspaceSource
} from './workspace.js';
export { readSecretFromStdin } from './stdin.js';
export {
  resolveInside,
  streamContained,
  UnsafeWriteError,
  writeContained,
  writeNoFollow
} from './safe-write.js';
export { isInteractive, openInBrowser, platformOpener } from './open.js';

export interface CliDefinition<TClient extends ChassisClient<string>> {
  /** What the tool is called, everywhere the generic CLI spells it (identity.ts). */
  identity: CliIdentity;
  /** The tool's client: every place the context builds one goes through this. */
  createClient: (options: ClientOptions) => TClient;
}

/** What `defineCli` hands back: the generic functions, bound to one tool. */
export interface CliKit<TClient extends ChassisClient<string>>
  extends CliConfigStore, CliContextKit<TClient> {
  identity: CliIdentity;
  /** The workspace functions that spell the tool (workspace.ts). */
  workspace: CliWorkspace;
}

export function defineCli<TClient extends ChassisClient<string>>(
  definition: CliDefinition<TClient>
): CliKit<TClient> {
  const { identity, createClient } = definition;
  const config = createConfig(identity);
  const workspace = createWorkspace(identity);
  const context = createContext({ identity, createClient, config, workspace });
  return { identity, ...config, workspace, ...context };
}
