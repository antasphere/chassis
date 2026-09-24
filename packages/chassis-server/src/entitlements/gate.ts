import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { ulid } from 'ulid';
import {
  declaredContentLength,
  ENTITLEMENT_DENIED,
  ENTITLEMENT_TIERS,
  PLAN_REQUIRED,
  type ActorRef,
  type EntitlementDeniedDetails,
  type EntitlementRequest,
  type EntitlementService,
  type EntitlementTier,
  type MeterDeclaration,
  type PlanRequiredDetails,
  type Principal,
  routeEntitlementKey,
  type RouteEntitlementDeclarations,
  type RouteEntitlementEntry,
  type ToolEntitlements,
  type UsageEvent,
  type UsageSink
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import { pendingBodyRefusal } from '../middleware/body-refusal.js';
import type { CreditCheck } from './check.js';
import { defaultProfile, type EntitlementProfiles, type ResolvedProfile } from './profiles.js';

/**
 * The ONE middleware of the billing rail (the spec, §7): installed after the
 * scope gate and before the handler, for every route that declares a meter,
 * a limit or a feature. The dashboard, the CLI and the MCP tools are all
 * clients of `/api/v1`, so this is the one place and the three surfaces need
 * nothing.
 *
 * Per request, once the principal is known:
 *
 *  cloud, a hub-projected workspace (an `accountRef`), the METERED path:
 *   1. the actor and the account (the principal's, or the route's `actor`);
 *   2. feature, then limit, against the account's profile (the hub's plan,
 *      cached 30 s, the tool's declared values for the tier): a refusal is
 *      403 `plan_required` + `details: { key, plan, requiredPlan, upgradeUrl }`,
 *      the link being the hub's upgrade page for the organization with
 *      `key` and `requiredPlan` appended (the hub root on an older hub);
 *   3. the deferred body refusal (below);
 *   4. a route that declares a limit refuses a POST, PUT or PATCH that does
 *      not declare its size: 411 `length_required` (PRDCT-2652, below);
 *   5. the credit check at the hub (`cloud.credits`, `POST /usage/check`,
 *      the price of THIS quantity against the organization's balance):
 *      402 `entitlement_denied` + `details: { credits, balance, topUpUrl }`
 *      when the balance is short, 413 `entitlement_denied` with the price
 *      and the balance but no top-up link for a quantity the hub cannot
 *      price (`unpriceable`: past `Number.MAX_SAFE_INTEGER` credits, beside
 *      the instance-limit 413; PRDCT-2677), 403 `account_suspended` for a suspended
 *      organization, 403 `hub_unavailable` once an outage has outlasted the
 *      fail-open window (the live gate's own codes and wording). The LOCAL
 *      `entitlements.check` is NOT asked here: the plan limit is the cap of
 *      a metered account (PRDCT-2653: the local service compared every
 *      upload against the instance cap, so a pro account above the free
 *      value met 413 with the oss message);
 *   6. after a 2xx, one usage event, enriched with the user, the `via` and
 *      the resource the handler recorded for its audit row. The event never
 *      names the tool: the hub takes the tool from the machine token, the
 *      only authority on its name (PRDCT-2629). The hub debits at ingest.
 *
 *  oss, and a cloud-LOCAL workspace (no account): no plan exists. The local
 *  credit check runs first (today's refusal, byte for byte), then a declared
 *  limit is compared against its `oss` value (the operator's env knob; null
 *  = unlimited). No 411, no hub call, no event: a self-hosted instance is
 *  unmetered by construction (§13).
 *
 * Why 411 on a metered upload with no Content-Length (PRDCT-2652): a limit
 * is judged on the size the request DECLARES before the handler, so a body
 * with no declared size read as 0 bytes and passed the plan limit whatever
 * its size. Refusing before anything is stored is chosen over storing and
 * rolling back: a stored blob is content-addressed and may already be
 * referenced by another deck. Every first-party client declares it (Node's
 * fetch and the browser do for a buffer, a blob or a form; the in-process
 * MCP calls encode the form first).
 *
 * The idempotency middleware sits before this one, so a replayed request is
 * never metered twice; the audit middleware wraps it, so what the handler
 * records for its audit row is what the emit reads.
 *
 * A body-size refusal the size cap deferred (`bodyRefusal`, PRDCT-2632: a
 * declared Content-Length over the tool's cap on a route that declares a
 * limit) fires HERE: after the plan check on a metered account, so the plan
 * refusal with its upgrade link is what an oversize upload meets and the
 * instance cap answers only when the plan allows the size; before anything
 * else when no plan applies (no principal, oss, a cloud-local workspace), so
 * a resolved request no plan applies to answers byte for byte as before.
 * What changed for such a request: the credential resolves and the scope
 * gate answers before the cap does (a key without the scope meets 403
 * insufficient_scope where the cap's 413 came first), and the refusal
 * costs a lookup and a quota token (verifier round 1, accepted).
 */
/** The cloud edition's half of the gate: the plan source, the upgrade link, the credit check, the hub-subject resolver. */
export interface EntitlementCloud {
  profiles: EntitlementProfiles;
  /** The fallback upgrade link (the hub root), when the profile carries no upgrade page of the hub's. */
  upgradeUrl: string;
  /** The hub's credit check (`POST /usage/check`), cached per account per action. */
  credits: CreditCheck;
  hubSubject: (userId: string) => Promise<string | null>;
}

export interface EntitlementGateDeps {
  declarations: RouteEntitlementDeclarations;
  tool: ToolEntitlements;
  entitlements: EntitlementService;
  usage: UsageSink;
  /**
   * The cloud edition's plan source, upgrade link and hub-subject resolver;
   * undefined on oss. `hubSubject` maps the tool's local user id to the hub
   * user (the SSO `sub` on the account row), which is what the event reports
   * (the hub's `usageEventSchema`); a user with no hub link reports null.
   */
  cloud: EntitlementCloud | undefined;
  /** The `source` of every event (the instance id is read lazily, cached by the caller). */
  source: () => Promise<UsageEvent['source']>;
  logger: Logger;
}

const err = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details !== undefined ? { details } : {}) }
});

