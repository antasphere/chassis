import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, schema } from '@antasphere/chassis-db';
import {
  auditedSizeBytes,
  declareRouteEntitlements,
  declaredContentLength,
  defineChassisContract
} from '@antasphere/chassis-contract';
import { defineChassisRoutes, fileUploadRoute } from '@antasphere/chassis-contract/routes';
import type { BootOverrides, BootResult, ToolDefinition } from '@antasphere/chassis-server';
import { createScopeAllowlist, requireAuth } from '@antasphere/chassis-server/middleware';
import { THINGS_COPY, THINGS_IDENTITY, THINGS_ROUTES_COPY } from './identity.js';

/**
 * The MINIMAL test tool: the smallest tool that fills the required slots of
 * `createPlatform` and gives the chassis suite something of a tool's to aim
 * at. Its own three scope names, one tiny probe route per scope, the required
 * blob policy, no domain, no env extension, no jobs, no buckets, no public
 * app, no MCP tools.
 *
 * The migrations are a FIXTURE read by path, not an import (same stance as
 * `empty-tool.test.ts`): the only migration history that exists today is
 * the tool's (`packages/db/drizzle`, which also creates the deck tables,
 * unused here).
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FIXTURE = join(here, '../../../db/drizzle');

export const THINGS_SCOPES = THINGS_IDENTITY.scopes;
type ThingsScope = (typeof THINGS_SCOPES)[keyof typeof THINGS_SCOPES];

/** The probe routes, one per scope: authenticated, workspace-scoped, and empty. */
export const THINGS_ROUTE = '/api/v1/things';
const THINGS_EXPORT_ROUTE = '/api/v1/things/export';

const contract = defineChassisContract({
  scopes: [THINGS_SCOPES.read, THINGS_SCOPES.write, THINGS_SCOPES.dataExport]
});

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoEnv = {};
type NoDomain = Record<string, never>;

export type MinimalBootOverrides = BootOverrides;
export type MinimalBootResult = BootResult<NoEnv, NoDomain>;

export const minimalTool: ToolDefinition<NoEnv, NoDomain> = {
  identity: THINGS_IDENTITY,
  runtime: {
    version: '0.0.0-test',
    findMigrationsDir: () => MIGRATIONS_FIXTURE,
    publicDir: join(here, 'no-dashboard-build')
  },
  db: (url) => createDb(url, schema),
  scopes: {
    oauth: [
      'openid',
      'profile',
      'email',
      'offline_access',
      THINGS_SCOPES.read,
      THINGS_SCOPES.write,
      THINGS_SCOPES.dataExport
    ],
    cliKey: [THINGS_SCOPES.read, THINGS_SCOPES.write],
    requiredScopeFor: createScopeAllowlist<ThingsScope>({
      ...THINGS_SCOPES,
      rules: [
        (path, _method, isRead) => {
          if (path === THINGS_ROUTE) return isRead ? THINGS_SCOPES.read : THINGS_SCOPES.write;
          if (path === THINGS_EXPORT_ROUTE && isRead) return THINGS_SCOPES.dataExport;
          return null;
        }
      ]
    }),
    contractRoutes: defineChassisRoutes(contract, THINGS_IDENTITY, THINGS_ROUTES_COPY)
  },
  services: () => ({}),
  api: {
    // TEST FIXTURE ONLY: `undefined` is the whole-workspace view, for every member. The suite's
    // files tests never assert member-to-member privacy (that proof is the tool's, SL-B1), so
    // nothing here reads as a policy to copy: a real tool MUST return a per-principal scope.
    filePolicy: () => ({ blobInUse: async () => false, blobReadScope: () => undefined }),
    routes: (api) => {
      api.use('/things', requireAuth());
      api.use('/things/*', requireAuth());
      api.get('/things', (c) => c.json({ things: [], nextCursor: null }, 200));
      api.post('/things', (c) => c.json({ thing: { id: 'thing' } }, 201));
      api.get('/things/export', (c) => c.json({ things: [] }, 200));
    }
  },
  // The billing rail (slot 22): the generic files upload is the one metered
  // route of the minimal tool — a price on the chassis' own route is the
  // tool's declaration, never the chassis'. The limit's oss and free values
  // are the operator's cap, so nothing changes on either edition below it.
  entitlements: (env) => {
    const capBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;
    return {
      actions: [{ key: 'files.upload', creditsPerUnit: 5, unit: 'bytes', label: 'Upload a file' }],
      limits: { 'files.maxBytes': { oss: capBytes, free: capBytes, pro: 5 * capBytes } },
      features: { 'things.premium': { free: false, pro: true } },
      routes: declareRouteEntitlements([
        {
          route: fileUploadRoute,
          meter: { key: 'files.upload', unit: 'bytes', quantity: auditedSizeBytes },
          limit: { key: 'files.maxBytes', value: declaredContentLength }
        }
      ])
    };
  },
  mcp: {
    registerTools: () => {},
    instructions: (info) => `MCP endpoint of the "${info.instanceName}" instance.`,
    errorHints: {},
    scopes: { read: THINGS_SCOPES.read, write: THINGS_SCOPES.write }
  },
  copy: THINGS_COPY
};
