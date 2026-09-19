import { migrationStatus, runMigrations } from '@antasphere/chassis-db/migrate';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Hono } from 'hono';
import { join } from 'node:path';
import type { z } from 'zod';
import { APIError } from 'better-auth/api';
import { AccountDeletionService, LastOwnerError } from './accounts/index.js';
import { ErasureLog } from './accounts/index.js';
import { createApiApp } from './api/create-api.js';
import { buildPepperRegistry } from './apikeys/index.js';
import { ApiKeyService } from './apikeys/index.js';
import { createApp } from './app.js';
import { AuditService } from './audit/index.js';
import { createEmailDriver } from './email/index.js';
import {
  buildChangeEmailConfirmEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail
} from './email/index.js';
import { hubConfig, parseEnv } from './env.js';
import { createAuth, mcpResourceUrl, type AccountEvent } from './identity/index.js';
import { HubSsoService } from './identity/index.js';
import { HubGrantService } from './identity/index.js';
import { HubLogoutService } from './identity/index.js';
import { hubApiResource, HubUserClient } from './identity/index.js';
import { DEFAULT_FEDERATION_DIALS, HubOrgReconciler, type HubFederationDials } from './identity/index.js';
import { OauthJwtVerifier } from './identity/index.js';
import { preflightSigningKey } from './identity/index.js';
import type { OnWorkspaceMiss } from './identity/index.js';
import { isApiKeyToken } from './apikeys/index.js';
import { mcpRoutes } from './mcp/index.js';
import { wellKnownRoutes } from './routes/index.js';
import { instanceSettings, user as userTable, workspaceMembers, workspaces } from '@antasphere/chassis-db';
import { FileService } from './files/index.js';
import { createJobs, PgBossUsageSink } from './jobs/index.js';
import { createLogger } from './logger.js';
import { createStorageDriver } from './storage/index.js';
import { createRateLimiters, makeClientIp, rateLimit } from './middleware/index.js';
import { hstsValue } from './middleware/index.js';
import { createMetrics } from './observability/index.js';
import { createOtel } from './observability/index.js';
import { bindEditionSeams } from './platform/index.js';
import { AllowAllEntitlements } from './platform/index.js';
import { EventBus } from './platform/index.js';
import { LocalIdentityProvider } from './platform/index.js';
import { createRegistry } from './platform/index.js';
import { NoopUsageSink } from './platform/index.js';
import { WorkspaceService } from './platform/index.js';
import { clearGeneratedSetupToken, resolveAuthSecret, resolveSetupToken } from './util/index.js';
import { createRuntimeState } from './util/index.js';
import type {
  BootOverrides,
  BootResult,
  PlatformCore,
  ServiceCore,
  ToolDefinition
} from './tool-definition.js';

/**
 * The boot sequence, in its locked order: env → logger → db probe → secret →
 * migrations under advisory lock → app assembly → ready.
 */
export async function bootPlatform<
  TEnvShape extends z.ZodRawShape,
  TDomain,
  TBuckets extends string,
  TEvents,
  TToolOverrides