/**
 * The wire code of a metered upload that does not declare its size
 * (PRDCT-2652). A literal here, not a contract export: only this gate
 * answers it.
 */
const LENGTH_REQUIRED = 'length_required';

/**
 * The live gate's wording for the two hub postures (`identity/hub-live-gate.ts`),
 * reused verbatim so a person meets the same sentence whichever gate refused.
 */
const SUSPENDED_MESSAGE = 'This organization is suspended on Antasphere';
const UNAVAILABLE_MESSAGE =
  'The Antasphere hub has been unreachable for too long; requests are refused until it recovers';
/** What a viewer on an anonymous surface reads when the owner's account cannot pay (PRDCT-2634): no figure, no link. */
const ANONYMOUS_DENIED_MESSAGE = 'The owner of this content cannot take this action right now';

/** The methods that carry a body the limit judges. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Whether the request declares its body size (a Content-Length of digits, `0` included). */
function declaresLength(ctx: EntitlementRequest): boolean {
  const raw = ctx.headers.get('content-length');
  return raw !== null && /^\s*\d+\s*$/.test(raw);
}

/** `{id}` → `:id`: the OpenAPI path as Hono registers it. */
export function honoPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

/**
 * The gate handlers of the routes that declare a PLAN LIMIT: the size cap
 * (api/create-api.ts) defers a declared-oversize refusal exactly when one of
 * these is on the request's matched route, so the deferral is keyed on the
 * gate itself, never on a re-reading of the path (PRDCT-2632).
 */
const deferringGates = new WeakSet<MiddlewareHandler>();

