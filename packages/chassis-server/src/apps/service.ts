import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { workspaces, type Db } from '@antasphere/chassis-db';
import type { AppsList, Principal } from '@antasphere/chassis-contract';
import type { GrantAccess } from '../identity/hub-grant.js';
import type { Logger } from '../logger.js';
import { HUB_APP_NAME, appsFromFile, readOrganization, safeHttpUrl, selectHubApps } from './select.js';

/**
 * The Apps page's list (`GET /apps`, PRDCT-3493): the other tools of the
 * person's organization, and the account that signs them in.
 *
 * On the cloud edition the hub is asked AS THE PERSON, with their own grant
 * (the chassis's `HubGrantService`, the same stored grant and the same
 * cross-replica refresh lock the reconciler uses): ONE call, `GET
 * <hub>/api/v1/me/apps` with `X-Workspace-Id` naming the workspace's hub
 * organization (`workspaces.central_account_id`), answers the catalogue as
 * the person sees it there (the restricted tools they may not see already
 * left out by the hub) with the access verdict per tool; the tools not open
 * are left out here. A SUSPENDED organization (the hub's `organization.status`)
 * is served as an empty list carrying the organization and its status, never
 * as the tools: the hub's contract says a tool's Apps service never serves
 * such a list, and the dashboard says why. The answer is held five minutes
 * per person and workspace. A grant that is missing or dead, a hub that does
 * not answer, a malformed body, or a workspace that is no hub organization
 * falls back to the operator's file, never to an error: the page is a
 * convenience, not an access decision (each tool still asks the hub when it
 * is opened).
 *
 * On a self-hosted instance the list is the operator's file (`APPS_FILE`),
 * read on every call; without one the page lists nothing.
 */

/** How long a person's hub answer is held. */
export const APPS_CACHE_TTL_MS = 5 * 60_000;
/** At most this many answers are held; the oldest goes first. */
const APPS_CACHE_MAX = 5_000;
/** The hub read's budget: the page waits on it. */
const HUB_TIMEOUT_MS = 3_000;

/** The as-the-person token source: what the page needs of the chassis's `HubGrantService`. */
export interface HubTokens {
  accessToken(userId: string): Promise<GrantAccess>;
  refresh(userId: string): Promise<GrantAccess>;
  invalidateAccess(userId: string): void;
}

export interface AppsServiceOptions {
  db: Db;
  logger: Logger;
  edition: 'oss' | 'cloud';
  /** HUB_ISSUER_URL (cloud). */
  hubIssuerUrl?: string | undefined;
  /** APPS_FILE. */
  appsFile?: string | undefined;
  /** This tool's own slug (the identity's): its card says "You are here". */
  selfSlug: string;
  /** The person's hub grant (cloud); null on a self-hosted instance. */
  tokens: HubTokens | null;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type HubRead = { kind: 'ok'; status: number; body: unknown } | { kind: 'fail' };

export class AppsService {
  private readonly cache = new Map<string, { at: number; value: AppsList }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly hubBase: string | null;

  constructor(private readonly opts: AppsServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.hubBase =
      opts.edition === 'cloud' && opts.hubIssuerUrl ? opts.hubIssuerUrl.replace(/\/+$/, '') : null;
  }

  /** The list for one person in one workspace. */
  async list(principal: Pick<Principal, 'userId' | 'workspaceId'>): Promise<AppsList> {
    const key = `${principal.userId}:${principal.workspaceId}`;
    const held = this.cache.get(key);
    if (held && this.now() - held.at < APPS_CACHE_TTL_MS) return held.value;

    const fromHub = await this.fromHub(principal);
    if (!fromHub) return this.fromFile();
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), value: fromHub });
    if (this.cache.size > APPS_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return fromHub;
  }

  /** The hub's card: the issuer on the cloud edition. */
  private cloudHub(): AppsList['hub'] {
    const url = this.hubBase ? safeHttpUrl(this.hubBase) : null;
    return url ? { url, name: HUB_APP_NAME } : null;
  }

  /** The operator's file; `none` without one, or when it cannot be read. */
  async fromFile(): Promise<AppsList> {
    const path = this.opts.appsFile;
    if (!path) return { apps: [], hub: this.cloudHub(), source: 'none' };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      this.opts.logger.warn(
        { err, path },
        'APPS_FILE could not be read as JSON — the Apps page lists nothing'
      );
      return { apps: [], hub: this.cloudHub(), source: 'none' };
    }
    const file = appsFromFile(raw, this.opts.selfSlug);
    if (file.rejected.length > 0) {
      this.opts.logger.warn({ path, rejected: file.rejected }, 'APPS_FILE entries left out of the Apps page');
    }
    return { apps: file.apps, hub: file.hub ?? this.cloudHub(), source: 'file' };
  }

  /**
   * The hub's answer, or null when the hub cannot be asked for this person
   * (no grant, a dead one, a workspace that is no hub organization, a hub
   * that does not answer or answers another shape): the file is read instead.
   */
  private async fromHub(principal: Pick<Principal, 'userId' | 'workspaceId'>): Promise<AppsList | null> {
    const tokens = this.opts.tokens;
    if (!this.hubBase || !tokens) return null;
    const [row] = await this.opts.db
      .select({ hubOrgId: workspaces.centralAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    const hubOrgId = row?.hubOrgId ?? null;
    if (!hubOrgId) return null;

    const access = await tokens.accessToken(principal.userId);
    if (access.kind !== 'ok') return null;

    // One forced refresh and one retry on a 401/403 (the stored token may be
    // stale): the chassis's own posture (hub-user-client.ts).
    let res = await this.get(access.accessToken, hubOrgId);
    if (res.kind === 'ok' && (res.status === 401 || res.status === 403)) {
      tokens.invalidateAccess(principal.userId);
      const refreshed = await tokens.refresh(principal.userId);
      if (refreshed.kind !== 'ok') return null;
      res = await this.get(refreshed.accessToken, hubOrgId);
    }
    if (res.kind !== 'ok' || res.status !== 200) {
      if (res.kind === 'ok') {
        this.opts.logger.warn(
          { status: res.status },
          'hub /me/apps answered non-200 — the Apps page reads the file'
        );
      }
      return null;
    }
    const apps = selectHubApps(res.body, this.opts.selfSlug);
    if (!apps) {
      this.opts.logger.warn('hub /me/apps carried no tools list — the Apps page reads the file');
      return null;
    }
    const organization = readOrganization(res.body);
    if (organization?.status === 'suspended') {
      this.opts.logger.info({ hubOrgId }, 'hub organization suspended — the Apps page lists nothing');
      return { apps: [], hub: this.cloudHub(), source: 'hub', organization };
    }
    return { apps, hub: this.cloudHub(), source: 'hub', ...(organization ? { organization } : {}) };
  }

  private async get(token: string, hubOrgId: string): Promise<HubRead> {
    try {
      const response = await this.fetchImpl(`${this.hubBase}/api/v1/me/apps`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-workspace-id': hubOrgId
        },
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS)
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { kind: 'ok', status: response.status, body };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub read for the Apps page failed');
      return { kind: 'fail' };
    }
  }
}
