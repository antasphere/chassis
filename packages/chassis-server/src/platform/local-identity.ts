import { type Db } from '@antasphere/chassis-db';
import {
  ACTIVE_WORKSPACE_HEADER,
  type IdentityProvider,
  type InstanceAuthDescriptor,
  type Principal,
  type RequestContext
} from '@antasphere/chassis-contract';
import type { Auth } from '../identity/better-auth.js';
import {
  isWorkspaceSelector,
  resolveMembership,
  type OnWorkspaceMiss
} from '../identity/resolve-membership.js';

/**
 * The template's default IdentityProvider: Better Auth sessions + a LIVE
 * workspace_members re-check on every request. The membership row — not the
 * cookie — is the authorization decision, so deactivating a member locks
 * them out instantly regardless of cookie age.
 *
 * Workspace scoping (ADR 014, user-scoped credential model): a session
 * resolves to exactly ONE workspace per request via the shared
 * resolveMembership rule — the X-Workspace-Id header names it (ACTIVE
 * membership required, else null: fail closed, an unknown workspace and a
 * workspace the user does not belong to are indistinguishable); without the
 * header the user's default membership wins, else the deterministic oldest
 * active membership.
 *
 * API-key and OAuth-bearer resolution live in the auth-context middleware
 * (they are credential formats, not identity sources) and share the SAME
 * selection rule; this provider is the seam the central account service
 * replaces later.
 */
export class LocalIdentityProvider implements IdentityProvider {
  constructor(
    private readonly auth: Auth,
    private readonly db: Db,
    private readonly hasGoogle: boolean,
    private readonly hasOtp: boolean = false,
    private readonly hasPasswordReset: boolean = false,
    private readonly hasEmailChange: boolean = false,
    /** Cloud only: one cached reconcile on a well-formed selector miss. */
    private readonly onWorkspaceMiss?: OnWorkspaceMiss | undefined
  ) {}

  async resolve(ctx: RequestContext): Promise<Principal | null> {
    const session = await this.auth.api.getSession({
      headers: ctx.headers as Headers
    });
    if (!session?.user) return null;

    const requested = ctx.headers.get(ACTIVE_WORKSPACE_HEADER)?.trim() || null;
    let row = await resolveMembership(this.db, session.user.id, requested);
    if (!row && requested && this.onWorkspaceMiss && isWorkspaceSelector(requested)) {
      // Unknown-workspace deep-link retry (cloud): the named workspace may
      // be a hub org granted since the last pass. One cached reconcile, one
      // re-run of the SAME lookup — no recursion.
      await this.onWorkspaceMiss(session.user.id, requested);
      row = await resolveMembership(this.db, session.user.id, requested);
    }
    if (!row) return null;

    return {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      workspaceId: row.workspaceId,
      role: row.role,
      origin: row.origin,
      via: 'session',
      scopes: null,
      ...(row.accountRef ? { accountRef: row.accountRef } : {})
    };
  }

  describe(): InstanceAuthDescriptor {
    // 'oauth' is always on: every instance is an OAuth 2.1 AS for its /mcp (M6).
    const methods: InstanceAuthDescriptor['methods'] = ['password', 'api-key', 'oauth'];
    if (this.hasOtp) methods.push('email-otp');
    if (this.hasGoogle) methods.push('google');
    return {
      methods,
      passwordReset: this.hasPasswordReset,
      emailChange: this.hasEmailChange,
      // Opt-in TOTP needs no email driver — always available on the template.
      twoFactor: true
    };
  }
}