/**
 * Whether a matched handler is a gate that judges a plan limit before the
 * size cap may refuse. Hono's `route()` wraps a sub-app's handlers when that
 * sub-app has its own `onError` (`COMPOSED_HANDLER` points at the original),
 * so the wrapper is unwrapped first: otherwise an `api.onError` added one day
 * would switch every deferral off (verifier round 2).
 */
export function isDeferringGate(handler: unknown): boolean {
  const target = (handler as { [COMPOSED_HANDLER]?: unknown } | null)?.[COMPOSED_HANDLER] ?? handler;
  return typeof target === 'function' && deferringGates.has(target as MiddlewareHandler);
}

/** Register the gate on every declared route, at the caller's place in the chain. */
export function registerEntitlementGate(api: OpenAPIHono, deps: EntitlementGateDeps): void {
  for (const entry of deps.declarations.values()) {
    const gate = entitlementGate(entry, deps);
    if (entry.limit) deferringGates.add(gate);
    api.on(entry.route.method.toUpperCase(), honoPath(entry.route.path), gate);
  }
}

function requestOf(c: Context, principal: Principal | null): EntitlementRequest {
  return {
    method: c.req.method,
    path: c.req.path,
    headers: c.req.raw.headers,
    params: c.req.param() as Record<string, string>,
    principal
  };
}

function quantityOf(meter: MeterDeclaration, ctx: EntitlementRequest): number {
  if (!meter.quantity) return 1;
  const q = meter.quantity(ctx);
  return Number.isFinite(q) && q >= 0 ? q : 0;
}

function principalActor(principal: Principal): ActorRef {
  return {
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    ...(principal.accountRef ? { accountRef: principal.accountRef } : {})
  };
}

/**
 * The paying actor of one request. A route that declares an `actor` hook is
 * a SURFACE ATTRIBUTED TO A RESOURCE'S OWNER (a form response through a share
 * link, PRDCT-2634): the hook, and only the hook, names who pays, whether or
 * not a principal happens to be signed in (a person of any workspace may hold
 * a share link; they are a viewer here, never the payer). A hook that resolves
 * nothing, or throws, leaves the route to its own handling with nothing
 * metered, rather than refusing on a lookup error or billing the viewer. A
 * route without a hook meters its principal, or nothing without one.
 */
async function actorOf(
  entry: RouteEntitlementEntry,
  ctx: EntitlementRequest,
  principal: Principal | null
): Promise<ActorRef | null> {
  if (entry.meter?.actor) {
    try {
      return (await entry.meter.actor(ctx)) ?? null;
    } catch {
      return null;
    }
  }
  return principal ? principalActor(principal) : null;
}

/** Whether the request is a viewer's on an owner-attributed surface: the route declares an actor hook. */
function viewerSurface(entry: RouteEntitlementEntry): boolean {
  return Boolean(entry.meter?.actor);
}

/** The first tier above the account's that allows the value, or null when none does. */
function requiredPlanFor(
  tool: ToolEntitlements,
  plan: EntitlementTier,
  judge: (tier: EntitlementTier) => boolean
): EntitlementTier | null {
  const from = ENTITLEMENT_TIERS.indexOf(plan) + 1;
  for (const tier of ENTITLEMENT_TIERS.slice(from)) {
    if (judge(tier)) return tier;
  }
  return null;
}

function planRefusal(c: Context, message: string, details: PlanRequiredDetails): Response {
  return c.json(err(PLAN_REQUIRED, message, details), 403);
}

/**
 * The upgrade link of a plan refusal: the hub's upgrade page for the
 * organization (it carries `org`, `tool` and `plan`) with the refused `key`
 * and the `requiredPlan` appended; the hub root when the profile has no page
 * of the hub's (an older hub, or the default plan).
 */
