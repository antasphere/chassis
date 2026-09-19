import type { Db } from '@antasphere/chassis-db';
import type {
  EntitlementService,
  IdentityProvider,
  InstanceAuthDescriptor,
  Principal,
  RequestContext,
  UsageSink
} from '@antasphere/chassis-contract';
import { HUB_SSO_PROVIDER_ID } from '../identity/hub-sso.js';
import { HubLiveGate } from '../identity/hub-live-gate.js';
import type { HubOrgReconciler } from '../identity/hub-reconcile.js';
import type { PrincipalGate } from '../middleware/auth-context.js';
import type { HubConfig } from '../env.js';
import type { Logger } from '../logger.js';

/**
 * The edition split (internal/federation.md): one codebase, one Docker image,
 * two seam bindings selected purely by instance config. This module is the
 * ONLY place edition decides which implementations the boot-time registry
 * gets — `oss` binds the local defaults byte-identically; `cloud` rebinds
 * the hub-federating variants here.
 */

/**
 * The hub SSO method name the cloud edition advertises in discovery — the
 * better-auth `genericOAuth` providerId registered by identity/hub-sso.ts
 * (its callback lands on /api/v1/auth/oauth2/callback/antasphere, the
 * redirect URI in the hub's TOOL_REGISTRY entry).
 */
export const HUB_SSO_METHOD = HUB_SSO_PROVIDER_ID;

/**
 * The cloud identity binding. Request RESOLUTION stays exactly the local
 * provider's — after the SSO callback mints an ordinary session, every
 * request is sessions + live membership re-check (the live hub gate runs
 * post-resolution in authContext, not here). What changes is the ADVERTISED
 * entrance (D1, hub-only human login):
 *
 *  - `antasphere` replaces password/email-otp/google — the login page
 *    renders ONLY "Sign in with Antasphere". The local password machinery
 *    stays WIRED (hidden, not blocked): the break-glass CLI remains the
 *    operator door, and blocking /sign-in/email would dead-end it.
 *  - `passwordReset`/`emailChange` are off: credentials and email are the
 *    HUB's to manage (D10 re-syncs email at every login); a local reset
 *    surface would fight the sync. Since the P8 close (ADR 017) the reset
 *    routes don't just report false — they REFUSE on cloud (403; the
 *    before-hook in identity/better-auth.ts + the members reset-link mint),
 *    so a hub-JIT user can never SET a local password and sidestep SSO.
 *  - `twoFactor` is off: the second factor guards local password/OTP
 *    sign-ins, which the cloud page no longer offers — MFA is the hub's
 *    concern at its own login.
 */
class HubSsoIdentityProvider implements IdentityProvider {
  constructor(private readonly local: IdentityProvider) {}

  resolve(ctx: RequestContext): Promise<Principal | null> {
    return this.local.resolve(ctx);
  }

  describe(): InstanceAuthDescriptor {
    return {
      // Machine entrances are edition-independent; the human entrance is
      // hub-only. 'oauth' stays: every instance is its own OAuth 2.1 AS for
      // /mcp — the hub never appears in the MCP dance.
      methods: [HUB_SSO_METHOD, 'api-key', 'oauth'],
      passwordReset: false,
      emailChange: false,
      twoFactor: false
    };
  }
}

/** The three registry seams the edition owns (events/workspaces are edition-independent). */
export interface EditionSeams {
  identity: IdentityProvider;
  entitlements: EntitlementService;
  usage: UsageSink;
}

/** What the cloud bindings need beyond the seams themselves. */
export interface EditionBindingDeps {
  db: Db;
  /**
   * The live org reconciler (identity/hub-reconcile.ts), constructed by
   * boot on cloud — the ONE hub data path, shared by the login pass, the
   * live gate, and the unknown-workspace miss hook.
   */
  reconciler?: HubOrgReconciler | undefined;
}

/**
 * The bound seams plus the cloud-only extra boot wires alongside them: the
 * post-resolution principal gate (authContext). Absent on oss by
 * construction.
 */
export interface BoundEditionSeams extends EditionSeams {
  principalGate?: PrincipalGate;
}

/**
 * Bind the registry seams for this instance's edition. `hub` is the single
 * switch: null (EDITION=oss) returns the local defaults UNTOUCHED — the
 * self-host edition carries zero hub surface at runtime; a HubConfig
 * (EDITION=cloud, validated at env parse) selects the cloud bindings.
 *
 * Entitlements bind LOCAL on BOTH editions: the live gate refuses a
 * suspended/revoked/unavailable principal at the door, before any handler
 * or entitlement check runs — a hub-wrapping entitlement layer would be a
 * second, redundant enforcement path.
 */
export function bindEditionSeams(
  hub: HubConfig | null,
  local: EditionSeams,
  logger: Logger,
  deps: EditionBindingDeps
): BoundEditionSeams {
  if (!hub) return local;

  logger.info(
    { hubIssuer: hub.issuerUrl },
    'EDITION=cloud: hub SSO is the human entrance (identity resolution stays local sessions); ' +
      'org/membership truth is reconciled live AS THE USER via each user’s own hub grant ' +
      '(internal/federation.md).'
  );
  const gate = deps.reconciler
    ? new HubLiveGate({ db: deps.db, reconciler: deps.reconciler, logger })
    : undefined;
  return {
    // Hub-only entrance advertised; the SSO machinery itself (relying
    // party, JIT, login reconcile) lives in identity/hub-sso.ts and is
    // wired through createAuth — resolution stays local by design.
    identity: new HubSsoIdentityProvider(local.identity),
    entitlements: local.entitlements,
    // D6: usage stays the local sink with a no-op downstream for v1; hub
    // ingest is a one-class downstream swap when it ships (plan §4.3).
    usage: local.usage,
    ...(gate ? { principalGate: gate.assert } : {})
  };
}
