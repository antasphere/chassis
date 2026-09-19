import { workspaceRoles, type WorkspaceRole } from '@antasphere/chassis-db';
import type { Logger } from '../logger.js';
import type { GrantAccess, HubGrantService } from './hub-grant.js';

/**
 * The as-the-user hub reader (internal/federation.md, live user-scoped
 * federation): every org/membership read between logins is `GET
 * <hub>/api/v1/orgs` presented with the USER's OWN grant token
 * (identity/hub-grant.ts) — the hub only ever returns what that user may
 * see, so a cross-tenant read is structurally impossible on this path.
 * There is deliberately NO target-user parameter anywhere.
 *
 * Failure posture mirrors the retired H4 client: only a definitive 200
 * list may drive reconciliation; network/timeout/5xx/malformed answers are
 * one loud, fail-open 'inconclusive'. A 401/403 gets exactly ONE
 * forced-refresh retry (the presented token may be stale or wrong-audience
 * from a pre-flip row) — a second refusal is inconclusive, never a grant
 * kill (only the token endpoint's `invalid_grant` kills a grant, inside
 * HubGrantService).
 */

/** The hub API resource identifier (RFC 8707 `aud`) — `<hub issuer>/mcp`. */
export function hubApiResource(issuerUrl: string): string {
  return issuerUrl.replace(/\/+$/, '') + '/mcp';
}

/**
 * One validated entry of the caller-scoped org list. Forward-compatible by
 * construction: an absent `status` reads as 'active', an absent `isDefault`
 * as false, an unknown `role` as null (keep-alive only — an unknown role
 * must never read as absence).
 */
export interface HubOrg {
  /** The hub org id (uuid) — what `workspaces.centralAccountId` projects. */
  id: string;
  /** Org display name; null when absent/blank. */
  name: string | null;
  role: WorkspaceRole | null;
  status: 'active' | 'suspended';
  /** The caller's hub-level default org (at most one entry carries it). */
  isDefault: boolean;
}

export type HubOrgsResult =
  { kind: 'ok'; orgs: HubOrg[] } | { kind: 'no_link' } | { kind: 'grant_dead' } | { kind: 'inconclusive' };

/**
 * The answer of one as-the-user org creation (PRDCT-2443):
 *  - 'created': the hub answered 201 with a well-formed org;
 *  - 'limit_reached': the hub's own per-user organization cap refused it;
 *  - 'reauth_required': the hub answered 403 `insufficient_scope` — THIS
 *    grant does not carry `orgs:create` (it predates the scope, or a CLI
 *    connect replaced it). Not a dead grant and not a policy refusal: a
 *    fresh browser sign-in mints a grant that has it;
 *  - 'invalid': the hub refused the NAME (its validation, not ours);
 *  - 'refused': any other definitive refusal (the hub does not let this
 *    grant create organizations) — `code` is the hub's, for the log only;
 *  - 'no_link' / 'grant_dead': the grant verdicts, verbatim from
 *    HubGrantService;
 *  - 'inconclusive': network/timeout/5xx/malformed. The organization MAY
 *    exist at the hub (it commits before it answers); the caller never
 *    retries by itself, and the next reconcile pass projects it if so.
 */
export type HubCreateOrgResult =
  | { kind: 'created'; org: { id: string; name: string | null; role: WorkspaceRole | null } }
  | { kind: 'limit_reached' }
  | { kind: 'reauth_required' }
  | { kind: 'invalid' }
  | { kind: 'refused'; status: number; code: string | null }
  | { kind: 'no_link' }
  | { kind: 'grant_dead' }
  | { kind: 'inconclusive' };

/** The one-function boundary the workspace-creation route depends on (its test seam). */
export type HubOrgCreator = (localUserId: string, name: string) => Promise<HubCreateOrgResult>;

/** The hub's cap refusal codes — today's (`org_limit_reached`) and the `*_cap_reached` spelling. */
const HUB_ORG_LIMIT_CODES = new Set(['org_limit_reached', 'org_cap_reached']);

/**
 * THE ONE PLACE that knows the shape of the hub's `POST /api/v1/orgs` answer
 * (hub contract `orgCreatedSchema`: 201 `{ org: { id, name, role, … } }`;
 * refusals in the common `{ error: { code } }` envelope). Pure, so the
 * shape is adjustable — and testable — without touching the transport.
 */
