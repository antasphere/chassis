import type { ToolIdentity } from '@antasphere/chassis-contract';

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
