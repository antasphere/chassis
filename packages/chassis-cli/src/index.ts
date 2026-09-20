import type { ChassisClient } from '@antasphere/chassis-sdk';
import { createConfig } from './config.js';
import { createContext } from './context.js';
import type { Cli, CliDefinition, CliKit } from './kit.js';
import { createProgram } from './program.js';
import { createWorkspace } from './workspace.js';

/**
 * `@antasphere/chassis-cli`: the generic half of a tool's command line. The
 * profiles and the config file, the context (instance, key, workspace), the
 * workspace selection, secrets on stdin, the contained writes, the browser
 * opener, the generic command groups, the program and the runner. A tool
 * instantiates it ONCE (`defineCli`) with its identity and its client, and
 * its command modules read the kit that comes back.
 */

export { cliIdentity, type CliIdentity } from './identity.js';
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

export { safeDownloadName } from './commands/files.js';
export { explainProjectRefusal, memberRef, type ProjectLookup } from './commands/projects.js';
export { CliApiRefusal, drainPages } from './context.js';
export type { Cli, CliDefinition, CliKit, RegisterTool } from './kit.js';

export function defineCli<TClient extends ChassisClient<string>>(
  definition: CliDefinition<TClient>
): Cli<TClient> {
  const { identity, createClient } = definition;
  const config = createConfig(identity);
  const workspace = createWorkspace(identity);
  const context = createContext({ identity, createClient, config, workspace });
  const kit: CliKit<TClient> = { identity, createClient, ...config, workspace, ...context };
  return { ...kit, ...createProgram(kit, definition) };
}
