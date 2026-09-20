import type { Db, DbHandle } from '@antasphere/chassis-db';
import type { ToolIdentity, UsageSink } from '@antasphere/chassis-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Hono, MiddlewareHandler } from 'hono';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { z } from 'zod';
import type { ExportEntriesFn } from './api/export.js';
import type { FileRouteDeps } from './api/files.js';
import type { ScopeRoutes } from './api/scope-routes.js';
import type { PepperRegistry } from './apikeys/peppers.js';
import type { AuditService } from './audit/service.js';
import type { EmailDriver } from './email/driver.js';
import type { EnvExtension, ToolEnv } from './env.js';
import type { FileService } from './files/service.js';
import type { Auth } from './identity/better-auth.js';
import type { HubFederationDials } from './identity/hub-reconcile.js';
import type { HubSsoService } from './identity/hub-sso.js';
import type { HubOrgCreator } from './identity/hub-user-client.js';
import type { JobDeclaration, Jobs } from './jobs/pgboss.js';
import type { Logger } from './logger.js';
import type { McpToolDefinition } from './mcp/server.js';
import type { BucketDeclaration, ClientIpFn, RateLimiters } from './middleware/rate-limit.js';
import type { Otel } from './observability/otel.js';
import type { EventBus } from './platform/events.js';
import type { PlatformRegistry } from './platform/registry.js';
import type { RuntimeState } from './state.js';
import type { StorageDriver } from './storage/driver.js';

/**
 * The tool definition: everything a product plugs into the chassis, as NAMED
 * SLOTS. The chassis owns the locked boot order (boot.ts), the locked
 * middleware and route registration order of the API app (api/create-api.ts)
 * and the mount order of the root app (app.ts); a tool never reorders
 * anything. Each positional hook below is invoked at one fixed place of those
 * sequences, named in its comment.
 */

/** A tool's bucket declarations: a tool bucket can never take a chassis bucket's name. */
export type ToolBuckets<TBuckets extends string> = {
  [K in TBuckets]: K extends keyof RateLimiters ? never : BucketDeclaration;
};

/** The limiters boot hands around: the chassis buckets plus the tool's own. */
export type ToolRateLimiters<TBuckets extends string> = RateLimiters & Record<TBuckets, RateLimiterAbstract>;

/**
 * What the `services` slot receives: the generic services that exist once the
 * storage is probed, before the rate limiters and the auth-dependent assembly.
 */
export interface ServiceCore<TEnvShape extends z.ZodRawShape, TEvents, TToolOverrides> {
  db: Db;
  env: ToolEnv<TEnvShape>;
  logger: Logger;
  storage: StorageDriver;
  fileService: FileService;
  pepperRegistry: PepperRegistry;
  email: EmailDriver;
  events: EventBus<TEvents>;
  authSecret: string;
  /** The tool's own test seams (`BootOverrides.tool`); undefined in production. */
  overrides: TToolOverrides | undefined;
}

/** The same, once the rate limiters exist: what the `publicRoutes` slot receives. */
export interface PlatformCore<
  TEnvShape extends z.ZodRawShape,
  TBuckets extends string,
  TEvents,
  TToolOverrides
> extends ServiceCore<TEnvShape, TEvents, TToolOverrides> {
  limiters: ToolRateLimiters<TBuckets>;
}

/** What the `jobs` slot receives. It runs BEFORE the services exist: the domain is read lazily. */
export interface JobsContext<TEnvShape extends z.ZodRawShape, TDomain> {
  env: ToolEnv<TEnvShape>;
  db: Db;
  logger: Logger;
  /** The `services` result, or null until that slot has run. Read it at RUN time, inside a handler. */
  getTool: () => TDomain | null;
}

/** What every positional hook of the API app receives. */
export interface ApiContext<TEnvShape extends z.ZodRawShape, TBuckets extends string, TEvents> {
  db: Db;
  env: ToolEnv<TEnvShape>;
  auth: Auth;
  registry: PlatformRegistry<TEvents>;
  logger: Logger;
  audit: AuditService;
  email: EmailDriver;
  limiters: ToolRateLimiters<TBuckets>;
  storage: StorageDriver;
  fileService: FileService;
  authSecret: string;
  /** Cloud presence switch (internal/federation.md): undefined on oss. */
  hubSso: HubSsoService | undefined;
}

