import pg from 'pg';
import { Counter } from 'prom-client';
import { and, eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { account, hubGrantPresentations, type Db } from '@antasphere/chassis-db';
import type { Logger } from '../logger.js';
import { HUB_SSO_PROVIDER_ID } from './hub-sso.js';

/**
 * The per-user hub grant (internal/federation.md, live user-scoped federation):
 * a cloud tool holds each user's OWN `offline_access account:read` grant
 * (plus `orgs:create` since PRDCT-2443 — hub-sso.ts HUB_SSO_SCOPES)
 * — obtained at SSO login, persisted by Better Auth on the `account` row —
 * and refreshes it against the hub's token endpoint to mint HUB-audienced
 * access tokens (`resource=<hub>/mcp`, RFC 8707) that the hub's own
 * `/api/v1` accepts. Everything the tool reads from the hub between logins
 * is read AS THE USER with this grant; no service key exists anywhere in
 * the user-facing path.
 *
 * Storage: the `account` row is the ONLY durable store (Better Auth already
 * re-writes both tokens at every browser SSO login — the self-healing
 * `hub_grant_expired` recovery path). With `account.encryptOAuthTokens: true`
 * (identity/better-auth.ts) Better Auth encrypts what IT writes; this
 * service encrypts/decrypts with the SAME primitive and the SAME key
 * (`(await auth.$context).secretConfig` — with our string-secret config that
 * is exactly the boot AUTH_SECRET), so the two writers are byte-compatible.
 * Legacy plaintext rows pass through decrypt untouched (the 1.6.15
 * `isLikelyEncrypted` rule, mirrored below).
 *
 * ── SECURITY-CRITICAL: refresh serialization ─────────────────────────────
 * The hub rotates refresh tokens on EVERY use with RFC 9700 reuse
 * detection: presenting a rotated-out token tears down the user's whole
 * (client,user) grant family. A cross-replica double-refresh is therefore
 * not a race, it is a GRANT-KILLING event. Discipline, in layers:
 *
 *  1. in-process single-flight per user (Map<userId, Promise>);
 *  2. a cross-replica session-scoped `pg_advisory_lock(7432004,
 *     hashtext(userId))` on a DEDICATED pg client (the accounts/deletion.ts
 *     OWNER_GUARD_LOCK pattern). The two-int form keys a DIFFERENT advisory
 *     lock space than pg-boss's single-int `pg_advisory_lock(7432004)`
 *     (classid 7432004/objsubid 2 vs classid 0/objsubid 1) — no collision;
 *  3. RE-READ AFTER LOCK: another replica may have refreshed while we
 *     waited — a changed refresh token (or a now-fresh stored access token)
 *     means we consume ITS result instead of presenting the stale token;
 *  4. a ~10 s watchdog cuts the dedicated connection so a wedged refresh
 *     can never park the lock forever (a session lock dies with its
 *     session);
 *  5. AMBIGUOUS OUTCOMES NEVER RE-PRESENT BLINDLY (PRDCT-1370). The hub
 *     rotates BEFORE it answers and cannot roll back, so a client-side
 *     timeout (or a lost response, or a 5xx after the commit) leaves us
 *     holding a token the hub may already have rotated out — and presenting
 *     it again is exactly the reuse-detection teardown above, reachable
 *     with no attacker, only a hub that is slow but alive. Every
 *     presentation is therefore recorded FIRST (`hub_grant_presentations`,
 *     keyed by the account row, carrying the ciphertext presented) and the
 *     record is cleared only once the hub's answer is known. A surviving
 *     record makes the next refresh PROBE the token through the hub's
 *     RFC 7662 introspection endpoint (`token_type_hint=refresh_token`,
 *     read-only: the pinned plugin answers `active:false` for a rotated-out
 *     token WITHOUT tearing the family down) and present it only when the
 *     hub still calls it active; an inactive answer marks the grant dead
 *     without ever presenting — the family, the CLI grant included, lives
 *     on at the hub and a browser SSO login heals this user.
 *
 * Failure taxonomy (the token endpoint's answer decides):
 *  - `invalid_grant` (expired / revoked / reuse-detected) → the grant is
 *    DEAD: tokens on the row are nulled (dead marker = refreshToken IS
 *    NULL); callers surface 401 `hub_grant_expired`; the next browser SSO
 *    login re-seeds the row and heals it.
 *  - `invalid_client` (broken client secret = OUR misconfiguration) →
 *    transient, logged LOUD, and it never kills grants — a config mistake
 *    must not mass-destroy every user's grant.
 *  - network / timeout / 5xx / malformed → transient (inconclusive).
 *
 * Access tokens are cached in-memory to exp − accessSkewMs; the account
 * row's stored access token is trusted while fresh (it was minted with the
 * same `resource` by either the login exchange or a sibling replica's
 * refresh). An oss boot never constructs this class.
 */

/** Advisory-lock classid for the per-user refresh lock (two-int form). */
const GRANT_REFRESH_LOCK_KEY = 7_432_004;
/** Headroom the lock watchdog keeps beyond probe + presentation (row reads/writes, lock latency). */
export const LOCK_WATCHDOG_HEADROOM_MS = 2_000;

export interface HubGrantDials {
  /** Serve cached/stored access tokens only while exp − now exceeds this. */
  accessSkewMs: number;
  /** Token-endpoint fetch timeout. */
  tokenTimeoutMs: number;
  /** Introspection-probe fetch timeout (the unanswered-presentation path). */
  introspectTimeoutMs: number;
  /** Watchdog cutting the dedicated lock connection (wedged-refresh bound). */
  lockWatchdogMs: number;
}

export const DEFAULT_GRANT_DIALS: HubGrantDials = {
  accessSkewMs: 60_000,
  tokenTimeoutMs: 5_000,
  introspectTimeoutMs: 5_000,
  // ≥ tokenTimeoutMs + introspectTimeoutMs + LOCK_WATCHDOG_HEADROOM_MS; the
  // constructor clamps anything smaller (see there).
  lockWatchdogMs: 12_000
};

/**
 * One answer about a user's hub access.
 *  - 'ok': a hub-callable access token.
 *  - 'no_link': the user holds no hub identity at all (a purely local user)
 *    — nothing to refresh, and that IS the definitive answer.
 *  - 'grant_dead': the stored refresh token is gone (revoked / expired /
 *    reuse-torn-down, or never granted — e.g. a cli-connect JIT without the
 *    Stage F grant channel). Only a browser SSO login heals this.
 *  - 'inconclusive': transient failure; nothing was destroyed.
 */
export type GrantAccess =
  | { kind: 'ok'; accessToken: string }
  | { kind: 'no_link' }
  | { kind: 'grant_dead' }
  | { kind: 'inconclusive' };

/** Key material for the symmetric token encryption (Better Auth's own). */
type SecretKeyMaterial = Parameters<typeof symmetricEncrypt>[0]['key'];

export interface HubGrantServiceOptions {
  db: Db;
  /** Hub OIDC issuer (HUB_ISSUER_URL) — the token endpoint derives from it. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * RFC 8707 `resource` sent on every refresh — `<hub>/mcp`, so the hub
   * mints a JWT its own /api/v1 accepts. THE seam constant: boot passes the
   * same value into the SSO code exchange (hub-sso.ts), and flipping it to
   * null here (if the hub ever accepts opaque tokens) is a one-line change.
   */
  tokenResource: string | null;
  /**
   * Better Auth's token-encryption key material — `(await
   * auth.$context).secretConfig`. Lazy because the auth context resolves
   * async; with our config it equals the boot AUTH_SECRET.
   */
  key: () => Promise<SecretKeyMaterial>;
  /** Dedicated advisory-lock connections (the migrate.ts / deletion.ts pattern). */
  connectionString: string;
  logger: Logger;
  dials: HubGrantDials;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface GrantRow {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

interface RefreshLock {
  client: pg.Client;
  released: boolean;
  watchdog?: NodeJS.Timeout;
}

/**
 * Mirror of Better Auth 1.6.15's `isLikelyEncrypted` (dist/oauth2/utils.mjs):
 * its decrypt path passes LEGACY PLAINTEXT tokens through untouched, and so
 * must ours — enabling encryption must never brick pre-existing grants.
 * Exported for hub-logout.ts, whose id_token read mirrors the same
 * tolerant rule. Re-verify on any Better Auth bump.
 */
export function isLikelyEncrypted(token: string): boolean {
  if (token.startsWith('$ba$')) return true;
  return token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token);
}

type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; expiresAt: Date; refreshToken: string | null }
  | { kind: 'invalid_grant' }
  | { kind: 'invalid_client' }
  | { kind: 'transient' };

/** The RFC 7662 probe's answer about a refresh token the hub never confirmed consuming. */
type ProbeOutcome = 'active' | 'inactive' | 'transient';

export class HubGrantService {
  /** userId → fresh access token (in-memory only; the row is the durable store). */
  private readonly cache = new Map<string, { token: string; expiresAtMs: number }>();
  private readonly inFlight = new Map<string, Promise<GrantAccess>>();
  private readonly tokenUrl: string;
  private readonly introspectUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  readonly dials: HubGrantDials;

  /** Registered into the Prometheus registry by boot (cloud only). */
  readonly promMetrics: Counter[];
  private readonly refreshes: Counter;

  constructor(private readonly opts: HubGrantServiceOptions) {
    this.tokenUrl = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/auth/oauth2/token';
    this.introspectUrl = opts.issuerUrl.replace(/\/+$/, '') + '/api/v1/auth/oauth2/introspect';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    // THE WATCHDOG MUST OUTLIVE THE LONGEST HOLD (PRDCT-1370 verifier
    // finding): under the lock a refresh may now run the probe AND the
    // presentation back to back, each up to its own timeout, plus the
    // row reads and writes around them. A watchdog shorter than that cuts
    // the lock mid-refresh, a sibling replica takes it and presents the
    // SAME token — the double presentation the lock exists to prevent, and
    // a family teardown at the hub. Clamped here, at the one place the
    // dials are read, so no caller can under-size it.
    const floor = opts.dials.tokenTimeoutMs + opts.dials.introspectTimeoutMs + LOCK_WATCHDOG_HEADROOM_MS;
    this.dials = opts.dials.lockWatchdogMs >= floor ? opts.dials : { ...opts.dials, lockWatchdogMs: floor };
    if (this.dials !== opts.dials) {
      opts.logger.warn(
        { requested: opts.dials.lockWatchdogMs, effective: floor },
        'hub grant: lockWatchdogMs raised to cover probe + presentation under the lock'
      );
    }
    // registers: [] — boot attaches this to the app registry on cloud; an
    // oss boot never constructs this class, so the metric never exists there.
    this.refreshes = new Counter({
      name: 'hub_grant_refreshes_total',
      help: 'Hub user-grant refresh attempts by outcome',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.promMetrics = [this.refreshes];
  }

  /**
   * Store the H3 offline grant — the raw one-time `hubRefreshToken` from
   * the hub's `POST /sso/tool-token` response, delivered through
   * `/sso/cli-connect` — on the user's `antasphere` account row, encrypted
   * with the SAME primitive + key as every Better Auth write, so the
   * ordinary refresh path consumes it exactly like a browser-SSO grant.
   * This is what gives a HEADLESS CLI user live as-the-user org reads
   * between browser logins (and replaces the Stage E interim, where a
   * connect-minted key answered 401 hub_grant_expired until one browser
   * SSO).
   *
   * Overwrites any previous grant unconditionally: the H3 mint is the
   * NEWEST valid credential, and the replaced family simply idles to expiry
   * at the hub. The stored access token is cleared (the new grant has none
   * yet); the caller VALIDATES the grant end-to-end by running the
   * fail-closed connect reconcile right after — a garbage token surfaces as
   * `grant_dead` there and no key is minted.
   *
   * Throws when the user holds no `antasphere` account row — the connect
   * flow provisions the link BEFORE acquiring the grant, so that is a
   * wiring bug, never a user state.
   */
  async acquireFromConnect(userId: string, rawRefreshToken: string): Promise<void> {
    const key = await this.opts.key();
    const encrypted = await symmetricEncrypt({ key, data: rawRefreshToken });
    const updated = await this.opts.db
      .update(account)
      .set({
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshToken: encrypted,
        refreshTokenExpiresAt: null,
        updatedAt: new Date()
      })
      .where(and(eq(account.userId, userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .returning({ id: account.id });
    if (updated.length === 0) {
      throw new Error('acquireFromConnect: no antasphere account row to store the grant on');
    }
    this.cache.delete(userId);
  }

  /**
   * Whether a stored (possibly stale) grant exists — the connect route's
   * born-dead guard for requests that carry no hubRefreshToken: with no
   * stored grant either, minting a key would strand it on
   * hub_grant_expired, so the connect refuses with steering instead.
   */
  async hasStoredGrant(userId: string): Promise<boolean> {
    const row = await this.readRow(userId);
    return Boolean(row?.refreshToken);
  }

  /**
   * Seed the in-memory cache with the SSO callback's access token (already
   * hub-audienced — the code exchange sends the same `resource`), so the
   * login-path reads and the first post-login requests need no refresh.
   */
  prime(userId: string, accessToken: string, expiresAt: Date | null): void {
    // Without a stated expiry, assume a conservative slice of the hub's
    // 15-minute access tokens.
    const expiresAtMs = expiresAt?.getTime() ?? this.now() + 5 * 60_000;
    this.cache.set(userId, { token: accessToken, expiresAtMs });
  }

  /** Drop the cached access token (e.g. the hub just refused it). */
  invalidateAccess(userId: string): void {
    this.cache.delete(userId);
  }

  /** A hub-callable access token for the user, refresh-on-demand. */
  async accessToken(userId: string): Promise<GrantAccess> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAtMs - this.now() > this.dials.accessSkewMs) {
      return { kind: 'ok', accessToken: cached.token };
    }
    return this.acquire(userId, false);
  }

  /**
   * Force a refresh (the caller saw the hub refuse the current token).
   * Serialized behind any in-flight acquisition; the advisory lock +
   * re-read-after-lock still guarantee at most one live rotation.
   */
  async refresh(userId: string): Promise<GrantAccess> {
    this.cache.delete(userId);
    const existing = this.inFlight.get(userId);
    if (existing) await existing.catch(() => {});
    return this.acquire(userId, true);
  }

  private acquire(userId: string, force: boolean): Promise<GrantAccess> {
    let flight = this.inFlight.get(userId);
    if (!flight) {
      flight = this.doAcquire(userId, force).finally(() => {
        if (this.inFlight.get(userId) === flight) this.inFlight.delete(userId);
      });
      this.inFlight.set(userId, flight);
    }
    return flight;
  }

  private async doAcquire(userId: string, force: boolean): Promise<GrantAccess> {
    try {
      const first = await this.readRow(userId);
      if (!first) return { kind: 'no_link' };
      if (!first.refreshToken) return { kind: 'grant_dead' };

      if (!force) {
        const stored = await this.storedAccess(userId, first);
        if (stored) return { kind: 'ok', accessToken: stored };
      }

      // Slow path: rotate under the cross-replica lock.
      const lock = await this.acquireLock(userId);
      try {
        // RE-READ AFTER LOCK: a sibling replica (or a concurrent browser
        // login) may have rotated while we waited. A changed refresh token
        // means ITS access token is brand new — consume that instead of
        // presenting our stale copy (which reuse detection would treat as
        // an attack and kill the whole family).
        const row = await this.readRow(userId);
        if (!row) return { kind: 'no_link' };
        if (!row.refreshToken) return { kind: 'grant_dead' };
        if (!force || row.refreshToken !== first.refreshToken) {
          const stored = await this.storedAccess(userId, row);
          if (stored) return { kind: 'ok', accessToken: stored };
        }

        let refreshToken: string;
        try {
          refreshToken = await this.decrypt(row.refreshToken);
        } catch (err) {
          // Undecryptable ≠ revoked: a key/config problem must never null
          // the row (the invalid_client stance). Loud, transient.
          this.refreshes.inc({ outcome: 'error' });
          this.opts.logger.error(
            { err, userId },
            'hub grant: stored refresh token failed to decrypt — check AUTH_SECRET continuity; failing transient'
          );
          return { kind: 'inconclusive' };
        }

        // An UNANSWERED earlier presentation of this very ciphertext (layer
        // 5): the hub may have rotated it out already. Probe, never guess.
        if (await this.hasUnansweredPresentation(row)) {
          const probe = await this.introspect(refreshToken);
          if (probe === 'inactive') {
            await this.markDead(row);
            await this.clearPresentation(row.id);
            this.cache.delete(userId);
            this.refreshes.inc({ outcome: 'probe_dead' });
            this.opts.logger.warn(
              { userId },
              'hub grant: an earlier refresh went unanswered and the hub now reports the token inactive — ' +
                'grant marked dead WITHOUT re-presenting (the family survives at the hub); a browser SSO login heals it'
            );
            return { kind: 'grant_dead' };
          }
          if (probe === 'transient') {
            this.refreshes.inc({ outcome: 'probe_transient' });
            return { kind: 'inconclusive' };
          }
          this.refreshes.inc({ outcome: 'probe_live' });
          // active: the unanswered presentation never reached the hub —
          // presenting again is safe, and the record below is renewed.
        }

        // Record the presentation BEFORE the fetch: if the answer never
        // arrives, this row is what makes the next attempt probe first.
        await this.recordPresentation(row);
        const outcome = await this.postRefresh(refreshToken);
        if (outcome.kind === 'ok') {
          await this.writeRotation(row, outcome);
          await this.clearPresentation(row.id);
          this.cache.set(userId, { token: outcome.accessToken, expiresAtMs: outcome.expiresAt.getTime() });
          this.refreshes.inc({ outcome: 'ok' });
          return { kind: 'ok', accessToken: outcome.accessToken };
        }
        if (outcome.kind === 'invalid_grant') {
          // Definitive: expired, revoked, or reuse-torn-down.
          await this.markDead(row);
          await this.clearPresentation(row.id);
          this.cache.delete(userId);
          this.refreshes.inc({ outcome: 'invalid_grant' });
          this.opts.logger.warn(
            { userId },
            'hub grant: token endpoint answered invalid_grant — grant marked dead; a browser SSO login heals it'
          );
          return { kind: 'grant_dead' };
        }
        if (outcome.kind === 'invalid_client') {
          // The hub answered, and it refused the CLIENT before touching the
          // token (the pinned plugin validates client credentials before it
          // rotates), so the presented token was not consumed: the record
          // is cleared, not kept.
          await this.clearPresentation(row.id);
          this.refreshes.inc({ outcome: 'invalid_client' });
          this.opts.logger.error(
            'hub grant: token endpoint answered invalid_client — HUB_CLIENT_ID/HUB_CLIENT_SECRET are broken; ' +
              'refreshes are failing transient (grants are NOT being killed); fix the client credentials'
          );
          return { kind: 'inconclusive' };
        }
        // Transient (timeout / network / 5xx / malformed): the answer is
        // UNKNOWN, so the presentation record deliberately survives — the
        // next attempt probes before it presents.
        this.refreshes.inc({ outcome: 'error' });
        return { kind: 'inconclusive' };
      } finally {
        await this.releaseLock(lock);
      }
    } catch (err) {
      this.refreshes.inc({ outcome: 'error' });
      this.opts.logger.warn({ err, userId }, 'hub grant: refresh attempt failed — failing transient');
      return { kind: 'inconclusive' };
    }
  }

  /** The user's hub account link, tokens as stored (possibly encrypted). */
  /**
   * Null the tokens (dead marker = refreshToken IS NULL) — CONDITIONAL on
   * the ciphertext we hold, so a browser login that re-seeded the row
   * mid-flight is never wiped.
   */
  private async markDead(row: GrantRow): Promise<void> {
    await this.opts.db
      .update(account)
      .set({
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        updatedAt: new Date()
      })
      .where(and(eq(account.id, row.id), eq(account.refreshToken, row.refreshToken!)));
  }

  /** Whether an earlier presentation of THIS ciphertext is still unanswered. */
  private async hasUnansweredPresentation(row: GrantRow): Promise<boolean> {
    const [marker] = await this.opts.db
      .select({ refreshToken: hubGrantPresentations.refreshToken })
      .from(hubGrantPresentations)
      .where(eq(hubGrantPresentations.accountId, row.id))
      .limit(1);
    // A marker for a DIFFERENT ciphertext is stale by construction (a
    // browser login re-seeded the row): the token it names is gone.
    return marker !== undefined && marker.refreshToken === row.refreshToken;
  }

  private async recordPresentation(row: GrantRow): Promise<void> {
    await this.opts.db
      .insert(hubGrantPresentations)
      .values({ accountId: row.id, refreshToken: row.refreshToken!, presentedAt: new Date() })
      .onConflictDoUpdate({
        target: hubGrantPresentations.accountId,
        set: { refreshToken: row.refreshToken!, presentedAt: new Date() }
      });
  }

  private async clearPresentation(accountId: string): Promise<void> {
    await this.opts.db.delete(hubGrantPresentations).where(eq(hubGrantPresentations.accountId, accountId));
  }

  /**
   * RFC 7662 probe of a refresh token whose last presentation went
   * unanswered. Read-only at the hub: the pinned oauth-provider plugin's
   * introspection answers `active:false` for a rotated-out, expired, or
   * unknown refresh token and never touches the family. Anything but a
   * definite answer is transient — a probe must never be the reason a
   * grant dies.
   */
  private async introspect(refreshToken: string): Promise<ProbeOutcome> {
    const body = new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.introspectUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.dials.introspectTimeoutMs)
      });
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub grant: introspection endpoint unreachable — probe inconclusive');
      return 'transient';
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // classified below by status
    }
    if (res.ok) {
      const active = (payload as { active?: unknown } | null)?.active;
      if (active === true) return 'active';
      if (active === false) return 'inactive';
      this.opts.logger.warn(
        'hub grant: introspection 200 without a boolean `active` — malformed, probe inconclusive'
      );
      return 'transient';
    }
    if (res.status === 401) {
      this.opts.logger.error(
        'hub grant: introspection answered invalid_client — HUB_CLIENT_ID/HUB_CLIENT_SECRET are broken; probe inconclusive'
      );
      return 'transient';
    }
    this.opts.logger.warn(
      { status: res.status },
      'hub grant: introspection answered non-2xx — probe inconclusive'
    );
    return 'transient';
  }

  private async readRow(userId: string): Promise<GrantRow | null> {
    const [row] = await this.opts.db
      .select({
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt
      })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .limit(1);
    return row ?? null;
  }

  /** Decrypt-and-cache the row's access token when it is still fresh. */
  private async storedAccess(userId: string, row: GrantRow): Promise<string | null> {
    if (!row.accessToken || !row.accessTokenExpiresAt) return null;
    const expiresAtMs = row.accessTokenExpiresAt.getTime();
    if (expiresAtMs - this.now() <= this.dials.accessSkewMs) return null;
    try {
      const token = await this.decrypt(row.accessToken);
      this.cache.set(userId, { token, expiresAtMs });
      return token;
    } catch (err) {
      this.opts.logger.warn({ err, userId }, 'hub grant: stored access token failed to decrypt — refreshing');
      return null;
    }
  }

  /**
   * Persist a rotation's result on the row, Better-Auth-compatible
   * (encrypted with the same key + primitive setTokenUtil uses).
   * Conditional on the ciphertext we rotated FROM: if a concurrent browser
   * login re-wrote the row, its (equally valid, same-family) tokens win and
   * our rotation is only served from memory.
   */
  private async writeRotation(
    row: GrantRow,
    outcome: Extract<RefreshOutcome, { kind: 'ok' }>
  ): Promise<void> {
    const key = await this.opts.key();
    const encryptedAccess = await symmetricEncrypt({ key, data: outcome.accessToken });
    const encryptedRefresh = outcome.refreshToken
      ? await symmetricEncrypt({ key, data: outcome.refreshToken })
      : row.refreshToken; // no rotation in the answer — keep the presented one
    await this.opts.db
      .update(account)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        accessTokenExpiresAt: outcome.expiresAt,
        updatedAt: new Date()
      })
      .where(and(eq(account.id, row.id), eq(account.refreshToken, row.refreshToken!)));
  }

  private async decrypt(stored: string): Promise<string> {
    if (!isLikelyEncrypted(stored)) return stored; // legacy plaintext passthrough
    return symmetricDecrypt({ key: await this.opts.key(), data: stored });
  }

  /** One refresh_token grant POST, classified per the failure taxonomy. */
  private async postRefresh(refreshToken: string): Promise<RefreshOutcome> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret
    });
    if (this.opts.tokenResource) body.set('resource', this.opts.tokenResource);
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.dials.tokenTimeoutMs)
      });
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub grant: token endpoint unreachable');
      return { kind: 'transient' };
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // fall through — classified below by status
    }
    if (res.ok) {
      const p = (payload ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof p.access_token !== 'string' || !p.access_token) {
        this.opts.logger.warn('hub grant: token endpoint 200 without an access_token — malformed');
        return { kind: 'transient' };
      }
      const expiresInS =
        typeof p.expires_in === 'number' && Number.isFinite(p.expires_in) && p.expires_in > 0
          ? p.expires_in
          : 300; // conservative default when the hub omits it
      return {
        kind: 'ok',
        accessToken: p.access_token,
        expiresAt: new Date(this.now() + expiresInS * 1000),
        refreshToken: typeof p.refresh_token === 'string' && p.refresh_token ? p.refresh_token : null
      };
    }
    // RFC 6749 errors ride 400/401; anything else (5xx…) is transient.
    if (res.status === 400 || res.status === 401) {
      const error = (payload as { error?: unknown } | null)?.error;
      if (error === 'invalid_grant') return { kind: 'invalid_grant' };
      if (error === 'invalid_client') return { kind: 'invalid_client' };
      this.opts.logger.warn({ status: res.status, error }, 'hub grant: unrecognized token-endpoint error');
      return { kind: 'transient' };
    }
    this.opts.logger.warn({ status: res.status }, 'hub grant: token endpoint answered non-2xx');
    return { kind: 'transient' };
  }

  /**
   * Session-scoped pg_advisory_lock on a dedicated client — never the pool
   * (a session lock parked on a pooled connection would poison the pool).
   * The watchdog cuts the connection after lockWatchdogMs; a session lock
   * dies with its session, so a wedged refresh is strictly bounded.
   */
  private async acquireLock(userId: string): Promise<RefreshLock> {
    const client = new pg.Client({ connectionString: this.opts.connectionString });
    await client.connect();
    const lock: RefreshLock = { client, released: false };
    lock.watchdog = setTimeout(() => {
      this.opts.logger.warn(
        { userId },
        'hub grant: refresh lock watchdog fired — cutting the dedicated connection'
      );
      lock.released = true;
      void client.end().catch(() => {});
    }, this.dials.lockWatchdogMs);
    lock.watchdog.unref();
    try {
      await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [GRANT_REFRESH_LOCK_KEY, userId]);
    } catch (cause) {
      await this.releaseLock(lock);
      throw cause;
    }
    return lock;
  }

  /** Idempotent; closing the client guarantees the session lock dies with it. */
  private async releaseLock(lock: RefreshLock): Promise<void> {
    if (lock.released) return;
    lock.released = true;
    if (lock.watchdog) clearTimeout(lock.watchdog);
    await lock.client.end().catch(() => {});
  }
}
