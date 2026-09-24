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
 * The error codes the three tool routes of the hub (`POST /usage/events`,
 * `GET /usage/entitlements`, `POST /usage/check`) answer with, and the status
 * each rides on: the hub's `USAGE_ROUTE_ERRORS` (PRDCT-2677).
 * `tool_credential_required`: the caller is not a registry tool's machine
 * credential. `unknown_account`: no organization holds the `accountRef` (the
 * check and the entitlements read; the ingest answers it per event instead).
 * `validation_error`: the body or the query does not parse. The chassis maps
 * the check's two (`check.ts`): a 404 `unknown_account` and a 400 are the
 * hub's judgement, allowed and logged, never an outage.
 */
export const USAGE_ROUTE_ERRORS = {
  tool_credential_required: 401,
  unknown_account: 404,
  validation_error: 400
} as const;
export type UsageRouteError = keyof typeof USAGE_ROUTE_ERRORS;

/**
 * The wire shape of one usage event as the hub ingests it: the hub's
 * `usageEventSchema` (`packages/contract/src/schemas/billing.ts` of the hub,
 * PRDCT-2625), copied here and checked against the hub's wire snapshot
 * (`wire.ts`, `pnpm --filter @antasphere/chassis-contract wire:check`, the
 * `hub-wire` CI job; PRDCT-2677), so the fake hub of the test kit refuses
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

/** The batch cap of `POST /usage/events` (the hub's `USAGE_EVENTS_BATCH_MAX`): at most this many events per post. */
export const USAGE_EVENTS_BATCH_MAX = 500;

/**
 * The body of `POST /usage/events` as the hub parses it (its
 * `usageEventsBatchSchema`): one to `USAGE_EVENTS_BATCH_MAX` elements, each
 * judged on its own against `usageEventSchema` afterwards.
 */
export const usageEventsBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(USAGE_EVENTS_BATCH_MAX)
});
export type UsageEventsBatch = z.infer<typeof usageEventsBatchSchema>;

/**
 * Why the hub did not accept an event (its `USAGE_REJECT_REASONS`, a closed
 * list): `unknown_account`, `unknown_user`, `tool_mismatch`, and
 * `invalid_event` (the element does not parse, its `occurredAt` falls outside
 * the window, or its price exceeds `Number.MAX_SAFE_INTEGER`; `details` names
 * the field).
 */
export const USAGE_REJECT_REASONS = [
  'unknown_account',
  'unknown_user',
  'tool_mismatch',
  'invalid_event'
] as const;
export const usageRejectReasonSchema = z.enum(USAGE_REJECT_REASONS);
export type UsageRejectReason = z.infer<typeof usageRejectReasonSchema>;

/**
 * One element's answer. Since phase 2 an `accepted` result carries the
 * `credits` the hub debited for it (0 when the action has no price).
 */
