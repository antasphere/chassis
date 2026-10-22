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
import { z } from 'zod';
import { THINGS_COPY, THINGS_IDENTITY, THINGS_ROUTES_COPY } from './identity.js';

/**
 * The MINIMAL test tool: the smallest tool that fills the required slots of
 * `createPlatform` and gives the chassis suite something of a tool's to aim
 * at. Its own three scope names, one tiny probe route per scope, the required
 * blob policy, no domain, no env extension, no jobs, no buckets, no public
 * app, no MCP tools.
 *
 * The migrations are a FIXTURE read by path, not an import (same stance as
 * `empty-tool.test.ts`): the chassis's own history, `test/host/drizzle`,
 * generated from the chassis schema by `pnpm db:generate` in this package
 * (the chassis tables and nothing else). A tool's history starts from the
 * same tables and adds its own; the tool's host of this suite boots on it.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FIXTURE = join(here, 'drizzle');

export const THINGS_SCOPES = THINGS_IDENTITY.scopes;
type ThingsScope = (typeof THINGS_SCOPES)[keyof typeof THINGS_SCOPES];

/** The probe routes, one per scope: authenticated, workspace-scoped, and empty. */
export const THINGS_ROUTE = '/api/v1/things';
/** What the host's connection handlers saw (PRDCT-3773), for the suite to read. */
export const connectionDeliveriesSeen: Array<{
  workspaceId: string;
  source: string;
  id: string;
  type: string;
  fields: Record<string, string | string[] | null>;
}> = [];
/** What the vault source's fields hook saw (PRDCT-3773). */
export const connectionFieldsSeen: Array<{
  workspaceId: string;
  fields: Record<string, string | string[] | null>;
}> = [];
const THINGS_EXPORT_ROUTE = '/api/v1/things/export';

const contract = defineChassisContract({
  scopes: [THINGS_SCOPES.read, THINGS_SCOPES.write, THINGS_SCOPES.dataExport, THINGS_SCOPES.webhooks]
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
      THINGS_SCOPES.dataExport,
      THINGS_SCOPES.webhooks
    ],
    // The webhooks scope rides the CLI key like the read and write scopes (Romain's ruling of 13 October 2026).
    cliKey: [THINGS_SCOPES.read, THINGS_SCOPES.write, THINGS_SCOPES.webhooks],
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
  // The webhooks catalog (PRDCT-3482): two events over two subjects, so the
  // chassis suite can emit, match, filter and deliver a tool's event. The
  // tool re-declares the chassis's `project` subject as a LIST under
  // `projectIds` (a thing in several projects), as a real tool does, so the
  // suite proves the chassis's own project events follow the tool's shape.
  webhooks: {
    subjects: {
      thing: { field: 'thingId', description: 'A thing of the workspace, by id' },
      project: { field: 'projectIds', description: 'The projects of a thing, by id', list: true }
    },
    events: [
      {
        type: 'thing.created',
        description: 'A thing was created.',
        subjects: ['thing', 'project'],
        data: z.object({ thingId: z.string(), name: z.string() })
      },
      {
        type: 'thing.deleted',
        description: 'A thing was deleted.',
        subjects: ['thing'],
        data: z.object({ thingId: z.string() })
      }
    ]
  },
  // The connections catalog (PRDCT-3773): an inbound source on the standard
  // scheme with a handler the suite watches, an inbound source on Stripe's
  // scheme, and a key source with a probe and a field, so the chassis suite
  // can connect, set, test, receive and read the log of a tool's sources.
  connections: {
    sources: [
      {
        key: 'partner',
        name: 'Partner',
        description: 'A partner service that posts its events here.',
        kind: 'inbound',
        events: ['thing.created', 'thing.deleted'],
        secretHint: 'whsec_…',
        secretPattern: /^whsec_[A-Za-z0-9+/=_-]{16,}$/,
        handler: async ({ workspaceId, source, delivery, fields }) => {
          connectionDeliveriesSeen.push({
            workspaceId,
            source,
            id: delivery.id,
            type: delivery.type,
            fields
          });
          if (delivery.type === 'thing.explode') throw new Error('the handler exploded');
          return { detail: `took ${delivery.type}` };
        }
      },
      {
        key: 'ledger',
        name: 'Ledger',
        kind: 'inbound',
        verifier: 'stripe',
        events: ['payment.succeeded'],
        handler: async ({ workspaceId, source, delivery, fields }) => {
          connectionDeliveriesSeen.push({
            workspaceId,
            source,
            id: delivery.id,
            type: delivery.type,
            fields
          });
        }
      },
      {
        key: 'vault',
        name: 'Vault',
        kind: 'key',
        secretHint: 'vk_…',
        secretPattern: /^vk_/,
        fields: [
          { key: 'folder', label: 'Folder', description: 'The folder the key reads', required: false },
          { key: 'labels', label: 'Labels', multiple: true }
        ],
        // A value a migration carried from a table of before the slot (test-only marker).
        migrateSecret: (sealed) =>
          sealed.startsWith('legacy:')
            ? Buffer.from(sealed.slice('legacy:'.length), 'base64').toString('utf8')
            : null,
        onFieldsChanged: async ({ workspaceId, fields }) => {
          connectionFieldsSeen.push({ workspaceId, fields });
        },
        probe: async ({ secret, fields }) => {
          if (secret === 'vk_down') return { ok: false, detail: 'Vault did not answer', unavailable: true };
          if (secret !== 'vk_good') return { ok: false, detail: 'Vault refused the key' };
          return { ok: true, detail: 'Vault answered', fields: { folder: fields.folder ?? 'root' } };
        }
      }
    ]
  },
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
  // tool's declaration, never the chassis'. The limit's oss value is the
  // operator's cap and so is the paid tier's (what discovery advertises is
  // what the instance serves, PRDCT-2653); the free value is a fifth of it,
  // so a suite can upload above the free value and below the cap as a pro
  // account. Self-hosted instances read the oss value alone.
  entitlements: (env) => {
    const capBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;
    return {
      actions: [{ key: 'files.upload', creditsPerUnit: 5, unit: 'bytes', label: 'Upload a file' }],
      limits: { 'files.maxBytes': { oss: capBytes, free: Math.floor(capBytes / 5), pro: capBytes } },
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
    scopes: { read: THINGS_SCOPES.read, write: THINGS_SCOPES.write, webhooks: THINGS_SCOPES.webhooks }
  },
  copy: THINGS_COPY
};
