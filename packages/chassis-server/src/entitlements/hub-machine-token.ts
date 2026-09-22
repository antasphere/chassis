import { USAGE_WRITE_SCOPE } from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';

/**
 * The tool → hub MACHINE identity (the billing rail spec, §6): a
 * `client_credentials` token minted on the instance's own registry client
 * (`HUB_CLIENT_ID` / `HUB_CLIENT_SECRET`) with the single scope
 * `usage:write`. It carries a client and no subject; the hub refuses every
 * route but `/usage/*` to it, so the only trust it carries is "this tool
 * says this account did this" — it cannot read an organization, a user or a
 * grant, which is what keeps ADR 014's "no service key" stance intact.
 *
 * Cached until shortly before expiry and minted single-flight: concurrent
 * batches share one mint, and a 401 from the hub invalidates the cache so
 * the next call mints again (`invalidate()`).
 */
export const HUB_USAGE_SCOPE = USAGE_WRITE_SCOPE;

/** How long a failed mint is held before the hub is asked again: one attempt per instance per window during an outage. */
export const DEFAULT_FAILURE_HOLD_MS = 5_000;

export interface HubMachineTokenOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** RFC 8707 `resource`: the hub's own API resource (`<hub>/mcp`), the aud the hub mints for its `/usage/*`. */
  resource: string;
  logger: Logger;
  /** Token-endpoint budget per mint. */
  timeoutMs?: number | undefined;
  /** Re-mint this many ms before the hub's `expires_in` runs out. */
  refreshSkewMs?: number | undefined;
  /** How long a failed mint is held before the hub is asked again (the negative cache). */
  failureHoldMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export class HubMachineTokenError extends Error {
  constructor(
    message: string,
    /** `invalid_client` = the credentials are wrong (never retried into a loop); `transient` = try again later. */
    public readonly kind: 'invalid_client' | 'transient'
  ) {
    super(message);
    this.name = 'HubMachineTokenError';
  }
}

export class HubMachineToken {
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly refreshSkewMs: number;
  private readonly failureHoldMs: number;
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;
  /**
   * The negative cache: after a mint fails, `get()` throws at once until this
   * moment instead of re-asking the hub. During an outage the first metered
   * request of every account per TTL would otherwise pay the token timeout
   * again; with it, one attempt per `failureHoldMs` for the whole instance.
   */
  private failedUntilMs = 0;
  private lastFailure: HubMachineTokenError | null = null;
  /** How many mints reached the hub — a test seam (single-flight, refresh). */
  mints = 0;

  constructor(private readonly opts: HubMachineTokenOptions) {
    this.tokenUrl = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/auth/oauth2/token';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
    this.failureHoldMs = opts.failureHoldMs ?? DEFAULT_FAILURE_HOLD_MS;
  }

  /** The current token, minted or refreshed as needed. Throws `HubMachineTokenError`. */
  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.refreshSkewMs > this.now()) return this.cached.token;
    // Inside the skew window the token is still live at the hub: a refresh
    // that fails serves it rather than the failure, until it really expires.
    const stillLive = this.cached && this.cached.expiresAtMs > this.now() ? this.cached.token : null;
    if (this.lastFailure && this.failedUntilMs > this.now()) {
      if (stillLive) return stillLive;
      throw this.lastFailure;
    }
    if (!this.inflight) {
      this.inflight = this.mint()
        .then((token) => {
          this.lastFailure = null;
          return token;
        })
        .catch((cause: unknown) => {
          const failure =
            cause instanceof HubMachineTokenError
              ? cause
              : new HubMachineTokenError(String(cause), 'transient');
          this.lastFailure = failure;
          this.failedUntilMs = this.now() + this.failureHoldMs;
          throw failure;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    if (!stillLive) return this.inflight;
    return this.inflight.catch(() => stillLive);
  }

  /** Forget the cached token (the hub answered 401 to it) and the held failure. */
  invalidate(): void {
    this.cached = null;
    this.lastFailure = null;
    this.failedUntilMs = 0;
  }

  private async mint(): Promise<string> {
    this.mints += 1;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: HUB_USAGE_SCOPE,
      resource: this.opts.resource
    });
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: `Basic ${basic}`
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub machine token: token endpoint unreachable');
      throw new HubMachineTokenError('hub token endpoint unreachable', 'transient');
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // classified by status below
    }
    if (res.ok) {
      const p = (payload ?? {}) as { access_token?: unknown; expires_in?: unknown };
      if (typeof p.access_token !== 'string' || !p.access_token) {
        this.opts.logger.warn('hub machine token: token endpoint 200 without an access_token — malformed');
        throw new HubMachineTokenError('malformed token answer', 'transient');
      }
      const expiresInS =
        typeof p.expires_in === 'number' && Number.isFinite(p.expires_in) && p.expires_in > 0
          ? p.expires_in
          : 300;
      this.cached = { token: p.access_token, expiresAtMs: this.now() + expiresInS * 1000 };
      return p.access_token;
    }
    const error = (payload as { error?: unknown } | null)?.error;
    // The hub's config-shaped refusals (PRDCT-2625): a wrong secret, a client
    // outside the registry, a scope that is not exactly usage:write, a
    // resource that is not the hub's. None heals by retrying; every one is
    // an operator's error, logged at error level.
    if (
      (res.status === 400 || res.status === 401) &&
      (error === 'invalid_client' ||
        error === 'unauthorized_client' ||
        error === 'invalid_scope' ||
        error === 'invalid_target')
    ) {
      this.opts.logger.error(
        { error },
        'hub machine token: the hub refuses this client — check HUB_CLIENT_ID/HUB_CLIENT_SECRET, the client\u2019s registry entry and its client_credentials grant'
      );
      throw new HubMachineTokenError(String(error), 'invalid_client');
    }
    this.opts.logger.warn(
      { status: res.status, error },
      'hub machine token: token endpoint answered non-2xx'
    );
    throw new HubMachineTokenError(`token endpoint answered ${res.status}`, 'transient');
  }
}