>(
  tool: ToolDefinition<TEnvShape, TDomain, TBuckets, TEvents, TToolOverrides>,
  source: NodeJS.ProcessEnv = process.env,
  overrides: BootOverrides<TToolOverrides> = {}
): Promise<BootResult<TEnvShape, TDomain, TEvents>> {
  const env = parseEnv<TEnvShape>(source, {
    version: tool.runtime.version,
    ...(tool.env ? { extension: tool.env } : {})
  });
  const logger = createLogger(env);
  const state = createRuntimeState();

  logger.info({ serviceRole: env.SERVICE_ROLE, nodeEnv: env.NODE_ENV }, 'booting');

  state.reason = 'connecting to database';
  const db = tool.db(env.DATABASE_URL);
  await db.pool.query('SELECT 1');
  logger.info('database reachable');

  const authSecret = await resolveAuthSecret(env.AUTH_SECRET, env.DATA_DIR, logger);

  const migrationsFolder = tool.runtime.findMigrationsDir();
  let migrationsPending = false;
  /** The migration-stage reason /readyz must keep reporting (later stages overwrite state.reason). */
  let readinessRefusal: string | null = null;
  // Hash-based status FIRST, on every boot (OPS-6, PRDCT-1357): a database
  // carrying migrations this image does not ship was migrated by a NEWER
  // image — a rollback / `:next` behind `:latest`. drizzle's migrator would
  // happily consider it up to date (it compares timestamps), and a
  // count-based status called it "current". Refuse readiness instead: the
  // schema is ahead of the code, and the newer version's share links and
  // rows are exactly what the older code would corrupt.
  const preStatus = await migrationStatus({ connectionString: env.DATABASE_URL, migrationsFolder });
  if (preStatus.downgrade) {
    migrationsPending = true;
    state.reason =
      `database is AHEAD of this image: ${preStatus.unknownApplied} applied migration(s) this ` +
      `version does not ship (a downgrade, or edited migration files) — deploy the version that applied them`;
    readinessRefusal = state.reason;
    logger.error({ status: preStatus }, 'refusing readiness: ' + state.reason);
  } else if (env.AUTO_MIGRATE) {
    state.reason = 'applying migrations';
    await runMigrations({
      connectionString: env.DATABASE_URL,
      migrationsFolder,
      log: (msg) => logger.info({ scope: 'migrate' }, msg)
    });
  } else {
    const status = preStatus;
    migrationsPending = status.pending;
    if (status.pending) {
      state.reason = `migrations pending (${status.applied}/${status.onDisk} applied) and AUTO_MIGRATE=false`;
      readinessRefusal = state.reason;
      logger.error({ status }, 'refusing readiness: run migrations manually or set AUTO_MIGRATE=true');
      // The process stays up (healthz green) but /readyz keeps failing.
    } else {
      logger.info({ status }, 'migrations current (AUTO_MIGRATE=false)');
    }
  }

  // R7 edition-flip guard (internal/federation.md): EDITION selects the identity
  // binding, so flipping it under an already-set-up instance silently changes
  // who can log in and where workspace ownership is asserted. Setup stamps
  // the instance's edition; a boot whose env EDITION differs refuses to start
  // unless the operator explicitly acknowledges with EDITION_CHANGE_ALLOWED=true
  // (which re-stamps and proceeds). A fresh database (no instance row yet)
  // boots under any edition — cloud instances start from a fresh DB. The
  // stamp is compared whenever it is READABLE — including while migrations
  // are pending (readiness is red then, but the API still serves, so a
  // skipped guard would be one whole mis-bound boot). Only a schema that
  // predates the stamp column (migration 0020, AUTO_MIGRATE=false) has no
  // stamp to compare; the first migrated boot enforces the guard.
  let stampedEdition: string | undefined;
  try {
    const [instanceRow] = await db.db
      .select({ edition: instanceSettings.edition })
      .from(instanceSettings)
      .limit(1);
    stampedEdition = instanceRow?.edition;
  } catch (cause) {
    if (!migrationsPending) throw cause;
    // Pending migrations + unreadable stamp: the edition column (or the
    // table) is not migrated in yet on this database — nothing to compare.
  }
  if (stampedEdition !== undefined && stampedEdition !== env.EDITION) {
    if (!env.EDITION_CHANGE_ALLOWED) {
      const message =
        `refusing to boot: EDITION=${env.EDITION} but this instance was set up as ` +
        `'${stampedEdition}'. An edition flip on a populated instance changes identity ` +
        `semantics for existing users and workspaces. If this is intentional, set ` +
        `EDITION_CHANGE_ALLOWED=true for ONE boot to re-stamp it (internal/federation.md).`;
      logger.error({ stamped: stampedEdition, env: env.EDITION }, message);
      await db.pool.end(); // clean refusal — no leaked pool for the caller
      throw new Error(message);
    }
    // Pre-flight (EDIT-1/3/4, PRDCT-1356): the acknowledgement alone is not
    // enough — a flip that migrates nothing leaves the cloud enforcement
    // model not applying to pre-flip data, so the flip is REFUSED unless the
    // instance is already in the shape the target edition requires.
    const refuseFlip = async (reason: string) => {
      const message =
        `refusing the edition flip '${stampedEdition}' → '${env.EDITION}' (EDITION_CHANGE_ALLOWED=true): ` +
        reason;
      logger.error({ stamped: stampedEdition, env: env.EDITION }, message);
      await db.pool.end();
      throw new Error(message);
    };
    if (stampedEdition === 'cloud' && env.EDITION === 'oss') {
      // The reverse flip would leave every hub-minted session, OAuth grant
      // and hub-origin membership behind as unrevocable LOCAL credentials
      // (EDIT-4). Rebuild from a fresh database instead.
      await refuseFlip(
        'a cloud instance cannot be flipped back to oss — hub-minted credentials would become ' +
          'unrevocable local ones (internal/federation.md). Set up a fresh oss instance and restore data into it.'
      );
    }
    if (env.EDITION === 'cloud') {
      const [legacy] = await db.db
        .select({ n: count() })
        .from(workspaces)
        .where(isNull(workspaces.centralAccountId));
      if ((legacy?.n ?? 0) > 0) {
        // EDIT-1: a workspace without a hub projection is outside every
        // hub gate (HubLiveGate returns ok before any hub read) — the whole
        // cloud enforcement model would never apply to it.
        await refuseFlip(
          `${legacy?.n} workspace(s) carry no hub projection (central_account_id IS NULL). ` +
            'Project each one at the hub (or delete it) before flipping — cloud enforcement cannot cover an unprojected workspace.'
        );
      }
      const [unverified] = await db.db
        .select({ n: count() })
        .from(userTable)
        .where(eq(userTable.emailVerified, false));
      if ((unverified?.n ?? 0) > 0) {
        // EDIT-3: hub-only login links the trusted provider onto a VERIFIED
        // local email only; every unverified user would be locked out.
        await refuseFlip(
          `${unverified?.n} user(s) have an unverified email and would be locked out under hub-only login. ` +
            'Have them verify (or remove them) before flipping.'
        );
      }
    }
    await db.db.update(instanceSettings).set({ edition: env.EDITION });
    logger.warn(
      { from: stampedEdition, to: env.EDITION },
      'edition re-stamped (EDITION_CHANGE_ALLOWED=true) — unset the flag again after this boot'
    );
  } else if (env.EDITION_CHANGE_ALLOWED) {
    // A leftover acknowledgement must never rot silently: while the flag
    // stays set, the guard above is disarmed — any future EDITION change
    // would re-stamp without refusing. Say so on every boot.
    logger.warn(
      'EDITION_CHANGE_ALLOWED=true but no edition change is pending — unset it: while it stays ' +
        'set, the R7 edition-flip guard is disarmed and a future EDITION change re-stamps ' +
        'without refusal (internal/federation.md)'
    );
  }

  // The first-boot claim credential (PRDCT-1347): SETUP_TOKEN, or a token
  // generated into the data volume while the instance is unclaimed. A boot
  // that cannot read the stamp (pending migrations, pre-stamp schema) is
  // treated as unclaimed — generating a token an already-set-up instance
  // never needs is harmless; skipping it on an unclaimed one is the hole.
  const setupToken = await resolveSetupToken(
    env.SETUP_TOKEN,
    env.DATA_DIR,
    stampedEdition !== undefined,
    logger
  );

  // OAuth signing-key preflight (ADR 023): one decrypt of the key the jwt
  // plugin would sign with. A rotated AUTH_SECRET leaves the stored JWKS
  // private key undecryptable and — with no rotationInterval — never
  // replaced, so every token mint would 500 while authorize still 302s.
  // Refuse to boot instead, with the remedies in the message. Skipped only
  // while migrations are pending (the jwks table may not exist yet, and the
  // instance already refuses readiness in that state).
  if (!migrationsPending) {
    state.reason = 'verifying OAuth signing key';
    const preflight = await preflightSigningKey(db.db, authSecret);
    if (!preflight.ok) {
      logger.fatal({ kid: preflight.kid }, preflight.reason);
      // Fail-fast means clean-fast: release the pool this boot opened so the
      // refusing process (and the integration test that pins it) never
      // strands an open connection.
      await db.pool.end().catch(() => {});
      throw new Error('OAuth signing-key preflight failed — see the preceding log line');
    }
  }

  // Email first: whether it delivers decides whether email-OTP login,
  // self-serve password reset, and self-serve email change exist.
  const email = overrides.email ?? createEmailDriver(env, logger);

  // Audit is built before auth so credential events on Better-Auth-native
  // routes (password reset/change) can be recorded through it.
  const audit = new AuditService(db.db, logger);

  /**
   * Best-effort audit for a Better-Auth credential event. Credential events
   * are USER-level, so the row lands in every workspace the user is an
   * ACTIVE member of (ADR 014) — each workspace's trail records its own
   * members' password/2FA changes, and a workspace the user was deactivated
   * from records nothing; a single-workspace instance gets exactly one row,
   * as before.
   */
  const auditAccountEvent = async (event: AccountEvent, userId: string) => {
    const rows = await db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.isActive, true)));
    for (const row of rows) {
      await audit.write({
        workspaceId: row.workspaceId,
        principal: { userId, via: 'session' },
        action: `user.${event}`,
        resourceType: 'user',
        resourceId: userId
      });
    }
  };

  // Account deletion: shared by the self-service /delete-user hooks below
  // and the admin DELETE /members/{id} route. No storage dep — files are
  // workspace data and survive the delete (ADR 006). The connection string
  // feeds the dedicated advisory-lock clients that serialize last-owner
  // removals (the migration-lock pattern).
  const erasureLog = new ErasureLog(env.DATA_DIR, logger, authSecret);
  const accountDeletion = new AccountDeletionService(db.db, audit, logger, env.DATABASE_URL, erasureLog);

  // The event bus exists before auth so identity-layer hooks can publish:
  // `user.created` fires from Better Auth's databaseHooks.user.create.after,
  // covering EVERY account entrance by construction (setup, invitation
  // accept, collaborator claim, future SSO JIT) — never from individual
  // call sites.
  const events = new EventBus<TEvents>(logger);

  // The cloud edition's hub SSO binding (internal/federation.md): constructed
  // iff EDITION=cloud — hubConfig() is the single switch, so an oss boot
  // provably instantiates no SSO surface. Everything hub-SSO hangs off this
  // one object: the genericOAuth provider inside createAuth, the per-login
  // projection after-hook, and the login-scope wrap around the auth mount.
  const hub = hubConfig(env);
  // THE seam constant: the RFC 8707 `resource` for BOTH the SSO code
  // exchange and every refresh — `<hub>/mcp`, so the tokens Slideless holds
  // are HUB-audienced and callable at hub /api/v1 as the user. Flipping it
  // to null (if the hub ever accepts opaque tokens) is this one line.
  const hubTokenResource = hub ? hubApiResource(hub.issuerUrl) : null;
  const hubSso = hub
    ? new HubSsoService({
        db: db.db,
        logger,
        issuerUrl: hub.issuerUrl,
        clientId: hub.clientId,
        clientSecret: hub.clientSecret,
        // Own resource URL — always derived from PUBLIC_BASE_URL, never
        // configured. Pins H3 connect tokens only; login tokens are
        // hub-audienced via tokenResource.
        resourceUrl: mcpResourceUrl(env.PUBLIC_BASE_URL),
        tokenResource: hubTokenResource,
        publicBaseUrl: env.PUBLIC_BASE_URL
      })
    : undefined;

  // ONE source for the never-trusted origins: Better Auth here, the cross-site
  // guard of the API app below.
  const untrustedOrigins = tool.api.untrustedOrigins?.(env) ?? [];

  // Identity + seams: local defaults, swappable at this one point.
  const auth = createAuth({
    db: db.db,
    env,
    authSecret,
    // The tool's values for the two generic-by-parameter points of the
    // identity module: the published OAuth scope list (order included) and
    // the origins that are never trusted (for Slideless the viewer origin,
    // where author-controlled deck script runs, PRDCT-1352). None = nothing installed.
    oauthScopes: tool.scopes.oauth,
    untrustedOrigins,
    hubSso,
    onAccountEvent: auditAccountEvent,
    onUserCreated: (user) =>
      events.chassisView().emit('user.created', { userId: user.id, email: user.email }),
    beforeUserDelete: async (userId) => {
      try {
        await accountDeletion.beforeUserDelete(userId);
      } catch (cause) {
        // Better Auth turns APIError into the route's 400 response.
        if (cause instanceof LastOwnerError) {
          throw new APIError('BAD_REQUEST', { message: cause.message });
        }
        throw cause;
      }
    },
    afterUserDelete: (user) => accountDeletion.afterUserDelete(user),
    ...(email.delivers
      ? {
          sendOtp: async ({ email: to, otp, type }: { email: string; otp: string; type: string }) => {
            const msg = buildOtpEmail({ otp, type });
            await email.send({ to, ...msg });
          },
          sendResetPassword: async ({ email: to, url }: { email: string; url: string; token: string }) => {
            // Better Auth builds `url` as the API callback that 302s to the
            // dashboard reset page with ?token — mail it verbatim.
            const msg = buildPasswordResetEmail({
              resetUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          },
          // Two-leg email change, leg 1 (verified users only): confirmation
          // to the OLD address. Mail Better Auth's `url` verbatim.
          sendChangeEmailConfirmation: async ({
            email: to,
            newEmail,
            url
          }: {
            email: string;
            newEmail: string;
            url: string;
            token: string;
          }) => {
            const msg = buildChangeEmailConfirmEmail({
              newEmail,
              confirmUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          },
          // Final leg of every email change: verification to the NEW address.
          sendVerificationEmail: async ({
            email: to,
            url
          }: {
            email: string;
            url: string;
            token: string;
          }) => {
            const msg = buildVerifyEmailEmail({
              verifyUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          }
        }
      : {})
  });

  // OPS-3 (PRDCT-1357): replay the erasure tombstone before the app serves.
  // A restore from an older dump brings erased users back; the tombstone
  // (kept outside the dump, carried forward by restore.sh) says who must
  // stay gone. Runs through the same Better Auth cascade every GDPR surface
  // uses (memberships, sessions, accounts go with the user) and lands an
  // instance-level audit row per replay. Skipped while migrations are
  // pending (the tables may not exist; readiness is red anyway).
  //
  // PRDCT-1809: the replay runs under EVERY last-owner guard the subject is
  // subject to (the same locks + re-check the HTTP surfaces use; the 0009
  // trigger backstops), so a sole-owner subject is refused BEFORE any row is
  // touched — Better Auth's cascade drops the account rows before the user
  // row, and an unguarded refusal left a half-erased owner. A refused
  // tombstone is a FAIL-CLOSED verdict: the subject asked to be forgotten
  // and the product cannot decide who inherits their workspace, so the boot
  // audits the refusal, keeps /readyz red with the reason, and CLOSES the
  // service surface (state.closed → 503 everywhere but the probes) until an
  // operator promotes another owner and restarts (docs/operations/
  // backup-restore.md "Erasures hold across a restore"). Readiness alone is
  // not a closure: the API keeps serving under a red /readyz.
  if (!migrationsPending) {
    state.reason = 'replaying erasure tombstones';
    const authCtx = await auth.$context;
    const { replayed, refused } = await erasureLog.replay(
      async (userId) => {
        const [row] = await db.db
          .select({ id: userTable.id })
          .from(userTable)
          .where(eq(userTable.id, userId))
          .limit(1);
        return row !== undefined;
      },
      (userId) =>
        accountDeletion.withAllLastOwnerGuards(userId, async () => {
          await authCtx.internalAdapter.deleteUser(userId);
          await authCtx.internalAdapter.deleteUserSessions(userId);
        })
    );
    for (const userId of replayed) {
      await audit.write({
        workspaceId: null,
        principal: null, // → actorVia 'system'
        action: 'user.erasure_replayed',
        resourceType: 'user',
        resourceId: userId,
        metadata: { reason: 'tombstoned user present after boot (restore from an older backup)' }
      });
    }
    for (const r of refused) {
      const lastOwner = r.cause instanceof LastOwnerError;
      await audit.write({
        workspaceId: null,
        principal: null, // → actorVia 'system'
        action: 'user.erasure_replay_refused',
        resourceType: 'user',
        resourceId: r.userId,
        metadata: {
          reason: lastOwner
            ? 'tombstoned user is the last active owner of a workspace; the instance refuses to serve until another owner is promoted'
            : 'tombstoned user could not be re-erased; the instance refuses to serve',
          erasedAt: r.erasedAt
        }
      });
    }
    if (refused.length > 0) {
      // The public reason stays COARSE: /readyz is unauthenticated and the
      // subject asked to be forgotten, so their id lives in the log line and
      // the audit row only. The remedy names the cause the operator faces.
      const lastOwner = refused.filter((r) => r.cause instanceof LastOwnerError).length;
      const other = refused.length - lastOwner;
      const remedy = [
        lastOwner > 0
          ? `${lastOwner} subject(s) present again after a restore as the last active owner of a workspace — promote another member to owner, then restart`
          : null,
        other > 0
          ? `${other} re-erasure(s) failed — see the container log, fix the cause, then restart`
          : null
      ]
        .filter((s): s is string => s !== null)
        .join('; ');
      state.reason =
        `refusing to serve: ${refused.length} erasure tombstone(s) could not be replayed: ${remedy} ` +
        '(docs/operations/backup-restore.md, audit action user.erasure_replay_refused)';
      readinessRefusal = state.reason;
      state.closed = state.reason;
      logger.error(
        { refused: refused.map((r) => ({ userId: r.userId, lastOwner: r.cause instanceof LastOwnerError })) },
        state.reason
      );
    }
  }

  // The live user-scoped federation stack (cloud only, internal/federation.md):
  // each user's OWN hub grant (offline_access refresh token on the account
  // row) → as-the-user `GET /orgs` reads → the org reconciler that the
  // login pass, the live gate, and the unknown-workspace miss hook all
  // share. Constructed AFTER createAuth because the grant encrypts tokens
  // with Better Auth's own key material ((await auth.$context).secretConfig
  // — equal to authSecret under our string-secret config; the fallback
  // keeps the read total if a future Better Auth reshapes the context).
  const hubDials: HubFederationDials = { ...DEFAULT_FEDERATION_DIALS, ...overrides.hubDials };
  const hubGrant = hub
    ? new HubGrantService({
        db: db.db,
        issuerUrl: hub.issuerUrl,
        clientId: hub.clientId,
        clientSecret: hub.clientSecret,
        tokenResource: hubTokenResource,
        key: async () =>
          ((await auth.$context) as unknown as { secretConfig?: string }).secretConfig ?? authSecret,
        connectionString: env.DATABASE_URL,
        logger,
        dials: {
          accessSkewMs: hubDials.accessSkewMs,
          tokenTimeoutMs: hubDials.tokenTimeoutMs,
          // The RFC 7662 probe rides the token-endpoint budget: same hub,
          // same hop, and it only runs after an unanswered presentation.
          introspectTimeoutMs: hubDials.tokenTimeoutMs,
          lockWatchdogMs: hubDials.lockWatchdogMs
        }
      })
    : undefined;
  // RP-initiated logout against the hub (SL-2, cloud only): builds the
  // end-session URL /sso/logout returns. Same key seam as the grant store
  // (it only decrypts if a future Better Auth starts encrypting id_tokens);
  // discovery fetches ride the tight orgs timeout dial.
  const hubLogout = hub
    ? new HubLogoutService({
        db: db.db,
        issuerUrl: hub.issuerUrl,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        key: async () =>
          ((await auth.$context) as unknown as { secretConfig?: string }).secretConfig ?? authSecret,
        logger,
        discoveryTimeoutMs: hubDials.orgsTimeoutMs
      })
    : undefined;
  // The ONE as-the-user hub client: the reconciler's GET /orgs reads and
  // POST /workspaces' organization creation both present the user's own
  // grant through it (never a second, hand-rolled token path).
  const hubUserClient =
    hub && hubGrant
      ? new HubUserClient({
          grant: hubGrant,
          issuerUrl: hub.issuerUrl,
          logger,
          timeoutMs: hubDials.orgsTimeoutMs,
          // A creation is one deliberate human act, not an identity-path
          // read: it rides the token-endpoint budget, not the tight one.
          createTimeoutMs: hubDials.tokenTimeoutMs
        })
      : undefined;
  const hubReconciler =
    hub && hubGrant && hubUserClient
      ? new HubOrgReconciler({
          db: db.db,
          client: hubUserClient,
          audit,
          logger,
          dials: hubDials
        })
      : undefined;
  // The SSO login's fail-closed step 3 (assertLogin) runs THIS reconciler.
  if (hubSso && hubReconciler) hubSso.bindReconciler(hubReconciler);
  // Unknown-workspace retry, ALL THREE credential kinds: one cached
  // reconcile + one re-lookup. Rides the reconciler's TTL + throttle, so a
  // garbage selector can never hammer the hub. undefined on oss.
  const onWorkspaceMiss: OnWorkspaceMiss | undefined = hubReconciler
    ? async (userId) => {
        await hubReconciler.reconcile(userId);
      }
    : undefined;

  // Jobs: pg-boss (durable queue). The registry's UsageSink emits into it;
  // the worker side hands batches to the downstream sink (no-op locally).
  // A tool job may need a service built further down (the storage driver is
  // probed later); it reads the domain through this holder at RUN time (nightly).
  const domainRef: { current: TDomain | null } = { current: null };
  const jobs = await createJobs(
    env,
    db.db,
    logger,
    overrides.usageDownstream ?? new NoopUsageSink(),
    auth,
    audit,
    tool.jobs?.({ env, db: db.db, logger, getTool: () => domainRef.current }) ?? []
  );

  // The edition split (internal/federation.md): the local defaults below are the
  // oss binding, passed through bindEditionSeams — the ONE place EDITION
  // decides what the registry gets. oss returns them untouched; cloud
  // rebinds the identity descriptor and wires the live principal gate off
  // the reconciler built above. Entitlements stay LOCAL on both editions.
  const seams = bindEditionSeams(
    hub,
    {
      identity: new LocalIdentityProvider(
        auth,
        db.db,
        Boolean(env.GOOGLE_CLIENT_ID),
        email.delivers,
        email.delivers, // self-serve password reset needs a delivering email driver
        email.delivers, // self-serve email change needs one too
        onWorkspaceMiss
      ),
      entitlements: new AllowAllEntitlements({
        maxFileSizeMb: env.MAX_FILE_SIZE_MB,
        apiRequestsPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
        apiRequestsBurstPerSecond: env.API_RATE_LIMIT_BURST
      }),
      usage: new PgBossUsageSink(jobs.boss, logger)
    },
    logger,
    { db: db.db, reconciler: hubReconciler }
  );
  const registry = createRegistry({
    identity: seams.identity,
    entitlements: seams.entitlements,
    usage: seams.usage,
    events,
    workspaces: new WorkspaceService(db.db)
  });

  // API-key pepper registry (ADR 008): version 1 is the AUTH_SECRET-derived
  // pepper; API_KEY_PEPPERS adds/pins versions so keys survive rotations.
  const pepperRegistry = buildPepperRegistry(authSecret, env.API_KEY_PEPPERS);
  if (env.API_KEY_PEPPERS !== undefined && !pepperRegistry.v1Pinned) {
    logger.warn(
      'API_KEY_PEPPERS is set but does not pin version 1 — version-1 API keys still ' +
        'depend on the live AUTH_SECRET; pin `1:<historical secret>` before rotating it ' +
        '(internal/security-runbooks.md).'
    );
  }
  const apiKeys = new ApiKeyService(db.db, pepperRegistry, onWorkspaceMiss);
  // Storage: probed at boot — /readyz stays red on an unwritable volume.
  state.reason = 'probing storage';
  const storage = createStorageDriver(env);
  await storage.healthcheck();
  logger.info({ driver: storage.name }, 'storage writable');
  const fileService = new FileService(db.db, storage, join(env.DATA_DIR, 'tmp'), logger);

  // The tool's domain services, built ONCE, here: after the storage probe
  // and BEFORE the rate limiters, which is where the first service a job
  // reads lazily was always built (a nightly purge firing during boot finds
  // it from this line on). A tool subscribes to the event bus inside this
  // call (no request can arrive before boot returns, so a subscription made
  // here precedes every emission).
  const serviceCore: ServiceCore<TEnvShape, TEvents, TToolOverrides> = {
    db: db.db,
    env,
    logger,
    storage,
    fileService,
    pepperRegistry,
    email,
    events,
    authSecret,
    overrides: overrides.tool
  };
  const domain = tool.services(serviceCore);
  domainRef.current = domain;

  const limiters = await createRateLimiters<TBuckets>(env, logger, tool.rateLimiters);
  const core: PlatformCore<TEnvShape, TBuckets, TEvents, TToolOverrides> = { ...serviceCore, limiters };

  // OAuth-bearer verification: local JWKS (we minted the token) + live
  // membership re-check. One instance, shared by the API and /mcp gates.
  const oauthJwt = new OauthJwtVerifier(auth, db.db, env.PUBLIC_BASE_URL, onWorkspaceMiss);

  const api = createApiApp({
    db: db.db,
    env,
    auth,
    registry,
    logger,
    apiKeys,
    audit,
    email,
    limiters,
    storage,
    fileService,
    oauthJwt,
    authSecret,
    setupToken,
    clearGeneratedSetupToken: () => clearGeneratedSetupToken(env.DATA_DIR),
    accountDeletion,
    tool,
    domain,
    untrustedOrigins,
    hubSso,
    // Cloud only: /sso/cli-connect stores the H3 offline grant through it.
    hubGrant,
    // Cloud only: /sso/logout builds the hub end-session leg through it.
    hubLogout,
    // Cloud only (internal/federation.md): the post-resolution LIVE hub gate —
    // reconcile-as-the-user + suspension/revocation/grant-death verdicts —
    // run by authContext on every authenticated request. undefined on oss.
    principalGate: seams.principalGate,
    // Cloud only (PRDCT-2443): POST /workspaces creates the organization at
    // the hub AS THE CALLER, then forces their reconcile. undefined on oss —
    // the route creates locally there.
    workspaceCloud:
      hub && hubGrant && hubUserClient && hubReconciler
        ? {
            createOrg: overrides.hubCreateOrg ?? ((userId, name) => hubUserClient.createOrg(userId, name)),
            forceReconcile: (userId) => hubReconciler.forceReconcile(userId),
            hasHubLink: (userId) => hubGrant.hasStoredGrant(userId),
            manageUrl: hub.issuerUrl
          }
        : undefined
  });

  // The tool's public routes (for Slideless the share-link viewer, Phase 4,
  // ADR 012): anonymous, mounted in app.ts's public-route slot.
  const publicRoutes = tool.app?.publicRoutes?.({ ...core, overrides: undefined }, domain);

  // Observability: tracing (exporterless = zero phone-home) + Prometheus.
  const otel = await createOtel(env, logger, { serviceName: 'slideless' });
  const metrics = createMetrics(db.db, jobs.boss);
  // Cloud only: the reconcile-pass and grant-refresh counters join the app
  // registry so a degraded hub (or dying grants) is visible on /metrics.
  for (const metric of [...(hubReconciler?.promMetrics ?? []), ...(hubGrant?.promMetrics ?? [])]) {
    metrics.registry.registerMetric(metric);
  }

  // MCP tools call the instance's own API in-process, forwarding the caller's
  // bearer — MCP is just another API client. The root app does not exist yet
  // at this point, so the fetcher closes over a holder filled right after
  // createApp (before any request can arrive).
  const rootApp: { current: Hono | null } = { current: null };
  let cachedName: string | null = null;
  const mcp = mcpRoutes({
    publicBaseUrl: env.PUBLIC_BASE_URL,
    version: env.APP_VERSION,
    fetchApi: async (path, init) => {
      if (!rootApp.current) throw new Error('mcp fetchApi called before app assembly');
      return rootApp.current.request(path, init);
    },
    // The /mcp transport gate resolves the credential with NO workspace
    // selector (default-org perspective): the per-tool-call `workspace`
    // argument is mapped to the header at the in-process /api/v1 re-entry,
    // where the real per-request selection happens.
    resolveOauthJwt: (token) => oauthJwt.resolve(token, null),
    resolveApiKey: (token) => apiKeys.resolve(token, null),
    isApiKeyToken,
    limiter: rateLimit(limiters.mcp, makeClientIp(env.TRUST_PROXY)),
    tool: tool.mcp,
    instanceName: async () => {
      if (cachedName) return cachedName;
      const [row] = await db.db.select({ name: instanceSettings.name }).from(instanceSettings).limit(1);
      cachedName = row?.name ?? tool.mcp.defaultInstanceName;
      return cachedName;
    }
  });

  const app = await createApp({
    logger,
    state,
    publicDir: tool.runtime.publicDir,
    api,
    mcp,
    wellKnown: wellKnownRoutes({ auth, publicBaseUrl: env.PUBLIC_BASE_URL, oauthScopes: tool.scopes.oauth }),
    publicRoutes,
    metricsMiddleware: metrics.middleware,
    metricsRoutes: metrics.routes(env.METRICS_TOKEN),
    otelMiddleware: otel.middleware,
    // The boot probe above runs once. /readyz re-runs this one so a store
    // that goes away later (unmounted volume, wiped /data after a failed
    // restore, revoked S3 credentials) stops reporting ready.
    probeStorage: () => storage.healthcheck(),
    hsts: hstsValue(env),
    rootMiddleware: tool.app?.rootMiddleware?.(env),
    cspFrameSrc: tool.app?.cspFrameSrc?.(env) ?? []
  });
  rootApp.current = app;

  if (!migrationsPending && !readinessRefusal) {
    state.ready = true;
    state.reason = '';
  } else if (readinessRefusal) {
    // Keep the migration-stage verdict on /readyz, not the last probe's label.
    state.reason = readinessRefusal;
  }

  return { app, env, logger, state, db, auth, registry, jobs, email, otel, authSecret, tool: domain };
}
