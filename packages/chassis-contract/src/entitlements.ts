import { z } from 'zod';
import type { HeaderReader, Principal } from './seams.js';

/**
 * The billing rail's declaration layer (the pay-per-use billing rail spec,
 * §7 and §8b): a route says ONCE, next to its contract, what it meters, which
 * limit it checks and which feature it needs. One chassis middleware reads
 * the declaration and enforces it for every client of `/api/v1` at once (the
 * dashboard, the CLI and the MCP tools are all HTTP clients of it), and a
 * handler never checks or emits by hand.
 *
 * Client-safe on purpose: no Hono here. A route is referenced by its
 * `{ method, path }` as the OpenAPI helper spells it (`{id}` params), so the
 * tool's contract builds the registry from its route objects and the SDK can
 * read the same declarations without pulling the server.
 */

/**
 * The plan tiers, a CLOSED enum the hub owns and this contract mirrors so a
 * tool cannot invent one (§8b). `free` is the default with no subscription;
 * `pro` is the paid plan. "Enterprise" is not a tier but a per-account
 * override the hub serves.
 */
export const ENTITLEMENT_TIERS = ['free', 'pro'] as const;
export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number];
export const entitlementTierSchema = z.enum(ENTITLEMENT_TIERS);
/** The hub's name for the same closed enum (`BILLING_PLANS` in `@antasphere/contract`). */
export const BILLING_PLANS = ENTITLEMENT_TIERS;

/**
 * The one scope of the tool → hub machine channel (§6): a `client_credentials`
 * token on the registry client, reaching `/usage/*` and nothing else.
 */
export const USAGE_WRITE_SCOPE = 'usage:write';

/**
 * The wire shape of one usage event as the hub ingests it: the hub's
 * `usageEventSchema` (`packages/contract/src/schemas/billing.ts` of the hub,
 * PRDCT-2625) MIRRORED VERBATIM, so the fake hub of the test kit refuses
 * exactly what the real hub refuses (PRDCT-2629). `userId` is the HUB user
 * (the SSO `sub`), never the tool's local id, and null when the actor is a
 * resource owner the tool could not name; `accountRef` is the hub
 * organization id (a uuid) the tool carries as its workspace's central
 * account id. `toolSlug` is accepted by the hub only when it equals the
 * calling token's registry slug — the chassis NEVER sends it: the token is
 * the only authority on the tool's name, the body never names the tool
 * (PRDCT-2629; `UsageEvent` in seams.ts has no such field).
 */
export const usageEventSchema = z
  .object({
    id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'a ULID'),
    actionKey: z.string().min(1).max(120).optional(),
    meter: z.string().min(1).max(120).optional(),
    quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    unit: z.string().min(1).max(40),
    occurredAt: z.iso.datetime({ offset: true }),
    workspaceId: z.string().min(1).max(128),
    accountRef: z.uuid(),
    userId: z.string().min(1).max(128).nullable().optional(),
    via: z.enum(['session', 'api_key', 'oauth']),
    resourceType: z.string().min(1).max(80).nullable().optional(),
    resourceId: z.string().min(1).max(256).nullable().optional(),
    toolSlug: z.string().min(1).max(64).optional(),
    source: z.object({
      instanceId: z.string().min(1).max(128),
      edition: z.string().min(1).max(32),
      version: z.string().min(1).max(64)
    })
  })
  .refine((e) => e.actionKey !== undefined || e.meter !== undefined, {
    message: 'actionKey (or its legacy alias meter) is required',
    path: ['actionKey']
  });

/** The hub's answer to `POST /usage/events`: one result per element, in the batch's order. */
export const usageIngestResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().nullable(),
      status: z.enum(['accepted', 'duplicate', 'rejected']),
      reason: z.string().optional(),
      details: z.unknown().optional()
    })
  ),
  accepted: z.number().int().optional(),
  duplicate: z.number().int().optional(),
  rejected: z.number().int().optional()
});
export type UsageIngestResult = z.infer<typeof usageIngestResultSchema>;