/** The rate-limit hook also gets the client-identity function the chassis walls key on. */
export interface ApiRateLimitContext<
  TEnvShape extends z.ZodRawShape,
  TBuckets extends string,
  TEvents
> extends ApiContext<TEnvShape, TBuckets, TEvents> {
  clientIp: ClientIpFn;
}

/** The routes hook also gets the cached instance id for usage-event sources. */
export interface ApiRoutesContext<
  TEnvShape extends z.ZodRawShape,
  TBuckets extends string,
  TEvents
> extends ApiRateLimitContext<TEnvShape, TBuckets, TEvents> {
  instanceId: () => Promise<string>;
}

/** The answer of the body-limit slot for one path: no cap here, this cap, or (undefined) the 1 MiB default. */
export type BodyLimitVerdict = 'exempt' | MiddlewareHandler | undefined;

/** The generic files surface's per-blob policy (SL-B1): the tool owns what references a blob. */
export type FilePolicy = Pick<FileRouteDeps, 'blobInUse' | 'blobReadScope'>;

/**
 * The tool's WORDING of the chassis refusals that name its domain (slot 21).
 * Not identity: these sentences say what the tool's resource is called, where
 * the chassis only knows "a guest" and "a blob in use". Every field is the
 * complete sentence, sent as written. REQUIRED, no chassis default.
 */
export interface ToolCopy {
  /** 403 `guest_forbidden`, from both sources: the `requireNonGuest()` guard and the workspace creation refusal. */
  guestForbidden: string;
  /** 403 `guest_target`: the credential mints under `/members` refuse a guest target. */
  guestTarget: string;
  /** 409 `file_in_use`: the message of `DELETE /files/{id}` when the tool's `blobInUse` says yes. */
  fileInUse: string;
  /**
   * The words of the account mails that are the tool's own. The layout
   * (email/shell.ts) and every other sentence of those five mails are the
   * chassis's; these three say what the tool IS, which the chassis cannot know.
   */
  mail: {
    /** One line under the footer's name: what this product is. */
    tagline: string;
    /** Workspace invitation, the sentence after "…a workspace on <name>.": what joining gives. */
    invitePitch: string;
    /** Workspace invitation's inbox preview, the end of "Join <workspace> on <name>: …". */
    invitePreheader: string;
  };
}

export interface ToolApiSlots<TEnvShape extends z.ZodRawShape, TDomain, TBuckets extends string, TEvents> {
  /**
   * Origins that are never trusted (slot 9). ONE source for both the
   * cross-site guard's `deniedOrigins` and Better Auth's `untrustedOrigins`.
   * Empty = nothing installed.
   */
  untrustedOrigins?: (env: ToolEnv<TEnvShape>) => string[];
  /** Paths the cross-site guard lets through (slot 10): token-authed, cookie-less surfaces only. */
  csrfExempt?: (path: string) => boolean;
  /** Paths exempt from the generic audit row (slot 10), beside the chassis ones. */
  auditExempt?: (path: string) => boolean;
  /** The tool's Idempotency-Key targets (POST only), beside the chassis ones. */
  idempotencyTargets?: (path: string) => boolean;
  /** Positional hook (slot 11): right after `noStoreAuthenticated()`, before the body caps. */
  early?: (api: OpenAPIHono, ctx: ApiContext<TEnvShape, TBuckets, TEvents>) => void;
  /**
   * Body-size caps (slot 12). Called ONCE at registration (build the limit
   * middlewares here, never per request); the returned function is consulted
   * per request AFTER the chassis `/files` rule and BEFORE the 1 MiB default.
   */
  bodyLimit?: (ctx: ApiContext<TEnvShape, TBuckets, TEvents>) => (path: string) => BodyLimitVerdict;
  /** Paths exempt from the JSON nesting cap (slot 13): bodies that are never parsed. */
  jsonDepthExempt?: (path: string) => boolean;
  /** Positional hook (slot 14): between the `/invitations/*` walls and the `/admin/break-glass/*` wall. */
  rateLimits?: (api: OpenAPIHono, ctx: ApiRateLimitContext<TEnvShape, TBuckets, TEvents>) => void;
  /**
   * The files routes' blob policy (slot 15). REQUIRED: what references a blob,
   * and who may read one, is the tool's to state — the chassis has no default
   * (a blob read is never authorized on `workspace_id` alone, SL-B1).
   */
  filePolicy: (tool: TDomain) => FilePolicy;
  /**
   * The tool's entries of `GET /workspace/export` (slot 15b). OPTIONAL: absent,
   * the bundle is the chassis sections and the blobs, byte for byte. Called
   * ONCE at registration with the tool's domain; the returned function runs
   * per export, with the handle the route reads with (`db`, not a transaction)
   * and the workspace id, and filters on that workspace ITSELF. Each entry is
   * written as `<sanitized name>.json`, after `files.json` and before the
   * blobs, in the order returned; an empty list writes nothing. Every entry is
   * computed before the first byte: a throw, a name of
   * `RESERVED_EXPORT_ENTRY_NAMES` or the same name twice answers 500, never a
   * truncated zip. The manifest does not list them. Select the columns to
   * export: a secret left in a row leaves the instance.
   */
  exportEntries?: (tool: TDomain) => ExportEntriesFn;
  /**
   * Positional hook (slot 16): AFTER the files routes, BEFORE the OpenAPI
   * document and the JSON 404. The tool keeps its own internal order.
   */
  routes?: (api: OpenAPIHono, ctx: ApiRoutesContext<TEnvShape, TBuckets, TEvents>, tool: TDomain) => void;
}

