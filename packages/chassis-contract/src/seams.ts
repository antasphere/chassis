/**
 * The central-rail seam: three small interfaces wired through the boot-time
 * module registry. The central account/credits service is NOT part of the
 * template — these interfaces are the socket it plugs into later with zero
 * refactor. Template defaults: LocalIdentityProvider, AllowAllEntitlements,
 * a no-op UsageSink.
 */

/** Structural Headers so the contract stays lib-agnostic (works in DOM and Node). */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface RequestContext {
  /** Raw request headers (credential material lives here). */
  headers: HeaderReader;
  path: string;
  method: string;
  requestId: string;
}

/**
 * The universal per-request workspace selector (user-scoped credential
 * model). EVERY credential kind — session, API key, OAuth bearer — MAY send
 * it to name which of the caller's workspaces this request targets; the
 * resolvers verify an ACTIVE membership of that workspace and resolve to
 * null otherwise (fail closed — no oracle about the workspace's existence).
 * Absent, the user's DEFAULT membership is used, else the deterministic
 * fallback (oldest active membership). The one exception is a PINNED API
 * key (an optional least-privilege pin, and the grandfathered binding of
 * keys minted under the old per-workspace model): it always resolves its
 * pinned workspace, and a header naming a DIFFERENT one is rejected
 * outright (403 workspace_mismatch).
 */
export const ACTIVE_WORKSPACE_HEADER = 'x-workspace-id';

/**
 * The resolved caller of ONE request. A credential identifies a USER; the
 * Principal is still scoped to exactly ONE workspace per request (ADR 014):
 * `workspaceId` is the workspace this request SELECTED via
 * {@link ACTIVE_WORKSPACE_HEADER} (or the user's default), authorized
 * against the caller's own live memberships. A user's OTHER memberships are
 * deliberately not represented here; a request never spans workspaces.
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'member';
  /**
   * How the resolved membership came to exist (D2, internal/federation.md §P6):
   * 'local' = ordinary membership (setup, workspace invitation), 'hub' = a
   * hub-org projection (cloud SSO), 'guest' = an external per-resource
   * collaborator minted by the claim path. Origin is a CAPABILITY axis, not
   * a role: a guest resolves like any member but is refused resource creation
   * and workspace-level surfaces (requireNonGuest) on BOTH editions — their
   * access is the per-resource grant (ADR 013), which stays untouched. Every
   * credential path (session, API key, OAuth bearer) reads it live from the
   * membership row backing the request's workspace.
   */
  origin: 'local' | 'hub' | 'guest';
  via: 'session' | 'api_key' | 'oauth';
  /** Scope allowlist for machine principals; null = full role-based (session). */
  scopes: ReadonlySet<string> | null;
  apiKeyId?: string;
  /** Expiry of the presented API key (ISO 8601) — absent for non-expiring keys. */
  apiKeyExpiresAt?: string;
  /** Central account id — undefined in local mode. */
  accountRef?: string;
}

/**
 * Sign-in methods an instance can advertise in discovery. The set is OPEN
 * (ADR 003 reserved this): clients must IGNORE entries they do not
 * recognize, so an edition can add a method — like the cloud edition's
 * 'antasphere' hub SSO — without breaking older SDKs/CLIs. This list is the
 * known vocabulary, not a closed enum.
 */
export const KNOWN_AUTH_METHODS = [
  'password',
  'email-otp',
  'google',
  'api-key',
  'oauth',
  'antasphere'
] as const;
export type KnownAuthMethod = (typeof KNOWN_AUTH_METHODS)[number];

export interface InstanceAuthDescriptor {
  /** Open set — known values in {@link KNOWN_AUTH_METHODS}; ignore unknown entries. */
  methods: Array<KnownAuthMethod | (string & {})>;
  /** Self-serve password reset is available (requires a configured email driver). */
  passwordReset: boolean;
  /** Self-serve email change is available (requires a configured email driver). */
  emailChange: boolean;
  /** Opt-in per-user 2FA (TOTP + backup codes) is available on this instance. */
  twoFactor: boolean;
}

export interface IdentityProvider {
  /** Resolve a request to a live principal (fresh membership check) or null. */
  resolve(ctx: RequestContext): Promise<Principal | null>;
  /** Feeds the instance discovery endpoint. */
  describe(): InstanceAuthDescriptor;
}

export interface MeteredAction {
  /** The action key, e.g. 'files.upload' (the route's `meter.key`, namespaced by the tool's price book). */
  key: string;
  quantity: number;
  unit: string;
}

export type EntitlementDecision = { allowed: true } | { allowed: false; reason: string };

/** Per-principal general-API request quota, enforced by the server's quota middleware. */
export interface RequestQuota {
  /** Sustained allowance per principal per minute. 0 = unlimited (the limiter is skipped). */
  perMinute: number;
  /** Spike cap per principal per second inside the minute window. 0 = no burst smoothing. */
  burstPerSecond: number;
}

export interface EntitlementService {
  check(
    principal: Principal,
    action: MeteredAction,
    ctx?: Record<string, unknown>
  ): Promise<EntitlementDecision>;
  /**
   * Request-rate quota for this principal. The template default returns the
   * instance-level env caps for everyone; a plan-aware edition varies it per
   * account/plan. The quota is enforced per authenticated principal identity
   * (API key id / OAuth subject / session user id), never per client header.
   */
  getRequestQuota(principal: Principal): Promise<RequestQuota>;
}

/**
 * One metered action, as the tool emits it and the hub ingests it (the
 * billing rail spec, §5 `POST /usage/events`). At-least-once from the tool;
 * exactly-once at the hub by `id`. Paid by the account, reported per user.
 */
export interface UsageEvent {
  /** ULID — the idempotency key; receivers dedupe on it (at-least-once emission). */
  id: string;
  /** The action key (`meter` is its historical name; the two carry the same value). */
  meter: string;
  actionKey: string;
  quantity: number;
  unit: string;
  occurredAt: string; // ISO 8601
  workspaceId: string;
  /** The paying account (the workspace's central account id). */
  accountRef?: string;
  /** The reported user; null when the actor is a resource owner the tool could not name. */
  userId: string | null;
  /** How the action arrived: a session (the dashboard), an API key (the CLI), an OAuth client (an MCP connector). */
  via: 'session' | 'api_key' | 'oauth';
  /** The resource the handler recorded (its audit `resourceType` / `resourceId`), when it recorded one. */
  resourceType?: string;
  resourceId?: string;
  /** The tool's slug, from its identity. */
  toolSlug: string;
  source: {
    instanceId: string;
    edition: string;
    version: string;
  };
}

export interface UsageSink {
  emit(event: UsageEvent): Promise<void>;
}

/**
 * Where the durable queue hands the events it drained: the no-op locally,
 * the hub poster on cloud. A downstream that takes whole batches gets them
 * as the worker drained them (fifty at most); one that only takes single
 * events is called once per event.
 */
export interface UsageDownstream extends UsageSink {
  emitBatch?(events: readonly UsageEvent[]): Promise<void>;
}
