import { Command, CommanderError } from 'commander';
import { CliAuthError } from '@antasphere/cli-core';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import { CliUsageError, setStdinApiKey, ttySafeIo, type CliIo } from './context.js';
import type { Cli, CliDefinition, CliKit, RegisterTool } from './kit.js';
import { readSecretFromStdin } from './stdin.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerWorkspaceCommands } from './commands/workspaces.js';
import { registerFileCommands } from './commands/files.js';
import { registerCompletionCommand } from './commands/completion.js';

/** The program and the runner of one tool, over its kit (kit.ts). */
export function createProgram<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  definition: Pick<CliDefinition<TClient>, 'description' | 'errorHint'>
): Pick<Cli<TClient>, 'buildProgram' | 'run'> {
  const { identity, explainWorkspaceRefusal, workspaceNotFoundHint } = kit;
  const { description, errorHint } = definition;

  function buildProgram(io: CliIo, registerTool: RegisterTool, version: string): Command {
    const program = new Command();
    program
      .name(identity.bin)
      .description(description)
      .version(version)
      .option('--api-url <url>', `instance base URL (or ${identity.envPrefix}_URL / profile baseUrl)`)
      .option('--url <url>', 'alias of --api-url')
      .option('--api-key <key>', `API key (or ${identity.envPrefix}_API_KEY / profile apiKey)`)
      .option(
        '--api-key-stdin',
        'read the API key from the first line of stdin (keeps it out of argv)',
        false
      )
      .option('--profile <name>', 'use this saved profile instead of the active one')
      .option(
        '--workspace <id-or-name>',
        `run in this workspace (or ${identity.envPrefix}_WORKSPACE / profile activeWorkspaceId; default: the server's)`
      )
      .option('--json', 'machine-readable JSON output', false);

    // Identity + profiles: auth login-request/login-complete, login, logout,
    // whoami, verify, use, profiles, config show/clear.
    registerAuthCommands(kit, program, io);
    // Which workspace the commands run in: workspaces, workspace use.
    registerWorkspaceCommands(kit, program, io);
    // The tool's own groups, where they have always sat in `--help`.
    registerTool(program, io);
    // Platform substrate (template heritage): instance, export, files *.
    registerFileCommands(kit, program, io);
    // Shell completion — registered LAST so the tree it prints is complete.
    registerCompletionCommand(identity, program, io);

    return program;
  }

  async function run(
    argv: string[],
    rawIo: CliIo,
    registerTool: RegisterTool,
    version: string
  ): Promise<number> {
    // Every human sink is wrapped ONCE, here: resource titles, annotation bodies,
    // stored filenames and server error messages are all somebody else's text
    // heading for a terminal (context.ts `sanitizeForTty`). `--json` keeps the
    // raw sink through `printJson`.
    const io = ttySafeIo(rawIo);

    // `--api-key-stdin` is resolved BEFORE commander parses: `resolveContext`
    // is synchronous, so the key must already be parked against this io by
    // the time a command asks for it. Reading stdin is the whole point — an
    // argv-borne secret is visible in `ps` and lands in the shell history.
    if (argv.includes('--api-key-stdin')) {
      try {
        setStdinApiKey(io, await readSecretFromStdin(io, 'API key'));
      } catch (e) {
        io.err.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }

    const program = buildProgram(io, registerTool, version);
    program.exitOverride();
    program.configureOutput({
      writeOut: (s) => io.out.write(s),
      writeErr: (s) => io.err.write(s)
    });
    try {
      await program.parseAsync(argv, { from: 'user' });
      return 0;
    } catch (e) {
      if (e instanceof CommanderError) {
        // --help / --version and usage errors already wrote their output.
        return e.exitCode;
      }
      if (e instanceof PlatformApiError || e instanceof CliAuthError) {
        // A refusal the workspace SELECTION caused reads as a bad key (401) or
        // a forbidden one (403) on the wire; say what it really was.
        const explained = await explainWorkspaceRefusal(io, e);
        if (explained) {
          io.err.write(`Error: ${explained}\n`);
          return 1;
        }
        const hint =
          e.status === 403
            ? ' (this API key is not allowed to do that)'
            : (errorHint?.(e) ??
              (e.status === 401
                ? ` (check the key: \`${identity.bin} verify\`)`
                : e.status === 404
                  ? workspaceNotFoundHint(io)
                  : ''));
        io.err.write(`Error: ${e.message}${hint}\n`);
        return 1;
      }
      if (e instanceof CliUsageError) {
        io.err.write(`Error: ${e.message}\n`);
        return 1;
      }
      io.err.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  return { buildProgram, run };
}