function upgradeLink(
  profile: ResolvedProfile,
  key: string,
  requiredPlan: EntitlementTier | null,
  fallback: string
): string {
  if (!profile.upgradeUrl) return fallback;
  let url: URL;
  try {
    url = new URL(profile.upgradeUrl);
  } catch {
    return fallback;
  }
  url.searchParams.set('key', key);
  if (requiredPlan !== null) url.searchParams.set('requiredPlan', requiredPlan);
  return url.toString();
}

/**
 * The plan checks (feature, then limit) of one request on the cloud edition.
 * Returns the refusal, or null when the plan allows the action.
 *
 * A limit is judged on what the request DECLARES before the handler (an
 * upload's Content-Length). A metered request that declares none is refused
 * 411 by the gate right after (PRDCT-2652), so a size can no longer pass the
 * plan's value by staying silent; the instance's hard caps (the body limits
 * and the services' mid-stream ceilings) still bound a body that lies.
 */
function planCheck(
  c: Context,
  entry: RouteEntitlementEntry,
  ctx: EntitlementRequest,
  profile: ResolvedProfile,
  deps: EntitlementGateDeps,
  /** No principal: a viewer, who must learn nothing of the owner's plan or upgrade page. */
  anonymous = false
): Response | null {
  const refusal = planCheckDetailed(c, entry, ctx, profile, deps);
  if (refusal && anonymous) return c.json(err(PLAN_REQUIRED, ANONYMOUS_DENIED_MESSAGE), 403);
  return refusal;
}

function planCheckDetailed(
  c: Context,
  entry: RouteEntitlementEntry,
  ctx: EntitlementRequest,
  profile: ResolvedProfile,
  deps: EntitlementGateDeps
): Response | null {
  if (entry.feature) {
    const key = entry.feature;
    if (!profile.features.has(key)) {
      const requiredPlan = requiredPlanFor(
        deps.tool,
        profile.plan,
        (tier) => deps.tool.features[key]?.[tier] === true
      );
      return planRefusal(
        c,
        requiredPlan
          ? `This needs the ${requiredPlan} plan (${key} is not part of the ${profile.plan} plan)`
          : `${key} is not available on any plan`,
        {
          key,
          plan: profile.plan,
          requiredPlan,
          upgradeUrl: upgradeLink(profile, key, requiredPlan, deps.cloud!.upgradeUrl)
        }
      );
    }
  }
  if (entry.limit) {
    const { key } = entry.limit;
    const max = profile.limits[key];
    const observed = entry.limit.value(ctx);
    if (max !== null && max !== undefined && Number.isFinite(observed) && observed > max) {
      const requiredPlan = requiredPlanFor(deps.tool, profile.plan, (tier) => {
        const value = deps.tool.limits[key]?.[tier];
        return value === null || (typeof value === 'number' && observed <= value);
      });
      return planRefusal(
        c,
        requiredPlan
          ? `${key} is limited to ${max} on the ${profile.plan} plan; the ${requiredPlan} plan allows it`
          : `${key} is limited to ${max} on the ${profile.plan} plan`,
        {
          key,
          plan: profile.plan,
          requiredPlan,
          upgradeUrl: upgradeLink(profile, key, requiredPlan, deps.cloud!.upgradeUrl)
        }
      );
    }
  }
  return null;
}

/** The oss half of a limit: the operator's own knob, refused the way the credit check refuses. */
function ossLimitCheck(
  c: Context,
  entry: RouteEntitlementEntry,
  ctx: EntitlementRequest,
  tool: ToolEntitlements
): Response | null {
  if (!entry.limit) return null;
  const { key } = entry.limit;
  const max = tool.limits[key]?.oss;
  const observed = entry.limit.value(ctx);
  if (max !== null && max !== undefined && Number.isFinite(observed) && observed > max) {
    return c.json(err('entitlement_denied', `${key}: ${observed} exceeds the instance limit (${max})`), 413);
  }
  return null;
}

