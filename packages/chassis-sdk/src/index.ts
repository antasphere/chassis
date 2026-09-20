import type {
  ApiKeyCreateOf,
  ApiKeyCreatedOf,
  ApiKeyInfoOf,
  AuditEntry,
  AuditVia,
  BreakGlassClaimOwnership,
  BreakGlassClaimOwnershipRequest,
  BreakGlassResetTwoFactor,
  BreakGlassResetTwoFactorRequest,
  ChassisContract,
  CliAuthComplete,
  CliAuthCompletedOf,
  CliAuthRequest,
  CliAuthRequested,
  CliAuthRevoked,
  FileInfo,
  InstanceInfo,
  InvitationAccept,
  InvitationCreate,
  InvitationCreated,
  InvitationInfo,
  InvitationLookup,
  MeResponseOf,
  Member,
  MemberChangeEmailLink,
  MemberChangeEmailLinkRequest,
  MemberResetLink,
  MemberUpdate,
  OnboardingDismissed,
  SetupRequest,
  SetupResponse,
  SsoCliConnect,
  SsoLogoutResponse,
  WorkspaceCreated,
  WorkspaceLook,
  WorkspaceRole,
  WorkspaceUpdate,
  WorkspaceUpdated
} from '@antasphere/chassis-contract';

/**
 * The scope-carrying wire types, read off the chassis contract a tool instantiates
 * with its own scopes: `ChassisClient<Scope>` types them exactly as the tool's own
 * `ApiKeyInfo`, `MeResponse`… (same `z.infer` over the same `ChassisContract<Scope>`).
 */
type ApiKeyInfo<TScope extends string> = ApiKeyInfoOf<ChassisContract<TScope>>;
type ApiKeyCreate<TScope extends string> = ApiKeyCreateOf<ChassisContract<TScope>>;
type ApiKeyCreated<TScope extends string> = ApiKeyCreatedOf<ChassisContract<TScope>>;
type CliAuthCompleted<TScope extends string> = CliAuthCompletedOf<ChassisContract<TScope>>;
type MeResponse<TScope extends string> = MeResponseOf<ChassisContract<TScope>>;

/**
 * Thin typed client over /api/v1. Isomorphic: in the dashboard it rides the
 * same-origin session cookie; in Node/CLI contexts pass an API key.
 */

export class PlatformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export interface ClientOptions {
  /** Origin of the instance; '' (default) = same-origin (dashboard). */
  baseUrl?: string;
  /** API key (`<prefix>_<keyid>_<secret>`) for machine callers. */
  apiKey?: string;
  /**
   * Active workspace for EVERY credential kind (sent as X-Workspace-Id —
   * the user-scoped credential model): a caller in several workspaces names
   * which one their requests target; absent, the user's default membership
   * applies. Meaningful with the session cookie AND with user-scoped API
   * keys/OAuth tokens; a PINNED key rejects a mismatching value server-side
   * (403 workspace_mismatch). Mutable later via setWorkspace().
   */
  workspaceId?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Deadline for the JSON API calls, in milliseconds (default 30 000; 0
   * disables). Without one, a hung or throttling instance parks a CLI
   * invocation — or a dashboard request — forever: `fetch` has no default
   * timeout in Node or the browser.
   */
  timeoutMs?: number;
  /**
   * Deadline for the byte-streaming calls — deck assets, file content, the
   * workspace export (default 600 000; 0 disables). Separate because it
   * covers the whole body transfer, and an export is legitimately slow.
   */
  downloadTimeoutMs?: number;
}

/** Cursor-pagination params shared by every list endpoint. */
export interface ListParams {
  /** `nextCursor` from the previous page; omit for page 1. */
  cursor?: string;
  /** Page size (server default 50, max 100). */
  limit?: number;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
  /** How many entries match in all; counted on the first page only, null after it. */
  total: number | null;
}

/** Cursor pagination + the audit log's filters (every one optional, combined with AND). */
export interface AuditListParams extends ListParams {
  /** Free text, matched case-insensitively against the actor's email and the action. */
  q?: string;
  /** Actions or families: an item ending in `.` matches the family (`presentation.`). */
  action?: string[];
  /** How the actor authenticated. */
  actorVia?: AuditVia[];
  /** One user id, or `system` for the rows nobody signed. */
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  /** ISO datetime: entries created at or after this instant. */
  from?: string;
  /** ISO datetime: entries created at or before this instant. */
  to?: string;
}

