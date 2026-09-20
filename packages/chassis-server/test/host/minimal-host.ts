import { createPlatform } from '@antasphere/chassis-server';
import type { ChassisTestHost } from '@antasphere/chassis-server/testing';
import { THINGS_IDENTITY } from './identity.js';
import {
  minimalTool,
  THINGS_ROUTE,
  THINGS_SCOPES,
  type MinimalBootOverrides,
  type MinimalBootResult
} from './minimal-tool.js';

/**
 * The chassis package's host of the suite (`test/integration`): the chassis
 * composition bound to the minimal test tool. `@chassis-test/host` resolves
 * here under this package's vitest config; the tool's app aliases the same
 * specifier to its own host, over its real composition.
 */
export type HostBootResult = MinimalBootResult;
export type HostBootOverrides = MinimalBootOverrides;

const platform = createPlatform(minimalTool);

export const host: ChassisTestHost<HostBootResult, HostBootOverrides> = {
  boot: (source, overrides) => platform.boot(source, overrides),
  identity: THINGS_IDENTITY,
  hubClientId: 'tool-things-cloud',
  scopes: THINGS_SCOPES,
  probeRoute: THINGS_ROUTE
};