/** The hub's credit check of a metered request; the refusal, or null when the action may run. */
async function creditRefusal(
  c: Context,
  meter: MeterDeclaration,
  ctx: EntitlementRequest,
  actor: ActorRef,
  cloud: EntitlementCloud,
  /** No principal: a viewer on an anonymous surface, who must learn nothing about the owner's account. */
  anonymous: boolean
): Promise<Response | null> {
  const verdict = await cloud.credits.check({
    accountRef: actor.accountRef!,
    actionKey: meter.key,
    quantity: quantityOf(meter, ctx),
    unit: meter.unit
  });
  if (verdict.allowed) return null;
  if (anonymous) {
    // The owner's balance, price, top-up page, and even whether the
    // organization is suspended or the hub is down, are the owner's: a
    // viewer gets one code and one neutral sentence, whatever the reason
    // (PRDCT-2634; verifier round 3 on the suspended and unavailable answers).
    return c.json(err(ENTITLEMENT_DENIED, ANONYMOUS_DENIED_MESSAGE), 402);
  }
  if (verdict.reason === 'account_suspended') return c.json(err('account_suspended', SUSPENDED_MESSAGE), 403);
  if (verdict.reason === 'hub_unavailable') return c.json(err('hub_unavailable', UNAVAILABLE_MESSAGE), 403);
  const details: EntitlementDeniedDetails = {
    credits: verdict.check?.credits ?? 0,
    balance: verdict.check?.balance ?? 0,
    topUpUrl: verdict.check?.topUpUrl ?? cloud.upgradeUrl
  };
  // A price past `Number.MAX_SAFE_INTEGER` (the hub clamps `credits` to it):
  // a refusal of the quantity, never an outage (PRDCT-2677). The
  // instance-limit 413's code, with the price and the balance and NO top-up
  // link: no top-up covers it, and the dashboard's and the CLI's readers
  // present a top-up card on any `entitlement_denied` whose details carry
  // `topUpUrl` (verifier round 1).
  if (verdict.reason === 'unpriceable') {
    const figures: Pick<EntitlementDeniedDetails, 'credits' | 'balance'> = {
      credits: details.credits,
      balance: details.balance
    };
    return c.json(
      err(
        ENTITLEMENT_DENIED,
        `This quantity cannot be priced (${figures.credits} credits or more, the organization holds ${figures.balance}); nothing was charged`,
        figures
      ),
      413
    );
  }
  return c.json(
    err(
      ENTITLEMENT_DENIED,
      `This needs ${details.credits} credits and the organization holds ${details.balance}; top up at ${details.topUpUrl}`,
      details
    ),
    402
  );
}