export const usageEventResultSchema = z.object({
  id: z.string().nullable(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  reason: usageRejectReasonSchema.optional(),
  details: z.unknown().optional(),
  credits: z.number().int().optional()
});
export type UsageEventResult = z.infer<typeof usageEventResultSchema>;

/**
 * The hub's answer to `POST /usage/events`: one result per element, in the
 * batch's order, and the three counts (always sent).
 */
export const usageIngestResultSchema = z.object({
  results: z.array(usageEventResultSchema),
  accepted: z.number().int(),
  duplicate: z.number().int(),
  rejected: z.number().int()
});
export type UsageIngestResult = z.infer<typeof usageIngestResultSchema>;

// ── The hub's window on an event's date (PRDCT-2630 at the hub, PRDCT-2644 here) ──

/**
 * The window an event's `occurredAt` must fall in, measured against the
 * moment the hub receives it: the hub's `USAGE_EVENT_MAX_PAST_MS` and
 * `USAGE_EVENT_MAX_FUTURE_MS` (`packages/contract/src/schemas/billing.ts`
 * of the hub), same names and values, checked against the hub's wire
 * snapshot (`wire.ts`, `wire:check`, the `hub-wire` CI job; PRDCT-2677). Backward, seven days:
 * the queue's retry budget is about eight and a half hours, so an outage of
 * a night is covered many times over, and a week also covers an operator
 * re-driving held jobs by hand. Forward, five minutes: the skew every JWT
 * verifier already tolerates; anything further is a clock that is wrong.
 * Outside the window the hub answers `rejected(invalid_event)` naming
 * `occurredAt` and never clamps, so the poster refuses BEFORE posting: an
 * event the hub would refuse on its date is held where it was made, never
 * counted as a rejection at the hub (PRDCT-2644).
 */
export const USAGE_EVENT_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
export const USAGE_EVENT_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Why an event's `occurredAt` is refused against the receipt time, or null
 * when it falls inside the window (both bounds INCLUSIVE). The hub's
 * `usageEventOccurrenceIssue`, copied (the wire snapshot's occurrence table
 * checks it on the hub's offsets): the one comparison both
 * halves run, the hub at ingest against its own clock, the chassis before
 * posting against its best estimate of the receipt (its own clock), so the
 * two never disagree on the sign or the edge.
 */
export function usageEventOccurrenceIssue(
  occurredAt: Date,
  receivedAt: Date
): { path: 'occurredAt'; message: string } | null {
  const delta = occurredAt.getTime() - receivedAt.getTime();
  if (delta < -USAGE_EVENT_MAX_PAST_MS) {
    return {
      path: 'occurredAt',
      message: `more than ${USAGE_EVENT_MAX_PAST_MS / 86_400_000} days before the hub received the event`
    };
  }
  if (delta > USAGE_EVENT_MAX_FUTURE_MS) {
    return {
      path: 'occurredAt',
      message: `more than ${USAGE_EVENT_MAX_FUTURE_MS / 60_000} minutes after the hub received the event`
    };
  }
  return null;
}

// ── POST /usage/check: the price and the balance before an action (§5, §7 step 3) ──

/**
 * The request of `POST /usage/check` (the hub's `UsageCheckRequest`,
 * PRDCT-2663): the paying account, the action key and the quantity of THIS
 * request. `unit` is accepted and ignored by the hub, which prices by its
 * own row; it is sent so the answer's unit can be compared and a mismatch
 * logged.
 */
export const usageCheckRequestSchema = z.object({
  accountRef: z.uuid(),
  actionKey: z.string().min(1).max(120),
  quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unit: z.string().min(1).max(40).optional()
});
export type UsageCheckRequest = z.infer<typeof usageCheckRequestSchema>;

/**
 * The three reasons a check refuses (`null` when allowed), the hub's
 * `USAGE_CHECK_REASONS`: `account_suspended` (checked first, whatever the
 * price), `unpriceable` (the price of this quantity exceeds
 * `Number.MAX_SAFE_INTEGER`: the hub clamps `credits` to that bound, and the
 * ingest would reject the same event on its `quantity`) and
 * `insufficient_credits` (`balance < credits`). Each is a refusal, never an
 * outage (PRDCT-2677).
 */
export const USAGE_CHECK_REASONS = ['insufficient_credits', 'account_suspended', 'unpriceable'] as const;
export type UsageCheckReason = (typeof USAGE_CHECK_REASONS)[number];

/**
 * The hub's answer to `POST /usage/check` (its `UsageCheck`, PRDCT-2663),
 * checked against the hub's wire snapshot (PRDCT-2677): advisory, no side effect. `credits` is the price of
 * this quantity from the price book row effective now (0 and `priced:
 * false` when the tool has no row for the action: views are never priced,
 * an unknown key is not a refusal); `balance` the account's; `allowed` is
 * `balance >= credits` unless the organization is suspended, which refuses
 * whatever the price. `topUpUrl` is always present: the hub's billing page
 * for that organization, what a `402 entitlement_denied` carries straight
 * off the answer. No lower bound on `quantity` or `credits`, as at the hub: a
 * copy stricter than the hub reads a valid answer as an outage.
 */
export const usageCheckSchema = z.object({
  accountRef: z.uuid(),
  actionKey: z.string(),
  quantity: z.number().int(),
  allowed: z.boolean(),
  credits: z.number().int(),
  balance: z.number().int(),
  unit: z.string().nullable(),
  priced: z.boolean(),
  plan: entitlementTierSchema,
  reason: z.enum(USAGE_CHECK_REASONS).nullable(),
  topUpUrl: z.string()
});
export type UsageCheck = z.infer<typeof usageCheckSchema>;

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
   * count AFTER this action (the links of the deck plus this one), so
   * `observed > max` is the refusal, and `null` when there is nothing to
   * judge (the resource does not resolve, the caller may not see it): the
   * gate then lets the route answer on its own.
   */
  value: (ctx: EntitlementRequest) => number | null | Promise<number | null>;
}

/**
 * A feature a route needs, with an optional condition on the request
 * (PRDCT-2702): the mint of a share link needs `deck.password` only when the
 * body sets one, so a declaration on the route refuses the act and never
 * the route. Absent `when`, the whole route needs the feature.
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
 * `usageEntitlementsSchema` (PRDCT-2636), checked against the hub's wire
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
