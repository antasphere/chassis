import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { GrantAccess, HubGrantService } from '../identity/hub-grant.js';
import type { FleetOrigins, FleetTool } from '../webhooks/fleet-origins.js';

/**
 * The sibling connect's two conversations (PRDCT-3774): with the hub, as the
 * person, for a two-minute token audienced to a sibling tool; with the
 * sibling, as the person, for the one connect. Nothing here acts as a tool:
 * the hub is read with the person's own grant (`HubGrantService`, the
 * no-service-key rule of identity/hub-grant.ts), and the sibling with a key
 * the sibling minted for the person and that is revoked before the call
 * returns, whatever happened in between. Nothing here touches the store:
 * the service (`service.ts`) owns the row, the box and the receiving URL;
 * this module answers OUTCOMES, never throws for a refusal, and never logs a
 * token, a key or a secret.
 *
 *  - `connectToken`: `POST <hub>/api/v1/sso/connect-token { resource }` with
 *    the person's hub access token (the hub's ADR 028). A 401 earns one
 *    forced refresh and one retry, like the org creation; a 403
 *    `insufficient_scope` says the grant predates the tool's request of
 *    `sso:connect` (one sign-in heals it); a 403 `tool_access_denied` says
 *    the hub does not open the sibling to this account; a 400
 *    `unknown_resource` says the hub's registry does not know the sibling
 *    by that resource.
 *  - `withPersonKey`: `POST <sibling>/api/v1/sso/cli-connect { token }` for
 *    a user-scoped key of the person on the sibling (the key the CLI would
 *    get), the work, then `DELETE <sibling>/api/v1/cli/auth/key` in a
 *    `finally`. A sibling that holds no grant of the person refuses (403
 *    `hub_grant_missing`): the person must have opened the sibling once.
 *  - `workspaceOf`: `GET <sibling>/api/v1/me` as the key, the workspace
 *    whose `centralAccountId` is our workspace's hub organization.
 *  - `createEndpoint` / `deleteEndpoint`: the sibling's own webhook routes,
 *    in that workspace.
 */

export type SiblingOutcome<T> =
  | { kind: 'ok'; value: T }
  /** The person's grant on this tool is gone or dead: they sign in again. */
  | { kind: 'hub_reauth_required' }
  /** The hub lists no tool of that slug, or no tool at that resource. */
  | { kind: 'sibling_unknown'; message: string }
  /** The grant lacks `sso:connect`: the person signs in again so it carries the scope. */
  | { kind: 'sibling_scope_missing' }
  /** The hub does not let this account use the sibling. */
  | { kind: 'sibling_access_denied' }
  /** The sibling holds no usable grant of the person: they open the sibling once, then retry. */
  | { kind: 'sibling_grant_missing' }
  /** No workspace of the sibling projects our hub organization. */
  | { kind: 'sibling_workspace_missing' }
  /** The sibling (or the hub) refused the act for a reason of its own; the message is theirs. */
  | { kind: 'sibling_refused'; message: string }
  /** The hub or the sibling did not answer, or answered 5xx: nothing changed, try again. */
  | { kind: 'unavailable'; message: string };

export type SiblingRefusal = Exclude<SiblingOutcome<never>, { kind: 'ok' }>;

export interface SiblingConnectorDeps {
  grant: Pick<HubGrantService, 'accessToken' | 'invalidateAccess' | 'refresh'>;
  /** The hub's issuer URL (`HUB_ISSUER_URL`): the connect-token route lives under its `/api/v1`. */
  issuerUrl: string;
  fleet: Pick<FleetOrigins, 'tool' | 'fetchedAt'>;
  logger: Logger;
  /** Per-call budget for the hub and the sibling; a connect is one deliberate human act, awaited once. */
  timeoutMs?: number | undefined;
  /** The whole connect's budget, every call included (DEFAULT_SIBLING_OVERALL_MS). */
  overallMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export const DEFAULT_SIBLING_TIMEOUT_MS = 10_000;
/**
 * One connect's whole budget, every call to the hub and the sibling included
 * (verifier round 6, N1): a conversation that runs past it is cut as
 * unavailable, so a slow sibling never holds a connect (and its lock) open
 * for long. The per-call limit stays `timeoutMs`; the budget is the ceiling.
 */
export const DEFAULT_SIBLING_OVERALL_MS = 60_000;

/** The deadline of one connect, handed to every call it makes. */
export interface SiblingBudget {
  deadlineAt: number;
}

const errorBody = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() })
});
const cliConnected = z.object({ key: z.string().min(1) });
const meWorkspaces = z.object({
  workspaces: z.array(z.object({ id: z.string(), centralAccountId: z.string().nullable() }))
});
const endpointCreated = z.object({ id: z.string().min(1), secret: z.string().min(1) });
const endpointsPage = z.object({
  webhooks: z.array(z.object({ id: z.string(), url: z.string() })),
  nextCursor: z.string().nullable()
});