export interface InvitationAccepted {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface FileUploaded {
  file: FileInfo;
  deduplicated: boolean;
}

/**
 * Options for the non-idempotent create calls. Setting `idempotencyKey`
 * (any client-chosen string ≤200 chars, e.g. a UUID) makes a retried create
 * replay the original response instead of double-creating (docs/security/security.md).
 */
export interface IdempotentRequestOptions {
  idempotencyKey?: string;
}

export function idempotencyHeader(opts: IdempotentRequestOptions): Record<string, string> | undefined {
  return opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined;
}

/** Default deadline for the JSON API calls (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default deadline for the streaming download calls (ms). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

export class ChassisClient<TScope extends string> {
  protected readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private workspaceId: string | undefined;
  protected readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  /**
   * The abort signal every call carries. `fetch` never times out on its
   * own, so a silent peer (or a hostile one holding the socket open) would
   * otherwise hang the caller indefinitely.
   */
  protected signal(kind: 'api' | 'download'): AbortSignal | undefined {
    const ms = kind === 'download' ? this.downloadTimeoutMs : this.timeoutMs;
    return ms > 0 ? AbortSignal.timeout(ms) : undefined;
  }

  /** Set (or clear) the active workspace all subsequent requests target. */
  setWorkspace(workspaceId: string | null): void {
    this.workspaceId = workspaceId ?? undefined;
  }

