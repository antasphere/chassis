import { ChassisClient } from '@antasphere/chassis-sdk';
import { defineCli, type CliIo } from '@antasphere/chassis-cli';
import type { Command } from 'commander';

/**
 * The minimal tool of the chassis suite: another identity than any product's
 * (so a literal left behind in the generic CLI shows), the bare chassis client
 * over its own scope names, and ONE trivial command group registered at the
 * seam, so the tool's positional hook in the program is exercised on every
 * run. It imports nothing from a tool.
 */
export type ThingsScope = 'things:read' | 'things:write' | 'things:export';

export const VERSION = '0.0.1';

export const cli = defineCli({
  identity: {
    bin: 'things',
    tool: 'things',
    legacyConfigDir: 'things',
    displayName: 'Things',
    envPrefix: 'THINGS',
    keyPrefix: 'thk',
    exportScope: 'things:export'
  },
  description: 'Command-line client for a Things instance',
  createClient: (options) => new ChassisClient<ThingsScope>(options)
});

/** The tool's one group: `things list`, a command that touches nothing. */
export function registerTool(program: Command, io: CliIo): void {
  const things = program.command('things').description('the things of this tool');
  things
    .command('list')
    .description('list the things')
    .action(() => {
      io.out.write('No things.\n');
    });
}
