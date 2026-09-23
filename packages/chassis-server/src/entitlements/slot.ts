import {
  declareRouteEntitlements,
  ENTITLEMENT_TIERS,
  toolEntitlementsSchema,
  type RouteEntitlementDeclarations,
  type ToolEntitlements
} from '@antasphere/chassis-contract';

/**
 * What the tool's `entitlements` slot returns (the billing rail spec, §7 and
 * §8b): the three lists `GET /instance` shows (the priced actions with their
 * default credits, the limits and the features per tier) plus the route
 * declarations the gate enforces. A function of the environment, so an oss
 * value can be the operator's env cap.
 */
export interface ToolEntitlementDeclaration extends ToolEntitlements {
  routes: RouteEntitlementDeclarations;
}

/** A tool that declares nothing: no route is gated, discovery shows empty lists. */
export const EMPTY_TOOL_ENTITLEMENTS: ToolEntitlementDeclaration = {
  actions: [],
  limits: {},
  features: {},
  routes: declareRouteEntitlements([])
};

/**
 * The boot-time guard of the slot: every key a route declares must be
 * declared with its values, and a metered route's unit must be the action's.
 * A route that meters an action the price book does not know, or a limit no
 * tier has a value for, is a declaration that could never be enforced or
 * priced — it stops the boot, naming the route.
 *
 * Two checks run on the three lists themselves. First, they are parsed
 * through the contract's `toolEntitlementsSchema`: a limit key missing a
 * tier would otherwise resolve as unlimited in `profiles.ts` while
 * `requiredPlanFor` reports no plan for it, so a malformed declaration stops
 * the boot naming the first issue's path. Second, the ceiling: a limit whose
 * `oss` value is a number is the operator's own ceiling, the instance's hard
 * cap, and no tier may advertise more (nor `null`, unlimited) under it.
 * Discovery once advertised a paid tier the handlers' mid-stream cap could
 * never serve (PRDCT-2653); the boot now refuses the advertisement. A limit
 * whose `oss` is `null` has no ceiling.
 */
export function assertToolEntitlements(decl: ToolEntitlementDeclaration): void {
  const parsed = toolEntitlementsSchema.safeParse({
    actions: decl.actions,
    limits: decl.limits,
    features: decl.features
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.map((p) => String(p)).join('.') : '';
    throw new Error(
      `tool definition: entitlements declaration is malformed: ${path}: ${issue?.message ?? 'invalid'}`
    );
  }
  for (const [key, limit] of Object.entries(decl.limits)) {
    const ceiling = limit.oss;
    if (typeof ceiling !== 'number') continue;
    for (const tier of ENTITLEMENT_TIERS) {
      const value = limit[tier];
      if (typeof value !== 'number' || value > ceiling) {
        throw new Error(
          `tool definition: entitlements.limits.${key}.${tier} (${String(value)}) is above the instance ceiling (oss ${ceiling}): a plan value the instance cannot serve must not be advertised`
        );
      }
    }
  }
  const actions = new Map(decl.actions.map((a) => [a.key, a]));
  const seenActions = new Set<string>();
  for (const a of decl.actions) {
    if (seenActions.has(a.key))
      throw new Error(`tool definition: entitlements.actions declares ${a.key} twice`);
    seenActions.add(a.key);
  }
  for (const [key, entry] of decl.routes) {
    if (entry.meter) {
      const action = actions.get(entry.meter.key);
      if (!action) {
        throw new Error(
          `tool definition: route ${key} meters "${entry.meter.key}", which entitlements.actions does not declare`
        );
      }
      if (action.unit !== entry.meter.unit) {
        throw new Error(
          `tool definition: route ${key} meters "${entry.meter.key}" in ${entry.meter.unit}, the action is priced per ${action.unit}`
        );
      }
    }
    if (entry.limit && !(entry.limit.key in decl.limits)) {
      throw new Error(
        `tool definition: route ${key} checks the limit "${entry.limit.key}", which entitlements.limits does not declare`
      );
    }
    if (entry.feature && !(entry.feature in decl.features)) {
      throw new Error(
        `tool definition: route ${key} needs the feature "${entry.feature}", which entitlements.features does not declare`
      );
    }
  }
}
