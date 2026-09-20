import type { ToolIdentity } from '@antasphere/chassis-contract';
import type { ChassisRoutesCopy } from '@antasphere/chassis-contract/routes';
import type { ToolCopy } from '@antasphere/chassis-server';

/**
 * The identity of the test tools of this package (`minimal-tool.ts`, and the
 * slot-less tool of `empty-tool.test.ts`): a tool called Things. Every value
 * is its own, the key prefix included: the suite reads the prefix from its
 * host (`host.identity.apiKeyPrefix`), so no file of this package spells a
 * real tool's.
 */
export const THINGS_IDENTITY = {
  slug: 'things',
  displayName: 'Things',
  apiKeyPrefix: 'thg',
  scopes: { read: 'things:read', write: 'things:write', dataExport: 'things:export' },
  cliKeyScopesLabel: 'things:read+write',
  cli: { bin: 'things', envPrefix: 'THINGS', legacyConfigDir: 'things' },
  mcp: { serverName: 'things', toolPrefix: 'things_' },
  otelServiceName: 'things',
  imageName: 'example.test/things'
} as const satisfies ToolIdentity;

/** The same tool's wording of the chassis refusals that name a domain (the `copy` slot). */
export const THINGS_COPY: ToolCopy = {
  guestForbidden: 'Guest access is limited to the things you were invited to',
  guestTarget:
    'This member is an external guest of one thing: their account is not this workspace’s to recover',
  fileInUse: 'This file is referenced by a thing'
};

/** And its wording of the OpenAPI document (`defineChassisRoutes`' third argument). */
export const THINGS_ROUTES_COPY: ChassisRoutesCopy = {
  fileInUseOpenApi: 'file_in_use: referenced by a thing'
};
