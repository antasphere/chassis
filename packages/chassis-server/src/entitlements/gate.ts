import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { ulid } from 'ulid';
import {
  ENTITLEMENT_TIERS,
  PLAN_REQUIRED,
  type ActorRef,
  type EntitlementRequest,
  type EntitlementService,
  type EntitlementTier,
  type MeterDeclaration,
  type PlanRequiredDetails,
  type Principal,
  type RouteEntitlementDeclarations,
  type RouteEntitlementEntry,
  type ToolEntitlements,
  type UsageEvent,
  type UsageSink
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import { pendingBodyRefusal } from '../middleware/body-refusal.js';
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
 *  cloud, a hub-projected workspace (an `accountRef`):
 *   1. the actor and the account (the principal's, or the route's `actor`);
 *   2. feature, then limit, against the account's profile (the hub's plan,
 *      cached 30 s, the tool's declared values for the tier): a refusal is
 *      403 `plan_required` + `details: { key, plan, requiredPlan, upgradeUrl }`;
 *   3. the credit check (`entitlements.check`, phase 1: the local env cap);
 *   4. after a 2xx, one usage event, enriched with the user, the `via` and
 *      the resource the handler recorded for its audit row. The event never
 *      names the tool: the hub takes the tool from the machine token, the
 *      only authority on its name (PRDCT-2629).
 *
 *  oss, and a cloud-LOCAL workspace (no account): no plan exists. The credit
 *  check runs first (today's refusal, byte for byte), then a declared limit
 *  is compared against its `oss` value (the operator's env knob; null =
 *  unlimited). No event is emitted: a self-hosted instance is unmetered by
 *  construction (§13).
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
 * a self-hosted instance answers byte for byte as before.
 */
/** The cloud edition's half of the gate: the plan source, the upgrade link, the hub-subject resolver. */
export interface EntitlementCloud {
  profiles: EntitlementProfiles;
  upgradeUrl: string;
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

/** `{id}` → `:id`: the OpenAPI path as Hono registers it. */
export function honoPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

/** Register the gate on every declared route, at the caller's place in the chain. */
export function registerEntitlementGate(api: OpenAPIHono, deps: EntitlementGateDeps): void {
  for (const entry of deps.declarations.values()) {
    api.on(entry.route.method.toUpperCase(), honoPath(entry.route.path), entitlementGate(entry, deps));
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

async function actorOf(
  entry: RouteEntitlementEntry,
  ctx: EntitlementRequest,
  principal: Principal
): Promise<ActorRef> {
  if (entry.meter?.actor) {
    const resolved = await entry.meter.actor(ctx);
    if (resolved) return resolved;
  }
  return principalActor(principal);
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
 * The plan checks (feature, then limit) of one request on the cloud edition.
 * Returns the refusal, or null when the plan allows the action.
 *
 * A limit is judged on what the request DECLARES before the handler (an
 * upload's Content-Length): a client that sends none is not held to the plan's
 * value here, only to the instance's hard caps (the body limits and the
 * services' mid-stream ceilings). Accepted for phase 1, where every plan
 * value equals the env cap; the day a tier value sits below the cap, the
 * handler's stored size must be judged too (verifier round 1, PRDCT-2626).
 */
function planCheck(
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
        { key, plan: profile.plan, requiredPlan, upgradeUrl: deps.cloud!.upgradeUrl }
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
        { key, plan: profile.plan, requiredPlan, upgradeUrl: deps.cloud!.upgradeUrl }
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

export function entitlementGate(entry: RouteEntitlementEntry, deps: EntitlementGateDeps): MiddlewareHandler {
  const meterKey = entry.meter ? routeKeyOf(entry) : null;
  return async (c, next) => {
    const principal = c.get('principal');
    const deferredRefusal = pendingBodyRefusal(c);
    // No principal: the route's own auth answers (401); nothing to meter. A
    // deferred size refusal still fires first, as the cap did before.
    if (!principal) return deferredRefusal ? deferredRefusal() : next();
    const ctx = requestOf(c, principal);
    const actor = await actorOf(entry, ctx, principal);
    const metered = Boolean(deps.cloud && actor.accountRef);

    if (metered) {
      const profile = await deps.cloud!.profiles.get(actor.accountRef!, deps.tool).catch((cause: unknown) => {
        deps.logger.warn({ err: cause }, 'entitlements: profile read threw — the free tier applies');
        return defaultProfile(deps.tool);
      });
      const refused = planCheck(c, entry, ctx, profile, deps);
      if (refused) return refused;
    }
    // The size cap's deferred refusal: the plan has had its say (or none
    // applies), the instance's hard ceiling answers now.
    if (deferredRefusal) return deferredRefusal();
    if (entry.meter) {
      const decision = await deps.entitlements.check(
        principal,
        { key: entry.meter.key, quantity: quantityOf(entry.meter, ctx), unit: entry.meter.unit },
        { route: meterKey }
      );
      if (!decision.allowed) {
        return c.json(err('entitlement_denied', decision.reason), 413);
      }
    }
    if (!metered) {
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
      via: principal.via,
      ...(audit?.resourceType ? { resourceType: audit.resourceType } : {}),
      ...(audit?.resourceId ? { resourceId: audit.resourceId } : {}),
      source: await deps.source()
    };
    // Fire and forget: the queue write is durable and the request never waits on billing.
    void deps.usage.emit(event);
  };
}

function routeKeyOf(entry: RouteEntitlementEntry): string {
  return `${entry.route.method.toUpperCase()} ${entry.route.path}`;
}