/**
 * What a declaration's functions see: the request as the chassis reads it.
 * `audit` is present only AFTER the handler ran (the emit), carrying what the
 * handler recorded for its audit row — the place a stored size or a created
 * resource id lives.
 */
export interface EntitlementRequest {
  method: string;
  path: string;
  headers: HeaderReader;
  /** Route params by name (`{id}` → its value). */
  params: Record<string, string>;
  principal: Principal | null;
  audit?:
    | { action: string; resourceType: string; resourceId?: string; metadata?: Record<string, unknown> }
    | undefined;
}

/**
 * Who pays and who is reported (§8): the organization's account pays, the
 * user is reported. The default actor is the principal; a route on an
 * anonymous surface resolves its resource's owner here instead (share token
 * → deck → owner → the owner's workspace and account) — the viewer is never
 * identified.
 */
export interface ActorRef {
  /** The reported user, or null when the actor is a resource owner the tool could not name. */
  userId: string | null;
  workspaceId: string;
  /** The paying account (the workspace's central account id); absent = unmetered (oss, or a cloud-local workspace). */
  accountRef?: string | undefined;
}

export interface MeterDeclaration {
  /** The action key, namespaced by the tool's price book (`things.publish`). */
  key: string;
  /** The unit the price is per (`call`, `bytes`, `items`). */
  unit: string;
  /** The quantity of this request; default 1. Called before the handler (the check) and after it (the emit, with `audit` set). */
  quantity?: (ctx: EntitlementRequest) => number;
  /** The actor when it is not the principal (the owner of a resource reached anonymously). */
  actor?: (ctx: EntitlementRequest) => Promise<ActorRef | null> | ActorRef | null;
}

export interface LimitDeclaration {
  /** The limit key (`things.maxBytes`), declared with its per-tier values in the tool's `entitlements` slot. */
  key: string;
  /** The value this request observes, compared against the tier's value; over it is a plan refusal. */
  value: (ctx: EntitlementRequest) => number;
}

export interface RouteEntitlement {
  meter?: MeterDeclaration | undefined;
  limit?: LimitDeclaration | undefined;
  /** A feature key (`things.premium`), declared with its per-tier switch in the tool's `entitlements` slot. */
  feature?: string | undefined;
}

/** A route as the contract spells it: the OpenAPI method and the `{param}` path. */
export interface RouteRef {
  method: string;
  path: string;
}

export interface RouteEntitlementEntry extends RouteEntitlement {
  route: RouteRef;
}

/** `METHOD /path` — the registry key of a route. */
export function routeEntitlementKey(route: RouteRef): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export type RouteEntitlementDeclarations = ReadonlyMap<string, RouteEntitlementEntry>;

/**
 * Build the registry from the tool's route objects. One entry per route: a
 * second declaration of the same route throws at module load, so a typo or a
 * copy cannot silently double or replace a price.
 */
export function declareRouteEntitlements(
  entries: ReadonlyArray<RouteEntitlementEntry>
): RouteEntitlementDeclarations {
  const map = new Map<string, RouteEntitlementEntry>();
  for (const entry of entries) {
    const key = routeEntitlementKey(entry.route);
    if (map.has(key)) throw new Error(`route entitlement declared twice: ${key}`);
    if (!entry.meter && !entry.limit && !entry.feature) {
      throw new Error(`route entitlement declares nothing: ${key}`);
    }
    map.set(key, entry);
  }
  return map;
}

/** The declared body size of a request (its `Content-Length`), 0 when absent or malformed. */
export function declaredContentLength(ctx: EntitlementRequest): number {
  const n = Number(ctx.headers.get('content-length') ?? '0');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The stored size a handler recorded in its audit metadata (`sizeBytes`),
 * falling back to the declared body size before the handler ran. The check
 * sees the declared size, the emit sees the bytes that were actually kept.
 */
export function auditedSizeBytes(ctx: EntitlementRequest): number {
  const stored = ctx.audit?.metadata?.sizeBytes;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) return stored;
  return declaredContentLength(ctx);
}