export interface ToolAppSlots<TEnvShape extends z.ZodRawShape, TDomain, TBuckets extends string, TEvents> {
  /**
   * Positional hook (slot 17): after the metrics middleware, before `onError`
   * and every mount. Return undefined to install NOTHING.
   */
  rootMiddleware?: (env: ToolEnv<TEnvShape>) => MiddlewareHandler | undefined;
  /** Extra `frame-src` origins of the dashboard CSP (slot 18). */
  cspFrameSrc?: (env: ToolEnv<TEnvShape>) => string[];
  /** A public Hono app (slot 19), mounted after well-known, before static and the SPA fallback. */
  publicRoutes?: (core: PlatformCore<TEnvShape, TBuckets, TEvents, never>, tool: TDomain) => Hono;
}

export interface ToolDefinition<
  TEnvShape extends z.ZodRawShape,
  TDomain,
  TBuckets extends string = never,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TEvents = {},
  TToolOverrides = never
> {
  /**
   * Slot 0: the tool's identity, the ONE value that names it (`ToolIdentity`,
   * written in the tool's contract package). REQUIRED, and the chassis has no
   * default for any of its fields: a tool that leaves one out fails to compile,
   * and fails to boot (`assertToolIdentity`).
   */
  identity: ToolIdentity;
  /** Slot 1: facts of the APP's packaging, computed from the app's own entry file. */
  runtime: {
    /** The tool's package version: the default of APP_VERSION. */
    version: string;
    /** Resolves the committed migrations folder; throws when none exists. Called once, at the migration stage. */
    findMigrationsDir: () => string;
    /** Directory holding the built dashboard SPA. */
    publicDir: string;
  };
  /** Slot 2: the pool + drizzle handle over the tool's merged schema. */
  db: (url: string) => DbHandle;
  /** Slot 3: the tool's own environment keys, merged into the chassis schema. */
  env?: EnvExtension<TEnvShape>;
  /** Slot 4: the scope vocabulary and the machine allowlist. */
  scopes: {
    /** The published OAuth scope list (order included). */
    oauth: readonly string[];
    /** The CLI key's fixed grant. */
    cliKey: readonly string[];
    /** The composed fail-closed allowlist: chassis rules first, then the tool's; null = 403. */
    requiredScopeFor: (path: string, method: string) => string | null;
    /** The generic routes that carry the tool's scopes or wording (`defineChassisRoutes(contract, identity, copy)`). */
    contractRoutes: ScopeRoutes;
  };
  /**
   * Slot 5 (and 6): called ONCE, right after the storage probe and before the
   * rate limiters and the auth-dependent assembly. The returned object is
   * `BootResult.tool`. A tool subscribes to `core.events` here.
   */
  services: (core: ServiceCore<TEnvShape, TEvents, TToolOverrides>) => TDomain;
  /** Slot 7: declared BEFORE the pg-boss install lock opens; handlers read the domain lazily. */
  jobs?: (ctx: JobsContext<TEnvShape, TDomain>) => JobDeclaration[];
  /** Slot 8: extra named buckets built by the chassis factory. */
  rateLimiters?: ToolBuckets<TBuckets>;
  /** Slots 9-16. */
  api: ToolApiSlots<TEnvShape, TDomain, TBuckets, TEvents>;
  /** Slots 17-19. */
  app?: ToolAppSlots<TEnvShape, TDomain, TBuckets, TEvents>;
  /**
   * Slot 20: the MCP definition. (The server's name, the tool names' prefix and
   * the name of an instance that is not set up yet come from `identity`.)
   */
  mcp: McpToolDefinition;
  /** Slot 21: the tool's wording of the chassis refusals that name its domain. */
  copy: ToolCopy;
}

