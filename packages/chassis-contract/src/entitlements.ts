import { z } from 'zod';
import { BILLING_PLANS, billingPlanSchema, type BillingPlan } from '@antasphere/contract';
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

// ── The hub's half: the messages the tool exchanges with the hub ──────────
//
// The hub owns these shapes and publishes them as `@antasphere/contract`
// (the hub's own contract package, on npm at the hub's version); this file
// re-exports them under the names the chassis has always used, so a tool
// reads exactly what the hub wrote and a change at the hub reaches every
// tool through one dependency bump (PRDCT-3325; before it, a hand copy checked
// against the hub's wire snapshot). The chassis's OWN half — the
// declaration layer below — stays here.
export {
  BILLING_PLANS,
  USAGE_CHECK_REASONS,
  USAGE_EVENT_MAX_FUTURE_MS,
  USAGE_EVENT_MAX_PAST_MS,
  USAGE_EVENTS_BATCH_MAX,
  USAGE_REJECT_REASONS,
  USAGE_ROUTE_ERRORS,
  USAGE_WRITE_SCOPE,
  usageCheckRequestSchema,
  usageCheckSchema,
  usageEventOccurrenceIssue,
  usageEventResultSchema,
  usageEventSchema,
  usageEventsBatchSchema,
  usageIngestResultSchema,
  usageRejectReasonSchema
} from '@antasphere/contract';
export type {
  UsageCheck,
  UsageCheckReason,
  UsageCheckRequest,
  UsageEventResult,
  UsageEventsBatch,
  UsageIngestResult,
  UsageRejectReason,
  UsageRouteError
} from '@antasphere/contract';

/**
 * The plan tiers, a CLOSED enum the hub owns (`BILLING_PLANS` in
 * `@antasphere/contract`), under the chassis's own names (§8b): `free` is the
 * default with no subscription; `pro` is the paid plan. "Enterprise" is not
 * a tier but a per-account override the hub serves.
 */
export const ENTITLEMENT_TIERS = BILLING_PLANS;
export type EntitlementTier = BillingPlan;
export const entitlementTierSchema = billingPlanSchema;

/** The wire code of a credit refusal (§7 step 4), and its `details`. */
export const ENTITLEMENT_DENIED = 'entitlement_denied';
export interface EntitlementDeniedDetails {
  /** The price of this action, in credits. */
  credits: number;
  /** The organization's balance, in credits. */
  balance: number;
  /** The hub's billing page for the organization: where a human adds credits. */
  topUpUrl: string;
}

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
  /**
   * The parsed JSON body of the request, read once and shared with the
   * handler's own validation (the server caches the parse); `undefined`
   * when the request carries none or it does not parse (the route's
   * validator then answers 400 itself). A count limit or a conditional
   * feature reads what the request asks for here (PRDCT-2702): the mint
   * of a share link with a password, the address an invitation names.
   */
  body: () => Promise<unknown>;
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

/**
 * The actor of a request when it is not the principal: the owner of a
 * resource reached anonymously (a form response through a share link), or
 * the workspace a public door opens (an invitation accepted, a collaborator
 * grant claimed). Resolves null to leave the route to its own handling.
 */
export type ActorHook = (ctx: EntitlementRequest) => Promise<ActorRef | null> | ActorRef | null;

export interface MeterDeclaration {
  /** The action key, namespaced by the tool's price book (`things.publish`). */
  key: string;
  /** The unit the price is per (`call`, `bytes`, `items`). */
  unit: string;
  /** The quantity of this request; default 1. Called before the handler (the check) and after it (the emit, with `audit` set). */
  quantity?: (ctx: EntitlementRequest) => number;
  /** The actor when it is not the principal (the owner of a resource reached anonymously). */
  actor?: ActorHook;
}

export interface LimitDeclaration {
  /** The limit key (`things.maxBytes`), declared with its per-tier values in the tool's `entitlements` slot. */
  key: string;
  /**
   * The value this request observes, compared against the tier's value; over
   * it is a plan refusal. A SIZE limit reads the declared length
   * (`declaredContentLength`, synchronous: the gate then also demands a
   * Content-Length on a metered account). A COUNT limit (PRDCT-2702) may be
   * asynchronous and read the body and the tool's own tables: it returns the
   * count AFTER this action (the resource's things plus this one), so
   * `observed > max` is the refusal, and `null` when there is nothing to
   * judge (the resource does not resolve, the caller may not see it): the
   * gate then lets the route answer on its own.
   */
  value: (ctx: EntitlementRequest) => number | null | Promise<number | null>;
}

/**
 * A feature a route needs, with an optional condition on the request
 * (PRDCT-2702): a route that creates a thing needs `things.premium` only
 * when the body asks for the premium option, so a declaration on the route
 * refuses the act and never the route. Absent `when`, the whole route needs
 * the feature.
 */
export interface FeatureDeclaration {
  key: string;
  when?: (ctx: EntitlementRequest) => boolean | Promise<boolean>;
}

export interface RouteEntitlement {
  meter?: MeterDeclaration | undefined;
  limit?: LimitDeclaration | undefined;
  /** A feature key (`things.premium`), declared with its per-tier switch in the tool's `entitlements` slot, or the key with a condition. */
  feature?: string | FeatureDeclaration | undefined;
  /**
   * The actor of a route that meters nothing but checks a limit or a feature
   * on a PUBLIC door (no principal): the workspace the door opens pays and is
   * judged. A meter's own `actor` serves the same purpose on a metered route;
   * this one covers the limit-only shape. Either makes the route a viewer's
   * surface: every refusal to it is one neutral sentence.
   */
  actor?: ActorHook | undefined;
}

/** The key of a route's feature declaration, whichever shape it uses; null when none. */
export function featureKeyOf(entry: RouteEntitlement): string | null {
  if (!entry.feature) return null;
  return typeof entry.feature === 'string' ? entry.feature : entry.feature.key;
}

/** The actor hook of a route, the entry's own or its meter's; null when the principal is the actor. */
export function actorHookOf(entry: RouteEntitlement): ActorHook | null {
  return entry.actor ?? entry.meter?.actor ?? null;
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
 * `usageEntitlementsSchema` (PRDCT-2636), the hub's own shape in
 * snapshot (PRDCT-2677). The account's
 * plan, resolved from the tier's defaults and the account's overrides; in
 * phase 1 `limits` and `features` are empty and the tool's own declared
 * values fill the numbers. A limit's value is a number or a boolean: the
 * hub may switch a numeric limit off or on per account (`true` = unlimited,
 * `false` = nothing allowed; `profiles.ts` resolves it so). Since phase 2
 * (PRDCT-2663) the hub serves its real rows — every limit key it holds for
 * the calling tool and the features on for the account — and `upgradeUrl`,
 * its upgrade page for the organization carrying `org`, `tool` and `plan`;
 * the chassis appends `&key=<key>&requiredPlan=<tier>` at refusal time.
 * Required: every hub since 0.11.0 sends it.
 */
export const entitlementProfileSchema = z.object({
  accountRef: z.uuid(),
  plan: entitlementTierSchema,
  /** Until when the plan is paid for (ISO 8601); null on `free` and on a live subscription. */
  planUntil: z.string().nullable(),
  limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
  features: z.array(z.string()),
  upgradeUrl: z.string()
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
