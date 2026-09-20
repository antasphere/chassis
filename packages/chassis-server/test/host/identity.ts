import type { ToolIdentity } from '@antasphere/chassis-contract';
import type { ToolCopy } from '@antasphere/chassis-server';

/**
 * The identity of the test tools of this package (`minimal-tool.ts`, and the
 * slot-less tool of `empty-tool.test.ts`): a tool called Things.
 *
 * ONE field is not neutral yet: `apiKeyPrefix` carries the value the suite
 * still asserts by literal (`platform-core`, `apikey-pepper-rotation`,
 * `edition`). It turns neutral when those lines read the host (PRDCT-2531, step 4).
 */
export const THINGS_IDENTITY = {
  slug: 'things',
  displayName: 'Things',
  apiKeyPrefix: 'slk',
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
  fileInUse: 'This file is referenced by a thing',
  fileInUseOpenApi: 'file_in_use: referenced by a thing'
};
