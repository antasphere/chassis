import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { ScopeRoutes } from './scope-routes.js';
import { apiKeys as apiKeysTable, ssoConnectJtis, workspaceMembers, type Db } from '@antasphere/chassis-db';
import type { Auth } from '../identity/better-auth.js';
import { HubSsoLoginError, type HubConnectAssertion, type HubSsoService } from '../identity/hub-sso.js';
import type { HubGrantService } from '../identity/hub-grant.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * CLI cross-tool connect (cloud edition ONLY — internal/federation.md P5):
 *
 *   POST /sso/cli-connect → verify a hub-minted 120 s exchange JWT (the H3
 *   counterpart), JIT-provision exactly like an SSO login, store the H3
 *   offline grant, reconcile fail-closed, mint a USER-scoped API key
 *
 * PUBLIC path (the hub JWT IS the credential — the invitation-lookup /
 * cli-auth tier-2 pattern), rate-limited on the login wall (api/index.ts),
 * and registered by api/index.ts ONLY when the instance boots EDITION=cloud
 * — an oss boot never mounts this module, so the path answers the JSON 404
 * terminator there (zero hub surface, matching every other cloud seam).
 *
 * Because the endpoint is public, verification discipline is the whole
 * game (a replayable exchange token mints N keys):
 *
 *  - the token passes `HubSsoService.verifyConnectToken` — hub-JWKS
 *    signature, iss pinned to the hub, aud pinned to OUR resource URL,
 *    RS256 only, expiry, `purpose: 'sso-connect'` required, `jti` required;
 *    its TRANSITIONAL org claims are never read (org truth = reconcile);
 *  - the `jti` is consumed ONE-TIME-USE via an INSERT into the Postgres
 *    `sso_connect_jtis` ledger — the primary-key conflict IS the replay
 *    signal, multi-replica safe by construction (finding G8). Claim-first
 *    discipline: the jti is burned BEFORE provisioning, so two concurrent
 *    presentations of one token can never both reach the mint (a
 *    transient provisioning failure costs the caller one fresh hub
 *    exchange — cheap, and the safe side of the race);
 *  - every verification failure (signature, iss, aud, purpose, expiry,
 *    replay) answers ONE uniform 401 — no oracle for probing tokens.
 *
 * On success the user is provisioned through the SAME HubSsoService path as
 * a browser SSO login (JIT user via the internal adapter — the user.created
 * hook and collaborator sweep fire — plus D9 trusted link, D10 email sync),
 * the request's `hubRefreshToken` (the raw H3 offline grant) is stored
 * encrypted on the account row (`acquireFromConnect` — the same row a
 * browser login writes), and the SAME fail-closed reconcile as a browser
 * login projects the user's orgs as-the-user. Only a definitive 'ok' pass
 * mints: the key is an ordinary USER-scoped API key (workspaceId null —
 * the org is a per-request parameter, like every credential), scopes
 * the tool's read + write — NEVER its export scope (the
 * CLI_KEY_SCOPES grant, same as /cli/auth/complete), named "Antasphere CLI
 * <date>", audited, returned once. A connect that can prove NO usable grant
 * (none carried, none stored, or the carried one is dead) refuses with
 * explicit steering instead of minting a born-dead key.
 */

export interface SsoConnectRouteDeps {
  db: Db;
  auth: Auth;
  hubSso: HubSsoService;
  /** The per-user hub grant store — the H3 `hubRefreshToken` lands here. */
  grant: HubGrantService;
  apiKeys: ApiKeyService;
  audit: AuditService;
  logger: Logger;
  /** The CLI key's fixed grant — the same list /cli/auth/complete mints with. */
  cliKeyScopes: readonly string[];
  /** The tool's instantiation of the scope-carrying connect route. */
  routes: Pick<ScopeRoutes, 'ssoCliConnectRoute'>;
}

const GRANT_MISSING_MESSAGE =
  'This exchange carried no usable hub grant for this instance — run `antasphere login` again with a ' +
  'current CLI (the hub issues a grant with every exchange), or sign in to this instance once in a browser ' +
  'with Antasphere.';

