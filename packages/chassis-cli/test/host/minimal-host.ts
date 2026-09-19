import type { ChassisClient } from '@antasphere/chassis-sdk';
import type { CliIo } from '@antasphere/chassis-cli';
import type { CliTestHost } from '@antasphere/chassis-cli/testing';
import { cli as thingsCli, registerTool, VERSION, type ThingsScope } from './minimal-tool.js';

/**
 * The host of the chassis suite in THIS package: the minimal `things` tool.
 * `@chassis-cli-test/host` resolves here under `vitest.config.ts`; the tool's
 * CLI package aliases the same specifier to its own kit.
 */
const host: CliTestHost<ChassisClient<ThingsScope>> = {
  cli: thingsCli,
  run: (argv: string[], io: CliIo) => thingsCli.run(argv, io, registerTool, VERSION)
};

export const { cli, run } = host;