export function classifyHubOrgCreateAnswer(status: number, body: unknown): HubCreateOrgResult {
  const code =
    typeof (body as { error?: { code?: unknown } } | null)?.error?.code === 'string'
      ? (body as { error: { code: string } }).error.code
      : null;
  if (status === 201 || status === 200) {
    const raw = ((body as { org?: unknown } | null)?.org ?? null) as {
      id?: unknown;
      name?: unknown;
      role?: unknown;
    } | null;
    // A 2xx without a valid org id is unusable AND ambiguous (something was
    // probably created): inconclusive, never a guess at the id.
    if (!raw || typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return { kind: 'inconclusive' };
    return {
      kind: 'created',
      org: {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : null,
        role:
          typeof raw.role === 'string' && (workspaceRoles as readonly string[]).includes(raw.role)
            ? (raw.role as WorkspaceRole)
            : null
      }
    };
  }
  if ((status === 403 || status === 409) && code !== null && HUB_ORG_LIMIT_CODES.has(code)) {
    return { kind: 'limit_reached' };
  }
  // Exactly the hub's scope refusal — never any other 403 (a registry
  // refusal, `forbidden`, stays 'refused': signing in again would not help).
  if (status === 403 && code === 'insufficient_scope') return { kind: 'reauth_required' };
  if (status === 400 || status === 422) return { kind: 'invalid' };
  if (status >= 400 && status < 500) return { kind: 'refused', status, code };
  return { kind: 'inconclusive' };
}

/** Strict UUID shape — a malformed hub entry must never reach Postgres' uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SSO callback's access token, handed through by the login path. */
export interface LoginAccessToken {
  accessToken: string;
  expiresAt: Date | null;
}

export interface HubUserClientOptions {
  grant: HubGrantService;
  /** The hub origin (HUB_ISSUER_URL) — /api/v1/orgs lives under it. */
  issuerUrl: string;
  logger: Logger;
  /** Per-fetch timeout — tight, because reconcile passes are awaited in the identity path. */
  timeoutMs: number;
  /**
   * POST /orgs fetch timeout. A creation is a deliberate human act awaited
   * once, not an identity-path read: it gets the token-endpoint budget
   * rather than the tight reconcile one. Defaults to `timeoutMs`.
   */
  createTimeoutMs?: number | undefined;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export class HubUserClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HubUserClientOptions) {
    this.base = opts.issuerUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * The user's own org list, as the hub sees it RIGHT NOW. `login` carries
   * the SSO callback's access token (already hub-audienced — the code
   * exchange sends the same `resource`): the login path needs no refresh,
   * and the token is primed into the grant cache for the requests that
   * follow.
   */
  async orgs(localUserId: string, login?: LoginAccessToken): Promise<HubOrgsResult> {
    let token: string;
    if (login) {
      this.opts.grant.prime(localUserId, login.accessToken, login.expiresAt);
      token = login.accessToken;
    } else {
      const access = await this.opts.grant.accessToken(localUserId);
      if (access.kind !== 'ok') return { kind: access.kind };
      token = access.accessToken;
    }

    let res = await this.get(token);
    if (res.kind === 'error') return { kind: 'inconclusive' };
    if (res.response.status === 401 || res.response.status === 403) {
      // The hub refused the token (expired mid-window, or a pre-flip row's
      // wrong-audience stored token): ONE forced refresh, ONE retry. The
      // refresh itself classifies the grant (invalid_grant → dead).
      this.opts.grant.invalidateAccess(localUserId);
      const refreshed: GrantAccess = await this.opts.grant.refresh(localUserId);
      if (refreshed.kind !== 'ok') return { kind: refreshed.kind };
      res = await this.get(refreshed.accessToken);
      if (res.kind === 'error') return { kind: 'inconclusive' };
      if (res.response.status === 401 || res.response.status === 403) {
        this.opts.logger.error(
          { status: res.response.status },
          'hub /orgs refused a FRESHLY refreshed token — the hub is rejecting this tool’s grants; failing open'
        );
        return { kind: 'inconclusive' };
      }
    }
    const { response } = res;
    if (!response.ok) {
      this.opts.logger.warn({ status: response.status }, 'hub /orgs answered non-2xx — failing open');
      return { kind: 'inconclusive' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.opts.logger.warn('hub /orgs body unparseable — failing open');
      return { kind: 'inconclusive' };
    }
    const rawList = (body as { orgs?: unknown } | null)?.orgs;
    if (!Array.isArray(rawList)) {
      this.opts.logger.warn('hub /orgs body malformed — failing open');
      return { kind: 'inconclusive' };
    }
    const orgs: HubOrg[] = [];
    for (const raw of rawList) {
      const entry = (raw ?? {}) as {
        id?: unknown;
        name?: unknown;
        role?: unknown;
        status?: unknown;
        isDefault?: unknown;
      };
      if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
        // One bad entry never poisons the list — but its org can neither be
        // projected NOR protected by the keep-set, so say so loudly.
        this.opts.logger.error('hub /orgs carried an entry without a valid id — entry dropped');
        continue;
      }
      const role =
        typeof entry.role === 'string' && (workspaceRoles as readonly string[]).includes(entry.role)
          ? (entry.role as WorkspaceRole)
          : null;
      if (role === null) {
        this.opts.logger.warn(
          { hubOrgId: entry.id },
          'hub /orgs carried an unknown role — keeping the membership alive, skipping its sync'
        );
      }
      orgs.push({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : null,
        role,
        // Unknown/absent status reads as 'active' (forward-compat: status
        // only ever narrows access; enforcement reads the synced column).
        status: entry.status === 'suspended' ? 'suspended' : 'active',
        isDefault: entry.isDefault === true
      });
    }
    return { kind: 'ok', orgs };
  }

  /**
   * Create an organization at the hub AS THE USER (PRDCT-2443): `POST
   * <hub>/api/v1/orgs` `{ name }` presented with the user's OWN grant token,
   * obtained through the SAME HubGrantService path `orgs()` uses (cache →
   * single-flighted refresh; the PRDCT-1370 presentation record and probe
   * live inside it). No service key, no target-user parameter: the hub makes
   * the BEARER the owner, so the only organization this can ever create is
   * the caller's own.
   *
   * Retry posture, deliberately narrower than the read's: ONLY a 401 earns
   * the one forced-refresh retry (the hub refused the token before doing
   * anything, so nothing was created). A 403 is a definitive policy answer
   * (the cap, or a hub that does not open creation to grants) and a
   * network/timeout/5xx answer is NEVER retried — the hub commits before it
   * answers, so a blind second POST could create a second organization.
   */
  async createOrg(localUserId: string, name: string): Promise<HubCreateOrgResult> {
    const access = await this.opts.grant.accessToken(localUserId);
    if (access.kind !== 'ok') return { kind: access.kind };

    let res = await this.post(access.accessToken, name);
    if (res.kind === 'error') return { kind: 'inconclusive' };
    if (res.response.status === 401) {
      this.opts.grant.invalidateAccess(localUserId);
      const refreshed: GrantAccess = await this.opts.grant.refresh(localUserId);
      if (refreshed.kind !== 'ok') return { kind: refreshed.kind };
      res = await this.post(refreshed.accessToken, name);
      if (res.kind === 'error') return { kind: 'inconclusive' };
      if (res.response.status === 401) {
        this.opts.logger.error(
          'hub POST /orgs refused a FRESHLY refreshed token — the hub is rejecting this tool’s grants'
        );
        return { kind: 'refused', status: 401, code: null };
      }
    }
    let body: unknown = null;
    try {
      body = await res.response.json();
    } catch {
      body = null;
    }
    const result = classifyHubOrgCreateAnswer(res.response.status, body);
    if (result.kind === 'inconclusive' || result.kind === 'refused') {
      this.opts.logger.warn(
        { status: res.response.status, code: result.kind === 'refused' ? result.code : undefined },
        'hub POST /orgs did not create the organization'
      );
    }
    return result;
  }

  private async post(
    token: string,
    name: string
  ): Promise<{ kind: 'ok'; response: Response } | { kind: 'error' }> {
    try {
      const response = await this.fetchImpl(`${this.base}/api/v1/orgs`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(this.opts.createTimeoutMs ?? this.opts.timeoutMs)
      });
      return { kind: 'ok', response };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub POST /orgs fetch failed — the organization may or may not exist');
      return { kind: 'error' };
    }
  }

  private async get(token: string): Promise<{ kind: 'ok'; response: Response } | { kind: 'error' }> {
    try {
      const response = await this.fetchImpl(`${this.base}/api/v1/orgs`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs)
      });
      return { kind: 'ok', response };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub /orgs fetch failed — failing open');
      return { kind: 'error' };
    }
  }
}