export function entitlementGate(entry: RouteEntitlementEntry, deps: EntitlementGateDeps): MiddlewareHandler {
  const meterKey = entry.meter ? routeEntitlementKey(entry.route) : null;
  return async (c, next) => {
    const principal: Principal | null = c.get('principal') ?? null;
    const deferredRefusal = pendingBodyRefusal(c);
    const ctx = requestOf(c, principal);
    // The actor: the principal, or, on an ANONYMOUS surface (a form response
    // through a share link, PRDCT-2634), whoever the route's `actor` hook
    // resolves with no principal at all (the share secret → the deck → its
    // owner → the owner's workspace and account: the owner pays and is
    // reported, the viewer is never identified, §8). No principal and no
    // actor: the route's own auth answers (401/404); nothing to meter, and a
    // deferred size refusal still fires first, as the cap did before.
    // A viewer's request (an owner-attributed surface, with or without a
    // signed-in person) learns nothing of the owner's account: every refusal
    // to it is one neutral sentence (verifier round 3, the code review: a
    // signed-in holder of a share link is a viewer too). On oss the hook is
    // not run: no account can exist, the lookups would cost the database.
    const viewer = viewerSurface(entry);
    const actor = viewer && !deps.cloud ? null : await actorOf(entry, ctx, principal);
    if (!actor) return deferredRefusal ? deferredRefusal() : next();
    const metered = Boolean(deps.cloud && actor.accountRef);
    // A viewer's surface whose owner has no account (a cloud-local
    // workspace) has no plan and no credits: byte for byte as it was.
    if (viewer && !metered) return deferredRefusal ? deferredRefusal() : next();

    // The plan is read only when the route declares a feature or a limit: a
    // meter-only route has nothing to judge against it (verifier round 3).
    if (metered && (entry.feature || entry.limit)) {
      const profile = await deps.cloud!.profiles.get(actor.accountRef!, deps.tool).catch((cause: unknown) => {
        deps.logger.warn({ err: cause }, 'entitlements: profile read threw — the free tier applies');
        return defaultProfile(deps.tool);
      });
      const refused = planCheck(c, entry, ctx, profile, deps, viewer);
      if (refused) return refused;
    }
    // The size cap's deferred refusal: the plan has had its say (or none
    // applies), the instance's hard ceiling answers now.
    if (deferredRefusal) return deferredRefusal();
    if (metered) {
      // A body with no declared size would pass the plan limit as 0 bytes
      // (PRDCT-2652): refused before anything is stored.
      // A route metered in BYTES needs the size too: with no header the check
      // would price 0 bytes and the emit the stored size, so an anonymous
      // upload door could take an owner's balance below zero (verifier round 3).
      // A limit JUDGES the body when its value is the declared length (the
      // contract's own reader), not any limit (a count limit on a JSON route
      // must not refuse a chunked body: the code review).
      const judgesSize = entry.limit?.value === declaredContentLength || entry.meter?.unit === 'bytes';
      if (judgesSize && BODY_METHODS.has(c.req.method.toUpperCase()) && !declaresLength(ctx)) {
        return c.json(err(LENGTH_REQUIRED, 'A metered upload must declare its size (Content-Length)'), 411);
      }
      if (entry.meter) {
        const refused = await creditRefusal(c, entry.meter, ctx, actor, deps.cloud!, viewer);
        if (refused) return refused;
      }
    } else {
      if (entry.meter) {
        // A principal is certain here: a viewer's surface returned above, and a
        // route without a hook resolved no actor without a principal.
        const decision = await deps.entitlements.check(
          principal!,
          { key: entry.meter.key, quantity: quantityOf(entry.meter, ctx), unit: entry.meter.unit },
          { route: meterKey }
        );
        if (!decision.allowed) {
          return c.json(err('entitlement_denied', decision.reason), 413);
        }
      }
      const refused = ossLimitCheck(c, entry, ctx, deps.tool);
      if (refused) return refused;
    }

    await next();

    if (!metered || !entry.meter || c.res.status < 200 || c.res.status >= 300) return;
    const after: EntitlementRequest = { ...ctx, audit: c.get('audit') };
    const audit = after.audit;
    const hubUser = actor.userId ? await deps.cloud!.hubSubject(actor.userId).catch(() => null) : null;
    const event: UsageEvent = {
      id: ulid(),
      meter: entry.meter.key,
      actionKey: entry.meter.key,
      quantity: quantityOf(entry.meter, after),
      unit: entry.meter.unit,
      occurredAt: new Date().toISOString(),
      workspaceId: actor.workspaceId,
      accountRef: actor.accountRef!,
      userId: hubUser,
      // The hub's channel enum has no value for a share link: an anonymous
      // surface reports the owner as if from a browser session (PRDCT-2634;
      // a dedicated value is the hub's contract to add).
      via: viewer ? 'session' : principal!.via,
      ...(audit?.resourceType ? { resourceType: audit.resourceType } : {}),
      ...(audit?.resourceId ? { resourceId: audit.resourceId } : {}),
      source: await deps.source()
    };
    // Fire and forget: the queue write is durable and the request never waits on billing.
    void deps.usage.emit(event);
  };
}