export function registerSsoConnectRoutes(api: OpenAPIHono, deps: SsoConnectRouteDeps): void {
  const { db, auth, hubSso, grant, apiKeys, audit, logger, cliKeyScopes } = deps;
  const { ssoCliConnectRoute } = deps.routes;

  api.openapi(ssoCliConnectRoute, async (c) => {
    const body = c.req.valid('json');

    // 1. Verify hard. One uniform 401 for every rejection reason.
    let assertion: HubConnectAssertion;
    try {
      assertion = await hubSso.verifyConnectToken(body.token);
    } catch (cause) {
      logger.warn({ err: cause }, 'sso cli-connect: exchange token rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 2. Burn the jti (one-time-use, G8). Insert-first: the claim precedes
    // any effect, so a replay — even a concurrent one — mints nothing. The
    // sweep keeps the ledger tiny; best-effort, never correctness-bearing
    // (expired rows only shadow jtis of already-expired tokens).
    void db
      .delete(ssoConnectJtis)
      .where(lt(ssoConnectJtis.expiresAt, sql`now() - interval '1 minute'`))
      .catch(() => {});
    const claimed = await db
      .insert(ssoConnectJtis)
      .values({ jti: assertion.jti, expiresAt: assertion.expiresAt })
      .onConflictDoNothing()
      .returning({ jti: ssoConnectJtis.jti });
    if (claimed.length === 0) {
      logger.warn({ jti: assertion.jti }, 'sso cli-connect: replayed jti rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 3. JIT-provision through the SSO path (identical rows; no projection
    // here — the reconcile below IS the projection).
    let provisioned: Awaited<ReturnType<HubSsoService['provisionConnect']>>;
    try {
      provisioned = await hubSso.provisionConnect(auth, assertion);
    } catch (cause) {
      if (cause instanceof HubSsoLoginError) {
        logger.warn({ err: cause, code: cause.code }, 'sso cli-connect: provisioning refused');
        return c.json(err(cause.code, 'Could not provision this account on the instance'), 403);
      }
      logger.error({ err: cause }, 'sso cli-connect: provisioning failed');
      return c.json(err('internal', 'Connect failed — try again'), 500);
    }
    const { user } = provisioned;

    // 4. The grant channel: store the H3 offline grant the request carried
    // (newest mint wins — the replaced family idles to expiry at the hub).
    // Without one, an already-stored grant (an earlier browser login or
    // connect) carries the day; with NEITHER, refuse with steering — a key
    // whose every org read would answer hub_grant_expired must not exist.
    if (body.hubRefreshToken) {
      try {
        await grant.acquireFromConnect(user.id, body.hubRefreshToken);
      } catch (cause) {
        logger.error({ err: cause }, 'sso cli-connect: storing the hub grant failed');
        return c.json(err('internal', 'Connect failed — try again'), 500);
      }
    } else if (!(await grant.hasStoredGrant(user.id))) {
      logger.warn({ userId: user.id }, 'sso cli-connect: no grant carried and none stored — refusing');
      return c.json(err('hub_grant_missing', GRANT_MISSING_MESSAGE), 403);
    }

    // 5. The fail-closed projection pass — the browser login's assertLogin
    // step 3, on the connect path: one forced reconcile AS THE USER with
    // the grant stored above. This is also what validates the presented
    // hubRefreshToken end-to-end (redeemed at the hub under OUR client
    // credentials); anything but a definitive 'ok' mints nothing.
    let outcome: Awaited<ReturnType<HubSsoService['reconcileConnect']>>;
    try {
      outcome = await hubSso.reconcileConnect(user.id);
    } catch (cause) {
      logger.error({ err: cause }, 'sso cli-connect: reconcile pass threw');
      return c.json(err('internal', 'Connect failed — try again'), 500);
    }
    if (outcome === 'grant_dead' || outcome === 'no_link') {
      // The carried/stored grant is definitively unusable (revoked,
      // expired, reuse-torn-down, or — no_link, unreachable after step 3 —
      // the link itself vanished). Same steering as carrying none.
      logger.warn({ userId: user.id, outcome }, 'sso cli-connect: grant unusable — refusing the mint');
      return c.json(err('hub_grant_missing', GRANT_MISSING_MESSAGE), 403);
    }
    if (outcome !== 'ok') {
      // Transient (hub unreachable / 5xx): nothing destroyed; the caller
      // re-exchanges. Never mint on a pass that proved nothing.
      logger.warn({ userId: user.id, outcome }, 'sso cli-connect: reconcile inconclusive — try again');
      return c.json(err('internal', 'Connect failed — try again'), 500);
    }

    // 5b. The reconciled truth must leave the key USABLE: a user-scoped key
    // resolves through the holder's active memberships, so zero of them
    // (e.g. the hub answered only unknown-role entries — D11 derives roles,
    // never maps them) would mint a born-dead key. Refuse instead; the
    // hub-side H3 gate makes this unreachable in the healthy contract.
    const hasActive = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.isActive, true)))
      .limit(1);
    if (hasActive.length === 0) {
      logger.warn({ userId: user.id }, 'sso cli-connect: reconcile left no usable membership — refusing');
      return c.json(
        err('no_membership', 'Your Antasphere account has no organization usable on this instance'),
        403
      );
    }

    // 6. Mint the ordinary local key — USER-scoped (no workspace pin): the
    // org is a per-request parameter authorized against the caller's live
    // memberships, exactly like every other credential.
    const name = `Antasphere CLI ${new Date().toISOString().slice(0, 10)}`;
    const minted = await apiKeys.mint({
      workspaceId: null,
      createdBy: user.id,
      name,
      scopes: [...cliKeyScopes],
      expiresAt: null
    });
    const [row] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, minted.id)).limit(1);
    if (!row) {
      return c.json(err('internal', 'Key mint failed — try again'), 500);
    }

    // Principal-less public route: the audit middleware cannot attribute it —
    // write the row directly, exactly like /cli/auth/complete does. The key
    // is a USER credential, so the row is INSTANCE-attributed (ADR 014).
    await audit.write({
      workspaceId: null,
      principal: { userId: user.id, via: 'session' },
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: minted.id,
      requestId: c.get('requestId'),
      metadata: {
        name,
        scopes: [...cliKeyScopes],
        via: 'sso_cli_connect',
        hubSub: assertion.sub,
        grantChannel: body.hubRefreshToken ? 'h3_exchange' : 'stored'
      }
    });

    return c.json(
      {
        key: minted.key,
        apiKey: {
          id: row.id,
          name: row.name,
          keyId: row.keyId,
          scopes: row.scopes as string[],
          workspaceId: row.workspaceId,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null
        },
        user,
        workspaceId: null
      },
      201
    );
  });
}