  /** Base headers shared by every call: credential + active workspace. */
  protected baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (this.workspaceId) headers['x-workspace-id'] = this.workspaceId;
    return headers;
  }

  protected async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;

    const json = (await res.json().catch(() => null)) as
      { error?: { code?: string; message?: string; details?: unknown } } | T | null;

    if (!res.ok) {
      const errBody = (json ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      throw new PlatformApiError(
        res.status,
        errBody.error?.code ?? 'unknown_error',
        errBody.error?.message ?? `Request failed with ${res.status}`,
        errBody.error?.details
      );
    }
    return json as T;
  }

  /** Append cursor-pagination params to a list path. */
  protected pathWithQuery(base: string, params: ListParams): string {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.baseHeaders(), ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal: this.signal('api'),
      // Always see live state: /instance flips setupRequired the moment the
      // wizard completes but is served with public max-age for CLI/MCP
      // discovery — the browser HTTP cache must not answer for the app.
      // (`cache` is a browser-only field; cast keeps this isomorphic under a
      // Node lib where RequestInit omits it.)
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    } as RequestInit);
    return this.parse<T>(res);
  }

  instance(): Promise<InstanceInfo> {
    return this.request('GET', '/instance');
  }

  setup(req: SetupRequest): Promise<SetupResponse> {
    return this.request('POST', '/setup', req);
  }

  me(): Promise<MeResponse<TScope>> {
    return this.request('GET', '/me');
  }

  /**
   * CLOUD EDITION only (404 on oss); sessions only (machines 403): record
   * the explicit first-run-welcome dismissal — flips /me's
   * `firstRunPending` to false, permanently. Idempotent.
   */
  dismissOnboarding(): Promise<OnboardingDismissed> {
    return this.request('POST', '/me/onboarding/dismiss');
  }

  /**
   * Create ANOTHER workspace with the caller as its owner. Sessions only
   * (API keys and OAuth bearers answer 403); offer it only while `/me`'s
   * `canCreateWorkspace` is true. Self-hosted creates it locally under the
   * operator's per-person cap; cloud creates the organization at Antasphere
   * as the caller. Either way `workspace.id` is the id to pass as
   * `X-Workspace-Id` (`setWorkspace`). Refusals (403 unless noted):
   * `session_required`, `guest_forbidden`, `workspace_creation_disabled`,
   * `workspace_limit_reached`, `hub_link_required`, `hub_unavailable`,
   * `hub_refused`, 401 `hub_grant_expired`, 401 `hub_reauth_required` (both
   * healed by signing in again), 400 `validation_error`, 429 `rate_limited`.
   */
  createWorkspace(
    name: string,
    opts: IdempotentRequestOptions & { look?: Partial<WorkspaceLook> } = {}
  ): Promise<WorkspaceCreated> {
    const { look, ...rest } = opts;
    return this.request('POST', '/workspaces', look ? { name, look } : { name }, idempotencyHeader(rest));
  }

  /**
   * PATCH /workspace — the ACTIVE workspace's name and look (owner/admin,
   * sessions only). A rename of a hub-origin workspace answers 403
   * `hub_managed` with `details.manageUrl`; its look is accepted.
   */
  updateWorkspace(body: WorkspaceUpdate): Promise<WorkspaceUpdated> {
    return this.request('PATCH', '/workspace', body);
  }

  /** Better Auth session probe — null when signed out. */
  async session(): Promise<{ user: { id: string; email: string; name: string } } | null> {
    return this.request('GET', '/auth/get-session');
  }

  signInEmail(email: string, password: string): Promise<{ user: { id: string } }> {
    return this.request('POST', '/auth/sign-in/email', { email, password });
  }

  signOut(): Promise<void> {
    return this.request('POST', '/auth/sign-out', {});
  }

  // ── CLI auth (browserless email-OTP → API key) ────────────────────────────

  /** Public: email a sign-in code. Generic success — silent about account existence. */
  cliAuthRequest(req: CliAuthRequest): Promise<CliAuthRequested> {
    return this.request('POST', '/cli/auth/request', req);
  }

  /**
   * Public: verify the code and mint an API key (the tool's read + write
   * scopes). The returned `key` appears only here.
   */
  cliAuthComplete(req: CliAuthComplete): Promise<CliAuthCompleted<TScope>> {
    return this.request('POST', '/cli/auth/complete', req);
  }

  /**
   * Revoke the PRESENTING API key (CLI logout). Self-revocation only: the
   * route names no key, so the credential can kill exactly itself. Requires
   * an API-key credential with the tool's write scope (sessions and OAuth
   * bearers are refused — the dashboard is their key-management surface).
   */
  cliAuthRevoke(): Promise<CliAuthRevoked> {
    return this.request('DELETE', '/cli/auth/key');
  }

  /**
   * Public, CLOUD EDITION only (404 on oss): exchange a hub-minted 120 s
   * connect JWT (the hub's /sso/tool-token response) for an API key
   * bound to the projected workspace — same grant and one-shot response
   * shape as cliAuthComplete. Each token works exactly once (jti).
   */
  ssoCliConnect(req: SsoCliConnect): Promise<CliAuthCompleted<TScope>> {
    return this.request('POST', '/sso/cli-connect', req);
  }

  /**
   * CLOUD EDITION only (404 on oss); sessions only (machines 403 — the
   * path is unlisted in the scope allowlist): single logout. The server
   * revokes the local session and clears the SSO hint cookie in this very
   * response; `url` is the hub end-session URL the browser must then VISIT
   * to end the hub anchor session (null = local signout only — go straight
   * to /login?signed_out=1).
   */
  ssoLogout(): Promise<SsoLogoutResponse> {
    return this.request('POST', '/sso/logout');
  }

  // ── Members ───────────────────────────────────────────────────────────────

  members(params: ListParams = {}): Promise<{ members: Member[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/members', params));
  }

  updateMember(id: string, patch: MemberUpdate): Promise<Member> {
    return this.request('PATCH', `/members/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Admin: delete a member's account (GDPR erasure). Sessions only — the
   * endpoint is unlisted in the machine scope allowlist, so API keys 403.
   * Files the member uploaded stay with the workspace.
   */
  deleteMember(id: string): Promise<Member> {
    return this.request('DELETE', `/members/${encodeURIComponent(id)}`);
  }

  /**
   * Owner: mint a one-time password reset link for a member (SMTP-free
   * recovery). Refused for a per-deck guest and for anyone who also belongs
   * to another workspace — the minted credential is global (PRDCT-1354).
   */
  createMemberResetLink(id: string, opts: IdempotentRequestOptions = {}): Promise<MemberResetLink> {
    return this.request(
      'POST',
      `/members/${encodeURIComponent(id)}/reset-link`,
      undefined,
      idempotencyHeader(opts)
    );
  }

  /**
   * Owner: mint a one-time email change link for a member (SMTP-free email
   * change). ⚠️ The link updates the email AND signs the member in — share
   * it with the target member only. Same refusals as the reset link (guest
   * targets, cross-workspace targets), plus the cloud edition closure.
   */
  createMemberChangeEmailLink(
    id: string,
    req: MemberChangeEmailLinkRequest,
    opts: IdempotentRequestOptions = {}
  ): Promise<MemberChangeEmailLink> {
    return this.request(
      'POST',
      `/members/${encodeURIComponent(id)}/change-email-link`,
      req,
      idempotencyHeader(opts)
    );
  }

  // ── Break-glass (superadmin recovery, ADR 010) ────────────────────────────

  /**
   * Superadmin: make the caller (or a named existing user) an ACTIVE OWNER
   * of the workspace — creating, reactivating, or promoting the membership.
   * Adds an owner, never removes one. Sessions only: the endpoint is
   * unlisted in the machine scope allowlist (API keys/tokens 403), and the
   * calling session's VERIFIED email must be on SUPERADMIN_EMAILS.
   */
  breakGlassClaimOwnership(req: BreakGlassClaimOwnershipRequest = {}): Promise<BreakGlassClaimOwnership> {
    return this.request('POST', '/admin/break-glass/claim-ownership', req);
  }

  /** Superadmin: clear a locked-out user's 2FA (sessions only, audited). */
  breakGlassResetTwoFactor(req: BreakGlassResetTwoFactorRequest): Promise<BreakGlassResetTwoFactor> {
    return this.request('POST', '/admin/break-glass/reset-2fa', req);
  }

  // ── API keys ──────────────────────────────────────────────────────────────

  apiKeys(params: ListParams = {}): Promise<{ apiKeys: ApiKeyInfo<TScope>[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/api-keys', params));
  }

  /** The returned `key` is the full secret — shown once, never retrievable. */
  createApiKey(
    req: ApiKeyCreate<TScope>,
    opts: IdempotentRequestOptions = {}
  ): Promise<ApiKeyCreated<TScope>> {
    return this.request('POST', '/api-keys', req, idempotencyHeader(opts));
  }

  revokeApiKey(id: string): Promise<ApiKeyInfo<TScope>> {
    return this.request('DELETE', `/api-keys/${encodeURIComponent(id)}`);
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  invitations(
    params: ListParams = {}
  ): Promise<{ invitations: InvitationInfo[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/invitations', params));
  }

  /** `acceptUrl` is always returned — email delivery is best-effort on top. */
  createInvitation(req: InvitationCreate, opts: IdempotentRequestOptions = {}): Promise<InvitationCreated> {
    return this.request('POST', '/invitations', req, idempotencyHeader(opts));
  }

  revokeInvitation(id: string): Promise<InvitationInfo> {
    return this.request('DELETE', `/invitations/${encodeURIComponent(id)}`);
  }

  /** Public: resolves an invitation token for the acceptance page. */
  lookupInvitation(token: string): Promise<InvitationLookup> {
    return this.request('GET', `/invitations/lookup?token=${encodeURIComponent(token)}`);
  }

  /** Public: accepts an invitation (creates the account when needed). */
  acceptInvitation(req: InvitationAccept): Promise<InvitationAccepted> {
    return this.request('POST', '/invitations/accept', req);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  audit(params: AuditListParams = {}): Promise<AuditListResponse> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.q) query.set('q', params.q);
    if (params.action?.length) query.set('action', params.action.join(','));
    if (params.actorVia?.length) query.set('actorVia', params.actorVia.join(','));
    if (params.actor) query.set('actor', params.actor);
    if (params.resourceType) query.set('resourceType', params.resourceType);
    if (params.resourceId) query.set('resourceId', params.resourceId);
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const qs = query.toString();
    return this.request('GET', qs ? `/audit?${qs}` : '/audit');
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  files(params: ListParams = {}): Promise<{ files: FileInfo[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/files', params));
  }

  /** Uploads raw bytes; the filename travels as a query param. */
  async uploadFile(
    name: string,
    body: Blob | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<FileUploaded> {
    const type =
      contentType ??
      (typeof Blob !== 'undefined' && body instanceof Blob && body.type
        ? body.type
        : 'application/octet-stream');
    const headers: Record<string, string> = { ...this.baseHeaders(), 'content-type': type };

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
      body: body as unknown as RequestInit['body']
    } as RequestInit);
    return this.parse<FileUploaded>(res);
  }

  deleteFile(id: string): Promise<FileInfo> {
    return this.request('DELETE', `/files/${encodeURIComponent(id)}`);
  }

  file(id: string): Promise<FileInfo> {
    return this.request('GET', `/files/${encodeURIComponent(id)}`);
  }

  /** URL of the streamed (Range-capable) content endpoint for a file. */
  fileContentUrl(id: string): string {
    return `${this.baseUrl}/api/v1/files/${encodeURIComponent(id)}/content`;
  }

  /**
   * Downloads a file's bytes with the client's own headers (credential and
   * active workspace). Raw Response so callers can stream it; a non-2xx
   * answer throws PlatformApiError like every other method. A browser anchor
   * on `fileContentUrl` cannot carry `X-Workspace-Id` (PRDCT-2426).
   */
  async downloadFileContent(id: string): Promise<Response> {
    return this.rawDownload(this.fileContentUrl(id));
  }

  /** The shared body of the streamed-download methods (the asset download's shape). */
  protected async rawDownload(url: string): Promise<Response> {
    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }

  // ── Workspace export ──────────────────────────────────────────────────────

  /** URL of the workspace export endpoint (admin+; keys need the tool's export scope). */
  workspaceExportUrl(): string {
    return `${this.baseUrl}/api/v1/workspace/export`;
  }

  /**
   * Downloads the full workspace export. Returns the raw Response so callers
   * can stream the zip (exports can be large — never buffer by default);
   * a non-2xx answer throws PlatformApiError like every other method.
   */
  async downloadExport(): Promise<Response> {
    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(this.workspaceExportUrl(), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }
}
