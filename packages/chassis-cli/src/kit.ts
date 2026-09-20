import type { CliAuthError } from '@antasphere/cli-core';
import type { ChassisClient, ClientOptions, PlatformApiError } from '@antasphere/chassis-sdk';
import type { Command } from 'commander';
import type { CliConfigStore } from './config.js';
import type { CliContextKit, CliIo } from './context.js';
import type { CliIdentity } from './identity.js';
import type { CliWorkspace } from './workspace.js';

/** The tool's hook in the command tree: it registers its own groups on the program. */
export type RegisterTool = (program: Command, io: CliIo) => void;

export interface CliDefinition<TClient extends ChassisClient<string>> {
  /** What the tool is called, everywhere the generic CLI spells it (identity.ts). */
  identity: CliIdentity;
  /** The program's one-line description (`--help`'s first line after the usage). */
  description: string;
  /** The tool's client: every place the generic CLI builds one goes through this. */
  createClient: (options: ClientOptions) => TClient;
  /**
   * The tool's own hint for a refused request, as it is appended to the error
   * line (leading space and parentheses included), or undefined for none. The
   * runner asks after the 403 hint and before the 401 one.
   */
  errorHint?: (e: PlatformApiError | CliAuthError) => string | undefined;
}

/** The generic functions bound to one tool, as the command modules read them. */
export interface CliKit<TClient extends ChassisClient<string>>
  extends CliConfigStore, CliContextKit<TClient> {
  identity: CliIdentity;
  createClient: (options: ClientOptions) => TClient;
  /** The workspace functions that spell the tool (workspace.ts). */
  workspace: CliWorkspace;
}

/** What `defineCli` hands back: the kit, plus the program and the runner. */
export interface Cli<TClient extends ChassisClient<string>> extends CliKit<TClient> {
  /**
   * The command tree, built once per run: the global options, the auth,
   * workspace and project groups, THE TOOL'S GROUPS, then
   * instance/export/files, and the completion command last (it prints the
   * tree, so it must see all of it).
   */
  buildProgram(io: CliIo, registerTool: RegisterTool, version: string): Command;
  /**
   * Run the CLI with injected I/O and return a process exit code. The bin calls
   * this with real process streams; tests call it in-process.
   */
  run(argv: string[], rawIo: CliIo, registerTool: RegisterTool, version: string): Promise<number>;
}
