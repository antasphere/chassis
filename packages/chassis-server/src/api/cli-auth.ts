import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { cliAuthRequestRoute, cliAuthRevokeRoute } from '@antasphere/chassis-contract/routes';
import type { ScopeRoutes } from './scope-routes.js';
import { apiKeys as apiKeysTable, type Db } from '@antasphere/chassis-db';
import type { Auth } from '../identity/better-auth.js';
import { resolveMembership } from '../identity/resolve-membership.js';
import type { HubSsoService } from '../identity/hub-sso.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { AuditService } from '../audit/service.js';
import type { EmailDriver } from '../email/driver.js';
import type { Logger } from '../logger.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * Browserless CLI/agent auth (the tool CLI's `auth login-*` flow):
 *
 *   POST /cli/auth/request  → email a 6-digit sign-in OTP
 *   POST /cli/auth/complete → verify the OTP, mint an API key
 *
 * Built ENTIRELY on the existing email-OTP primitive — no new credential
 * machinery. `request` delegates to the emailOTP plugin's
 * send-verification-otp (type "sign-in"); with the instance's
 * `disableSignUp: true` an unknown email gets a generic success and NO mail
 * (the plugin deletes the pending code — no enumeration oracle, no user
 * minted). `complete` delegates to the plugin's sign-in endpoint, whose
 * verification is atomic and attempt-limited (3 per code); with
 * `disableSignUp` an unknown email fails exactly like a wrong code. So the
 * closed-signup invariant (the three switches) is untouched: this surface
 * can only ever sign in accounts that already exist (setup owner, workspace
 * invitation, collaborator claim).
 *
 * On success the sign-in's throwaway session is used server-side only: mint
 * the key (the tool's read + write scopes — the agent surface, never its
 * export scope), DELETE the session, and return the key once. The
 * "sessions only mint keys" rule holds in spirit: the mint is bound to a
 * fresh, fully verified interactive sign-in, not to a machine credential
 * (machine principals can't even reach these paths — they are unlisted in
 * the scope allowlist and 403 fail-closed).
 *
 * 2FA-enrolled users are REJECTED (403 two_factor_required): the config
 * hooks.after in identity/better-auth.ts parks their OTP sign-in behind the
 * TOTP step, which a browserless flow cannot complete — they mint keys in
 * the dashboard instead. Never bypass that hook here.
 *
 * Without a delivering email driver both endpoints answer 400
 * otp_unavailable (the emailOTP plugin is not even registered then) —
 * self-hosters without SMTP paste a dashboard-minted key (the CLI's `login`).
 *
 * On EDITION=cloud (hubSso present) BOTH mint endpoints refuse outright —
 * 403 cli_otp_disabled, checked BEFORE the mailer/plugin checks so a
 * mailerless cloud instance steers to `antasphere login` too. This is the
 * CLI half of the D1 hub-only entrance closure (the human half is the
 * emailOTP sign-in refusal in identity/better-auth.ts): every cloud
 * credential — human session AND machine key — must trace through the hub
 * so its audit log is the complete access record. Cloud CLI keys are minted
 * by `antasphere login` + /sso/cli-connect (api/sso-connect.ts) instead.
 * oss keeps this flow unchanged.
 *
 * DELETE /cli/auth/key (the CLI's `logout`) stays OPEN on both editions: it
 * revokes exactly the PRESENTING key — revocation narrows access and is the
 * cleanup path every mint above needs.
 *
 * Rate limits (api/index.ts): request rides the OTP wall (per IP + email),
 * complete rides the login wall (per IP + email).
 */

export interface CliAuthRouteDeps {
  db: Db;
  auth: Auth;
  email: EmailDriver;
  apiKeys: ApiKeyService;
  audit: AuditService;
  logger: Logger;
  /**
   * Cloud presence switch (internal/federation.md, D1 hub-only login): when set
   * (EDITION=cloud boots only), the OTP mint pair refuses 403
   * cli_otp_disabled. Only the boolean presence is consulted — the service
   * itself is never called from this module. The self-revoke is unaffected.
   */
  hubSso?: HubSsoService | undefined;
  /** The CLI key's fixed grant — the agent surface, never the export scope. */
  cliKeyScopes: readonly string[];
  /** The tool's instantiation of the scope-carrying mint route. */
  routes: Pick<ScopeRoutes, 'cliAuthCompleteRoute'>;
  /** The tool's name in the cloud refusal sentence (`identity.displayName`). */
  displayName: string;
}

/** The emailOTP endpoints, present iff the plugin registered (email delivers). */
interface EmailOtpApi {
  sendVerificationOTP?: (input: {
    body: { email: string; type: 'sign-in' };
  }) => Promise<{ success: boolean }>;
  signInEmailOTP?: (input: {
    body: { email: string; otp: string };
  }) => Promise<
    { token: string; user: { id: string; email: string; name: string } } | { twoFactorRedirect: true }
  >;
}

/** better-auth APIError carries { body: { code, message } }; match by code. */
function betterAuthErrorCode(e: unknown): string | null {
  const body = (e as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === 'string' ? body.code : null;
}

export function registerCliAuthRoutes(api: OpenAPIHono, deps: CliAuthRouteDeps): void {
  const { db, auth, email, apiKeys, audit, logger, hubSso, cliKeyScopes } = deps;
  const { cliAuthCompleteRoute } = deps.routes;
  const otpApi = auth.api as unknown as EmailOtpApi;

  /** The D1 cloud refusal — identical on both mint routes, checked FIRST. */
  const cloudRefusal = () =>
    err(
      'cli_otp_disabled',
      'This instance signs in through the Antasphere hub — run `antasphere login` once; ' +
        `the ${deps.displayName} CLI then connects automatically`
    );

  api.openapi(cliAuthRequestRoute, async (c) => {
    if (hubSso) return c.json(cloudRefusal(), 403);
    if (!email.delivers || !otpApi.sendVerificationOTP) {
      return c.json(
        err(
          'otp_unavailable',
          'This instance has no email driver — sign in to the dashboard and mint an API key instead'
        ),
        400
      );
    }
    const body = c.req.valid('json');
    try {
      // Generic success either way; the plugin sends only to existing
      // accounts (disableSignUp) — deliberately not observable here.
      await otpApi.sendVerificationOTP({ body: { email: body.email, type: 'sign-in' } });
    } catch (cause) {
      // INVALID_EMAIL can't happen (contract-validated); anything else is internal.
      logger.error({ err: cause }, 'cli-auth: OTP send failed');
      return c.json(err('internal', 'Could not send the sign-in code — try again'), 500);
    }
    return c.json({ sent: true as const }, 200);
  });

  api.openapi(cliAuthCompleteRoute, async (c) => {
    if (hubSso) return c.json(cloudRefusal(), 403);
    if (!email.delivers || !otpApi.signInEmailOTP) {
      return c.json(
        err(
          'otp_unavailable',
          'This instance has no email driver — sign in to the dashboard and mint an API key instead'
        ),
        400
      );
    }
    const body = c.req.valid('json');

    let signedIn: Awaited<ReturnType<NonNullable<EmailOtpApi['signInEmailOTP']>>>;
    try {
      signedIn = await otpApi.signInEmailOTP({ body: { email: body.email, otp: body.otp } });
    } catch (cause) {
      const code = betterAuthErrorCode(cause);
      if (code === 'TOO_MANY_ATTEMPTS') {
        return c.json(err('too_many_attempts', 'Too many wrong codes — request a fresh one'), 429);
      }
      // INVALID_OTP covers wrong code AND unknown account (disableSignUp);
      // OTP_EXPIRED joins them — one uniform 401, no enumeration.
      if (code === 'INVALID_OTP' || code === 'OTP_EXPIRED' || code === 'USER_NOT_FOUND') {
        return c.json(err('invalid_otp', 'The code is wrong, expired, or not for this email'), 401);
      }
      logger.error({ err: cause }, 'cli-auth: OTP sign-in failed');
      return c.json(err('internal', 'Sign-in failed — try again'), 500);
    }

    // The 2FA hook (identity/better-auth.ts) parks enrolled users behind the
    // TOTP step and answers { twoFactorRedirect } with no session. A
    // browserless flow cannot complete that dance — refuse, never bypass.
    if (!('token' in signedIn)) {
      return c.json(
        err(
          'two_factor_required',
          'This account has two-factor auth enabled — sign in to the dashboard and mint an API key there'
        ),
        403
      );
    }

    const { token: sessionToken, user } = signedIn;
    const dropSession = async () => {
      try {
        const authCtx = await auth.$context;
        await authCtx.internalAdapter.deleteSession(sessionToken);
      } catch (cause) {
        // Advisory: the session was never handed out; expiry bounds the residue.
        logger.warn({ err: cause }, 'cli-auth: throwaway session cleanup failed');
      }
    };

    // Same live-membership discipline as every credential path: no active
    // membership, no key (e.g. a deactivated member's account still signs in
    // at the Better Auth layer but has no standing on this instance). The
    // key is USER-SCOPED by default (user-scoped credential model): it acts
    // as its holder and the target workspace is a per-request parameter.
    // `workspaceId` in the body is an optional PIN — a requested workspace
    // the account is not an active member of answers the SAME uniform 403
    // as having none at all (no oracle about other workspaces).
    const membership = await resolveMembership(db, user.id, body.workspaceId ?? null);
    if (!membership) {
      await dropSession();
      return c.json(err('no_membership', 'This account has no active membership on this instance'), 403);
    }
    const pinnedWorkspaceId = body.workspaceId ?? null;

    const name = body.keyName ?? `CLI login ${new Date().toISOString().slice(0, 10)}`;
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    const minted = await apiKeys.mint({
      workspaceId: pinnedWorkspaceId,
      createdBy: user.id,
      name,
      scopes: [...cliKeyScopes],
      expiresAt
    });
    await dropSession();

    const [row] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, minted.id)).limit(1);
    if (!row) {
      return c.json(err('internal', 'Key mint failed — try again'), 500);
    }

    // This path is principal-less (public route), so the audit middleware
    // cannot attribute it — write the row directly, like /setup does. An
    // unpinned mint is a USER-credential event with no one workspace home:
    // the row is instance-attributed (workspaceId null, like the orphan
    // purge); a pinned mint lands in the pinned workspace's trail.
    await audit.write({
      workspaceId: pinnedWorkspaceId,
      principal: { userId: user.id, via: 'session' },
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: minted.id,
      requestId: c.get('requestId'),
      metadata: {
        name,
        scopes: [...cliKeyScopes],
        via: 'cli_otp',
        workspaceId: pinnedWorkspaceId,
        expiresAt: expiresAt?.toISOString() ?? null
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
        user: { id: user.id, email: user.email, name: user.name },
        workspaceId: pinnedWorkspaceId
      },
      201
    );
  });

  // CLI logout: revoke exactly the PRESENTING key — possession is the
  // authority to kill itself. The ONE /cli/auth route open to machine
  // principals (scope allowlist, the tool's write scope — every CLI-minted key
  // carries it); there is no id parameter, so no OTHER key is nameable, and
  // the handler acts only on principal.apiKeyId, which the credential
  // resolver derived from the presented secret. Sessions are refused — the
  // dashboard (DELETE /api-keys/{id}) is their key-management surface — and
  // so are OAuth bearers (no apiKeyId). Deliberately edition-independent:
  // on cloud, the CLI's `logout --org` must be able to kill the
  // /sso/cli-connect-minted key server-side (revocation narrows access; the
  // D1 closure is about MINTING).
  api.openapi(cliAuthRevokeRoute, async (c) => {
    const principal = c.get('principal');
    if (!principal) return c.json(err('unauthenticated', 'Authentication required'), 401);
    if (principal.via !== 'api_key' || !principal.apiKeyId) {
      return c.json(
        err('forbidden', 'Only an API key can revoke itself — use the dashboard for key management'),
        403
      );
    }
    await db
      .update(apiKeysTable)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeysTable.id, principal.apiKeyId), isNull(apiKeysTable.revokedAt)));
    // The generic audit middleware writes the row (machine mutation) — hand
    // it the semantics instead of double-writing.
    c.set('audit', {
      action: 'apikey.revoke',
      resourceType: 'api_key',
      resourceId: principal.apiKeyId,
      metadata: { via: 'cli_logout' }
    });
    return c.json({ revoked: true as const, id: principal.apiKeyId }, 200);
  });
}