/** Test seams only — production boot never passes overrides. */
export interface BootOverrides<TToolOverrides = never> {
  /** Downstream sink the pg-boss worker hands batches to (default: no-op). */
  usageDownstream?: UsageSink;
  /**
   * Replaces the env-derived email driver. Exists because change-email tokens
   * are stateless JWTs (never stored) — tests can only observe them by
   * recording the outbound mail.
   */
  email?: EmailDriver;
  /**
   * Shrinks the live-federation dials (reconcile TTL / stale window /
   * timeouts, identity/hub-reconcile.ts) so integration tests can watch
   * suspension/removal/grant-death propagate in milliseconds. Production
   * always runs the fixed defaults.
   */
  hubDials?: Partial<HubFederationDials>;
  /**
   * Replaces the ONE hub call POST /workspaces makes on cloud
   * (`HubUserClient.createOrg`) — the function boundary its tests fake to
   * drive every hub answer without a hub. Ignored on oss.
   */
  hubCreateOrg?: HubOrgCreator;
  /** The tool's own test seams, handed to its `services` slot as `core.overrides`. */
  tool?: TToolOverrides;
}

export interface BootResult<
  TEnvShape extends z.ZodRawShape,
  TDomain,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TEvents = {}
> {
  app: Hono;
  env: ToolEnv<TEnvShape>;
  logger: Logger;
  state: RuntimeState;
  db: DbHandle;
  auth: Auth;
  /** What the tool's `services` slot returned. */
  tool: TDomain;
  registry: PlatformRegistry<TEvents>;
  jobs: Jobs;
  email: EmailDriver;
  otel: Otel;
  authSecret: string;
}

/**
 * The boot-time half of "identity is required": a definition that reached the
 * chassis untyped (plain JS, a cast) with a field missing or empty stops the
 * boot here, naming the field. Never a silent fallback name.
 */
export function assertToolCopy(copy: ToolCopy | undefined): asserts copy is ToolCopy {
  if (!copy) throw new Error('tool definition: the `copy` slot is required');
  for (const name of ['guestForbidden', 'guestTarget', 'fileInUse'] as const) {
    if (typeof copy[name] !== 'string' || copy[name] === '') {
      throw new Error(`tool definition: copy.${name} is required (a non-empty sentence)`);
    }
  }
  for (const name of ['tagline', 'invitePitch', 'invitePreheader'] as const) {
    if (typeof copy.mail?.[name] !== 'string' || copy.mail[name] === '') {
      throw new Error(`tool definition: copy.mail.${name} is required (non-empty words)`);
    }
  }
}

export function assertToolIdentity(identity: ToolIdentity | undefined): asserts identity is ToolIdentity {
  if (!identity) throw new Error('tool definition: the `identity` slot is required');
  const i = identity as unknown as Record<string, Record<string, unknown> | undefined> &
    Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['slug', i.slug],
    ['displayName', i.displayName],
    ['apiKeyPrefix', i.apiKeyPrefix],
    ['scopes.read', i.scopes?.read],
    ['scopes.write', i.scopes?.write],
    ['scopes.dataExport', i.scopes?.dataExport],
    ['cliKeyScopesLabel', i.cliKeyScopesLabel],
    ['cli.bin', i.cli?.bin],
    ['cli.envPrefix', i.cli?.envPrefix],
    ['cli.legacyConfigDir', i.cli?.legacyConfigDir],
    ['mcp.serverName', i.mcp?.serverName],
    ['mcp.toolPrefix', i.mcp?.toolPrefix],
    ['otelServiceName', i.otelServiceName],
    ['imageName', i.imageName]
  ];
  for (const [name, value] of fields) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`tool definition: identity.${name} is required (a non-empty string)`);
    }
  }
}