/** The sibling's error code and message, when the body is the chassis's error shape; else nothing. */
async function readError(res: Response): Promise<{ code: string | null; message: string }> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = errorBody.safeParse(body);
  if (!parsed.success) return { code: null, message: `HTTP ${res.status}` };
  return { code: parsed.data.error.code, message: parsed.data.error.message ?? parsed.data.error.code };
}

export class SiblingConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly hubBase: string;
  /** The per-call limit, in milliseconds. */
  readonly timeoutMs: number;
  /** One connect's whole budget, in milliseconds. */
  readonly overallMs: number;

  constructor(private readonly deps: SiblingConnectorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hubBase = deps.issuerUrl.replace(/\/+$/, '');
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_SIBLING_TIMEOUT_MS;
    this.overallMs = deps.overallMs ?? DEFAULT_SIBLING_OVERALL_MS;
  }

  /** A new connect's budget: its deadline, from now. */
  budget(): SiblingBudget {
    return { deadlineAt: Date.now() + this.overallMs };
  }

  /** The signal of one call under a budget: the per-call limit, or what is left of the budget; null when nothing is left. */
  private signal(budget: SiblingBudget | undefined): AbortSignal | null {
    if (!budget) return AbortSignal.timeout(this.timeoutMs);
    const left = budget.deadlineAt - Date.now();
    if (left <= 0) return null;
    return AbortSignal.timeout(Math.min(this.timeoutMs, left));
  }

  /** The sibling as the hub lists it, by registry slug; null when the fleet list (as last read) names none. */
  resolve(slug: string): FleetTool | null {
    return this.deps.fleet.tool(slug);
  }

  /** Whether the hub's fleet list was ever read: before the first success an absent slug says nothing about the sibling. */
  fleetRead(): boolean {
    return this.deps.fleet.fetchedAt !== null;
  }

  /**
   * The sibling's API base: the ORIGIN OF ITS RESOURCE URL, not of its launch
   * URL. A chassis instance derives its resource as `<PUBLIC_BASE_URL>/mcp`
   * and pins the connect token's audience to it, so the resource's origin is
   * where its `/api/v1` answers; a registry tool may launch its browser
   * entrance on another host (verifier round 5, F5).
   */
  static apiOrigin(tool: Pick<FleetTool, 'resourceUrl'>): string {
    return new URL(tool.resourceUrl).origin;
  }

  // ── The hub, as the person ────────────────────────────────────────────────

  /** The two-minute token audienced to the sibling, bought with the person's own grant on this tool. */
  async connectToken(
    userId: string,
    resourceUrl: string,
    budget?: SiblingBudget
  ): Promise<SiblingOutcome<string>> {
    const access = await this.deps.grant.accessToken(userId);
    if (access.kind !== 'ok') return this.grantRefusal(access);

    let res = await this.postConnectToken(access.accessToken, resourceUrl, budget);
    if (res.kind === 'error') return { kind: 'unavailable', message: res.message };
    if (res.response.status === 401) {
      // The hub refused the token before doing anything: one forced refresh, one retry.
      this.deps.grant.invalidateAccess(userId);
      const refreshed: GrantAccess = await this.deps.grant.refresh(userId);
      if (refreshed.kind !== 'ok') return this.grantRefusal(refreshed);
      res = await this.postConnectToken(refreshed.accessToken, resourceUrl, budget);
      if (res.kind === 'error') return { kind: 'unavailable', message: res.message };
      if (res.response.status === 401) {
        this.deps.logger.error(
          'hub POST /sso/connect-token refused a freshly refreshed token — the hub is rejecting this tool’s grants'
        );
        return { kind: 'hub_reauth_required' };
      }
    }
    const { response } = res;
    if (response.status === 200) {
      const body = z.object({ token: z.string().min(1) }).safeParse(await response.json().catch(() => null));
      if (!body.success) return { kind: 'unavailable', message: 'the hub’s answer was off its contract' };
      return { kind: 'ok', value: body.data.token };
    }
    const { code, message } = await readError(response);
    if (response.status === 403 && code === 'insufficient_scope') return { kind: 'sibling_scope_missing' };
    if (response.status === 403 && code === 'tool_access_denied') return { kind: 'sibling_access_denied' };
    if (response.status === 400 && code === 'unknown_resource') {
      return {
        kind: 'sibling_unknown',
        message: 'The hub’s registry knows no tool at the sibling’s address'
      };
    }
    if (response.status >= 500)
      return { kind: 'unavailable', message: `the hub answered ${response.status}` };
    this.deps.logger.warn({ status: response.status, code }, 'hub POST /sso/connect-token refused');
    return { kind: 'sibling_refused', message: `The hub refused the connect: ${message}` };
  }

  private grantRefusal(access: Exclude<GrantAccess, { kind: 'ok' }>): SiblingRefusal {
    if (access.kind === 'inconclusive') {
      return { kind: 'unavailable', message: 'the hub did not answer the grant refresh' };
    }
    return { kind: 'hub_reauth_required' };
  }

  private async postConnectToken(
    token: string,
    resourceUrl: string,
    budget?: SiblingBudget
  ): Promise<{ kind: 'ok'; response: Response } | { kind: 'error'; message: string }> {
    const signal = this.signal(budget);
    if (!signal) return { kind: 'error', message: 'the connect took too long' };
    try {
      const response = await this.fetchImpl(`${this.hubBase}/api/v1/sso/connect-token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ resource: resourceUrl }),
        redirect: 'error',
        signal
      });
      return { kind: 'ok', response };
    } catch (err) {
      this.deps.logger.warn({ err }, 'hub POST /sso/connect-token did not answer');
      return { kind: 'error', message: 'the hub did not answer' };
    }
  }

  // ── The sibling, as the person ────────────────────────────────────────────

  /**
   * A key of the person on the sibling for the length of `work`, revoked in
   * a `finally` whatever `work` did. The key never leaves this method.
   */
  async withPersonKey<T>(
    tool: FleetTool,
    connectToken: string,
    work: (key: string) => Promise<SiblingOutcome<T>>,
    budget?: SiblingBudget
  ): Promise<SiblingOutcome<T>> {
    const minted = await this.call(tool, 'POST', '/sso/cli-connect', {
      body: { token: connectToken },
      budget
    });
    if (minted.kind !== 'ok') return minted;
    const { response } = minted;
    // The key is minted: the chassis answers 201 (the full key appears once, in this answer).
    if (response.status !== 201 && response.status !== 200) {
      const { code, message } = await readError(response);
      if (response.status === 403 && (code === 'hub_grant_missing' || code === 'no_membership')) {
        return { kind: 'sibling_grant_missing' };
      }
      if (response.status >= 500) {
        return { kind: 'unavailable', message: `${tool.name} answered ${response.status} on the connect` };
      }
      this.deps.logger.warn(
        { status: response.status, code, sibling: tool.slug },
        'sibling refused the connect token'
      );
      return { kind: 'sibling_refused', message: `${tool.name} refused the connect: ${message}` };
    }
    const body = cliConnected.safeParse(await response.json().catch(() => null));
    if (!body.success)
      return { kind: 'unavailable', message: `${tool.name}’s connect answer was off the contract` };
    const key = body.data.key;
    try {
      return await work(key);
    } finally {
      // The revocation rides no budget: it must be tried whatever the clock says.
      await this.revoke(tool, key);
    }
  }

  /** `DELETE /cli/auth/key` as the key: best effort, logged, never thrown — the key expires with nothing else anyway. */
  private async revoke(tool: FleetTool, key: string): Promise<void> {
    const res = await this.call(tool, 'DELETE', '/cli/auth/key', { key });
    if (res.kind !== 'ok' || res.response.status !== 200) {
      this.deps.logger.warn(
        { sibling: tool.slug, status: res.kind === 'ok' ? res.response.status : null },
        'connections: the person’s key on the sibling could not be revoked'
      );
    }
  }

  /** The sibling workspace that projects our hub organization, as the key sees it. */
  async workspaceOf(
    tool: FleetTool,
    key: string,
    centralAccountId: string,
    budget?: SiblingBudget
  ): Promise<SiblingOutcome<string>> {
    const res = await this.call(tool, 'GET', '/me', { key, budget });
    if (res.kind !== 'ok') return res;
    if (res.response.status !== 200) return this.refusal(tool, res.response, 'read the person’s workspaces');
    const body = meWorkspaces.safeParse(await res.response.json().catch(() => null));
    if (!body.success)
      return { kind: 'unavailable', message: `${tool.name}’s /me answer was off the contract` };
    const match = body.data.workspaces.find((w) => w.centralAccountId === centralAccountId);
    if (!match) return { kind: 'sibling_workspace_missing' };
    return { kind: 'ok', value: match.id };
  }

  /** Register our receiving URL as an endpoint of the sibling workspace; the answer carries the signing secret, once. */
  async createEndpoint(
    tool: FleetTool,
    key: string,
    workspaceId: string,
    endpoint: { url: string; events: readonly string[]; description: string },
    budget?: SiblingBudget
  ): Promise<SiblingOutcome<{ id: string; secret: string }>> {
    const res = await this.call(tool, 'POST', '/webhooks', {
      key,
      workspaceId,
      body: { url: endpoint.url, events: [...endpoint.events], description: endpoint.description },
      budget
    });
    if (res.kind !== 'ok') return res;
    if (res.response.status !== 201) return this.refusal(tool, res.response, 'register the endpoint');
    const body = endpointCreated.safeParse(await res.response.json().catch(() => null));
    if (!body.success) {
      return { kind: 'unavailable', message: `${tool.name}’s endpoint answer was off the contract` };
    }
    return { kind: 'ok', value: { id: body.data.id, secret: body.data.secret } };
  }

  /**
   * Delete every PREVIOUS endpoint of ours for a source in the sibling
   * workspace: the one the row tracks (`also`, by id, whatever its URL: the
   * public base may have changed since) and every one whose URL starts with
   * our door's prefix for that source (the ones left by hand or by a lost
   * race), all but the one just registered (`keep`). After a connect they
   * would only deliver to an address that answers 404 (the laptop proof of
   * round 5 found one left by hand); after a disconnect none stays. The list
   * is read page by page; one already gone counts as deleted. A URL under the
   * prefix is ours by construction: the door's path names this source, and
   * no other tool is ever told to post there.
   */
  async deleteOurEndpoints(
    tool: FleetTool,
    key: string,
    workspaceId: string,
    urlPrefix: string,
    opts: {
      keep?: string | undefined;
      also?: string | null | undefined;
      budget?: SiblingBudget | undefined;
    } = {}
  ): Promise<SiblingOutcome<number>> {
    const ours = new Set<string>();
    if (opts.also && opts.also !== opts.keep) ours.add(opts.also);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.call(tool, 'GET', `/webhooks${query}`, {
        key,
        workspaceId,
        budget: opts.budget
      });
      if (res.kind !== 'ok') return res;
      if (res.response.status !== 200) return this.refusal(tool, res.response, 'list its endpoints');
      const body = endpointsPage.safeParse(await res.response.json().catch(() => null));
      if (!body.success) {
        return { kind: 'unavailable', message: `${tool.name}’s endpoint list was off the contract` };
      }
      for (const e of body.data.webhooks) {
        if (e.id !== opts.keep && e.url.startsWith(urlPrefix)) ours.add(e.id);
      }
      cursor = body.data.nextCursor;
      if (!cursor) break;
    }
    for (const id of ours) {
      const gone = await this.deleteEndpoint(tool, key, workspaceId, id, opts.budget);
      if (gone.kind !== 'ok') return gone;
    }
    return { kind: 'ok', value: ours.size };
  }

  /** Delete an endpoint on the sibling; one already gone (404) counts as deleted. */
  async deleteEndpoint(
    tool: FleetTool,
    key: string,
    workspaceId: string,
    endpointId: string,
    budget?: SiblingBudget
  ): Promise<SiblingOutcome<void>> {
    const res = await this.call(tool, 'DELETE', `/webhooks/${encodeURIComponent(endpointId)}`, {
      key,
      workspaceId,
      budget
    });
    if (res.kind !== 'ok') return res;
    if (res.response.status === 200 || res.response.status === 204 || res.response.status === 404) {
      return { kind: 'ok', value: undefined };
    }
    return this.refusal(tool, res.response, 'delete the endpoint');
  }

  private async refusal(tool: FleetTool, response: Response, act: string): Promise<SiblingRefusal> {
    if (response.status >= 500) {
      return { kind: 'unavailable', message: `${tool.name} answered ${response.status} to ${act}` };
    }
    const { code, message } = await readError(response);
    this.deps.logger.warn({ status: response.status, code, sibling: tool.slug, act }, 'sibling refused');
    return { kind: 'sibling_refused', message: `${tool.name} would not ${act}: ${message}` };
  }

  private async call(
    tool: FleetTool,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      key?: string | undefined;
      workspaceId?: string | undefined;
      body?: unknown;
      budget?: SiblingBudget | undefined;
    } = {}
  ): Promise<{ kind: 'ok'; response: Response } | { kind: 'unavailable'; message: string }> {
    const signal = this.signal(opts.budget);
    if (!signal) return { kind: 'unavailable', message: 'the connect took too long' };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    if (opts.workspaceId) headers['x-workspace-id'] = opts.workspaceId;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await this.fetchImpl(`${SiblingConnector.apiOrigin(tool)}/api/v1${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        redirect: 'error',
        signal
      });
      return { kind: 'ok', response };
    } catch (err) {
      this.deps.logger.warn({ err, sibling: tool.slug, path }, 'the sibling did not answer');
      return { kind: 'unavailable', message: `${tool.name} did not answer` };
    }
  }
}
