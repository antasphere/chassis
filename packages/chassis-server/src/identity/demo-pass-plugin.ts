import { z } from 'zod';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Db } from '@antasphere/chassis-db';
import type { AuditService } from '../audit/service.js';
import { DemoPassService } from './demo-pass.js';
import { parseDemoEmailDomains } from './demo-pass-rules.js';

/**
 * The demo pass redeem (the demo pass spec, section 4): a local Better Auth
 * plugin with ONE endpoint, `POST /demo/redeem` (mounted at
 * `/api/v1/auth/demo/redeem`). It lives inside the sign-in library on
 * purpose: the session is created through the library's own internal
 * adapter and the cookie set by its own `setSessionCookie`, so the cookie's
 * name, attributes and signature are exactly a password sign-in's, and every
 * after-hook sees `newSession` as it would there. Registered in
 * identity/better-auth.ts only while DEMO_SIGN_IN is on, on the self-hosted
 * edition; otherwise the path is an unknown one.
 *
 * In front of it, outside the library: the cross-site guard refuses a
 * foreign Origin before any work (api/create-api.ts), and the `demo-redeem`
 * wall bounds one address to 20 refused tries in 15 minutes. The sign-in Origin lock
 * of the before-hook is keyed on `/sign-in*` paths and does not cover this
 * one, so the endpoint carries its own lock: no Origin, no redeem.
 */

export interface DemoPassPluginDeps {
  db: Db;
  /** `DEMO_SIGN_IN_EMAIL_DOMAINS`, raw (validated at boot). */
  emailDomains: string | undefined;
  /** Where the `demo_pass.use` row is written: the /auth mount runs before the audit middleware. */
  audit: AuditService;
}

/**
 * ONE answer for every refusal of a pass (unknown, expired, revoked, the
 * person gone or no longer a member, the address no longer a demonstration
 * one, a second factor enrolled since): the answer must not tell which, or
 * it becomes an oracle on the pass and on the person. The body is the API's
 * error wire shape, so the SDK reads its code like any other.
 */
const INVALID_DEMO_PASS = {
  error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' }
} as const;

/** A secret is 43 characters; the bound keeps an oversized body from reaching the hash. */
const redeemBodySchema = z.object({ pass: z.string().min(1).max(128) });

export function demoPassPlugin(deps: DemoPassPluginDeps): BetterAuthPlugin {
  const service = new DemoPassService(deps.db);
  const extraDomains = parseDemoEmailDomains(deps.emailDomains);
  return {
    id: 'demo-pass',
    endpoints: {
      redeemDemoPass: createAuthEndpoint(
        '/demo/redeem',
        {
          method: 'POST',
          // The library's own sign-in CSRF check (what /sign-in/email uses):
          // an Origin or Fetch Metadata present is validated against the
          // trusted origins even when no cookie rides along.
          use: [formCsrfMiddleware],
          body: redeemBodySchema
        },
        async (ctx) => {
          // A browser always sends Origin on this POST; a request without
          // one is a script or a server-side call, and a pass is redeemed
          // only by the page it was made for.
          if (!ctx.request?.headers.get('origin')) {
            throw new APIError('FORBIDDEN', {
              error: {
                code: 'cross_site_forbidden',
                message: 'A demo link is redeemed from its page on this instance only'
              }
            });
          }
          const pass = await service.redeemable(ctx.body.pass, extraDomains);
          if (!pass) throw new APIError('UNAUTHORIZED', INVALID_DEMO_PASS);
          const user = await ctx.context.internalAdapter.findUserById(pass.user.id);
          if (!user) throw new APIError('UNAUTHORIZED', INVALID_DEMO_PASS);

          // The library's own sign-in sequence (api/routes/sign-in.mjs,
          // signInEmail on 1.6.22): createSession, then setSessionCookie, with
          // `dontRememberMe` at its default (false: a remembered session).
          // Re-verify both signatures on any Better Auth bump.
          const session = await ctx.context.internalAdapter.createSession(user.id, false);
          if (!session) {
            throw APIError.fromStatus('UNAUTHORIZED', {
              message: 'Failed to create session',
              code: 'FAILED_TO_CREATE_SESSION'
            });
          }
          // The use is recorded BEFORE the cookie leaves: the row is what ties
          // the session to its pass (the resolver's judge, the audit mark), so
          // a session that could not be tied is dropped, never handed out.
          try {
            await service.recordUse(pass.passId, session.id);
          } catch (cause) {
            await ctx.context.internalAdapter.deleteSession(session.token);
            throw cause;
          }
          await setSessionCookie(ctx, { session, user }, false);
          await deps.audit.write({
            workspaceId: pass.workspaceId,
            principal: { userId: user.id, via: 'session' },
            action: 'demo_pass.use',
            resourceType: 'demo_pass',
            resourceId: pass.passId,
            metadata: { passId: pass.passId }
          });
          return ctx.json({
            user: pass.user,
            path: pass.targetPath,
            expiresAt: pass.expiresAt.toISOString()
          });
        }
      )
    }
  };
}