// ── The tool's declared defaults, as `GET /instance` shows them ────────────

/**
 * A priced action: the default the hub seeds its price book from (§7); the
 * hub's rows win afterwards. `creditsPerUnit` credits buy `per` units of
 * `unit` (`per` defaults to 1): an action metered in bytes and priced per
 * mebibyte declares `{ creditsPerUnit: 5, unit: 'bytes', per: 1048576 }`,
 * so the meter stays exact, the price reads as the seed table says it, and
 * the two agree by construction (PRDCT-2627: the boot refuses a route whose
 * meter unit differs from its action's). The hub prices an event as
 * `creditsPerUnit × quantity / per`; rounding a fraction of a credit is the
 * hub's rule, not the tool's.
 */
export const entitlementActionSchema = z.object({
  key: z.string().min(1),
  creditsPerUnit: z.number().int().min(0),
  unit: z.string().min(1),
  /** How many units one `creditsPerUnit` buys; 1 when absent. */
  per: z.number().int().min(1).optional(),
  label: z.string().min(1)
});
export type EntitlementAction = z.infer<typeof entitlementActionSchema>;

/**
 * The credits an action declares for a quantity: `creditsPerUnit × quantity
 * / per`, exact (a fraction is the hub's to round). A test pins the seed
 * values with it, so a unit slip (5 per byte where 5 per MB was meant)
 * fails before the price book is seeded from discovery.
 */
export function declaredCredits(
  action: Pick<EntitlementAction, 'creditsPerUnit' | 'per'>,
  quantity: number
): number {
  return (action.creditsPerUnit * quantity) / (action.per ?? 1);
}

/** A limit's value per tier plus the oss value (the operator's own knob); null = unlimited. */
export const tierLimitSchema = z.object({
  oss: z.number().nullable(),
  free: z.number().nullable(),
  pro: z.number().nullable()
});
export type TierLimit = z.infer<typeof tierLimitSchema>;

/** A feature's switch per tier (oss has every feature: a self-hosted instance knows no plan). */
export const tierFeatureSchema = z.object({
  free: z.boolean(),
  pro: z.boolean()
});
export type TierFeature = z.infer<typeof tierFeatureSchema>;

export const toolEntitlementsSchema = z.object({
  actions: z.array(entitlementActionSchema),
  limits: z.record(z.string(), tierLimitSchema),
  features: z.record(z.string(), tierFeatureSchema)
});
export type ToolEntitlements = z.infer<typeof toolEntitlementsSchema>;

/**
 * The hub's answer to `GET /usage/entitlements?accountRef=` (§5): the hub's
 * `usageEntitlementsSchema` MIRRORED VERBATIM (PRDCT-2636). The account's
 * plan, resolved from the tier's defaults and the account's overrides; in
 * phase 1 `limits` and `features` are empty and the tool's own declared
 * values fill the numbers. A limit's value is a number or a boolean: the
 * hub may switch a numeric limit off or on per account (`true` = unlimited,
 * `false` = nothing allowed; `profiles.ts` resolves it so).
 */
export const entitlementProfileSchema = z.object({
  accountRef: z.uuid(),
  plan: entitlementTierSchema,
  /** Until when the plan is paid for (ISO 8601); null on `free` and on a live subscription. */
  planUntil: z.string().nullable(),
  limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
  features: z.array(z.string())
});
export type EntitlementProfile = z.infer<typeof entitlementProfileSchema>;

/** The wire code of a plan refusal, and its `details` (§7 step 2). */
export const PLAN_REQUIRED = 'plan_required';
export interface PlanRequiredDetails {
  key: string;
  plan: EntitlementTier;
  /** The first tier that allows the action, or null when none does. */
  requiredPlan: EntitlementTier | null;
  upgradeUrl: string;
}
