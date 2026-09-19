import { z } from 'zod';
import { workspaceRoleSchema } from './common.js';
import type { ScopeSchema } from './scope.js';
import { workspaceLookSchema } from './workspaces.js';

/**
 * POST /api/v1/me/onboarding/dismiss (cloud edition ONLY; sessions only —
 * machines 403 fail-closed via the scope allowlist, oss answers the JSON
 * 404 terminator): records the explicit dismissal that flips
 * `firstRunPending` to false, permanently (upsert; an earlier dismissal
 * timestamp is preserved). Idempotent — dismissing twice is a no-op.
 */
export const onboardingDismissedSchema = z.object({
  dismissed: z.literal(true)
});
export type OnboardingDismissed = z.infer<typeof onboardingDismissedSchema>;

/** `/me` reports the credential's scopes, so it is built per tool (../define.ts). */
export function defineMeSchemas<TScope extends string>(scopeSchema: ScopeSchema<TScope>) {
  /**
   * GET /api/v1/me — the resolved AuthContext of the calling principal,
   * whichever credential path it arrived on. The whoami for humans, keys, and
   * (later) OAuth tokens alike; also the MCP get_me tool's backing endpoint.
   *
   * ZERO-MEMBERSHIP sessions answer 200 too (user-scoped federation): a LIVE
   * session whose user holds no active membership — the cloud operator before
   * break-glass, a hub user whose last org was removed — gets
   * `{ workspaces: [], workspace: null, activeWorkspaceId: null, role: null,
   * origin: null, via: 'session' }` instead of a 401, so the dashboard can
   * render the no-organization zero state instead of a login bounce. Machine
   * credentials never see this shape: a key/token whose user has no active
   * membership fails resolution (401) before the route runs.
   */
  const meResponseSchema = z.object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string()
    }),
    /**
     * The ACTIVE workspace this request resolved to (= activeWorkspaceId).
     * Null ONLY for the zero-membership session state described above.
     */
    workspace: z
      .object({
        id: z.string(),
        name: z.string(),
        /**
         * True when this workspace is the lazy projection of a hub org (cloud
         * edition, internal/federation.md) — its MEMBERSHIP is managed at the hub,
         * so clients hide local member/invitation management and link out
         * (P7). Derived from `centralAccountId IS NOT NULL`; the raw hub org
         * id is deliberately never exposed. Always false on oss.
         */
        hubOrigin: z.boolean(),
        /** The workspace's look, a fact of the workspace (schemas/workspaces.ts). */
        look: workspaceLookSchema
      })
      .nullable(),
    /** Null only in the zero-membership session state. */
    role: workspaceRoleSchema.nullable(),
    /**
     * How the caller's membership of the ACTIVE workspace came to exist
     * (mirrors Principal.origin): 'local' = setup/invitation, 'hub' = SSO
     * projection (cloud), 'guest' = a per-deck collaborator (D2) — clients
     * hide the guest-forbidden workspace surfaces (deck creation, files,
     * member roster, export) for 'guest'. Null only in the zero-membership
     * session state.
     */
    origin: z.enum(['local', 'hub', 'guest']).nullable(),
    via: z.enum(['session', 'api_key', 'oauth']),
    scopes: z.array(scopeSchema).nullable(),
    /** Expiry of the presented API key; null for sessions/OAuth or non-expiring keys. */
    apiKeyExpiresAt: z.string().nullable(),
    /**
     * The workspaces this credential can name (user-scoped credential model):
     * EVERY credential kind — session, API key, OAuth bearer — lists ALL of
     * the user's active memberships; the target workspace is a per-request
     * parameter (X-Workspace-Id), never baked into the credential. Clients
     * MUST read the `default` flag to find the selector-less default — never
     * assume index 0.
     */
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: workspaceRoleSchema,
        /** Same semantics as `workspace.hubOrigin`, per listed workspace. */
        hubOrigin: z.boolean(),
        /** Each workspace's look, so the switcher's tiles carry them (schemas/workspaces.ts). */
        look: workspaceLookSchema,
        /**
         * The hub asserted this org suspended (cloud edition): it stays
         * VISIBLE here but requests into it are refused. Always false on oss
         * and on local workspaces.
         */
        suspended: z.boolean(),
        /**
         * The user's default workspace — what a request naming no workspace
         * resolves to. At most one entry carries it; when none does, the
         * deterministic fallback (oldest active membership) applies.
         */
        default: z.boolean()
      })
    ),
    /**
     * The workspace THIS request resolved to — what X-Workspace-Id selects.
     * Null only in the zero-membership session state.
     */
    activeWorkspaceId: z.string().nullable(),
    /**
     * Where membership of the ACTIVE workspace is managed when it is
     * hub-origin (the hub account console, e.g. https://account.antasphere.com)
     * — the dashboard's link-out target (P7). Also set for the CLOUD
     * zero-membership session state (the "create an organization at
     * Antasphere" CTA target). null on oss and on local (non-projected)
     * workspaces.
     */
    hubManageUrl: z.string().nullable(),
    /**
     * Whether `POST /workspaces` would be accepted for this caller RIGHT NOW
     * (PRDCT-2444 / PRDCT-2443) — the one flag the dashboard keys its "new
     * workspace" entry off, on both editions, never the edition itself. True
     * only for a SESSION whose user is not guest-only, while the operator's
     * `MAX_WORKSPACES_PER_USER` dial is not 0; on self-hosted the user must
     * also own fewer workspaces than that cap, on cloud they must also hold a
     * live Antasphere link (the organization is created there, as them).
     * Always false for API keys and OAuth bearers. STAYS TRUE on cloud for a
     * person whose stored sign-in predates workspace creation (the route then
     * answers 401 `hub_reauth_required`): the creation is one sign-in away,
     * and false would hide the entry from them for good. Advisory: the route
     * re-judges everything, and on cloud the hub's own cap is only known once
     * asked.
     */
    canCreateWorkspace: z.boolean(),
    /**
     * First-run welcome still owed (SL-6). CLOUD + SESSION callers ONLY —
     * absent on oss and for every machine credential. TOOL-LOCAL and
     * retry-safe semantics: true iff NO user_onboarding row with a dismissal
     * exists (`NOT EXISTS (row WHERE dismissed_at IS NOT NULL)`), so a lost
     * first-login write still shows the welcome and only an explicit
     * POST /me/onboarding/dismiss (or the deploy backfill) ever hides it.
     * The hub's advisory `tool_first_login` claim plays no part.
     */
    firstRunPending: z.boolean().optional(),
    /**
     * The hint-watch discriminator (SL-4/SL-6). CLOUD + SESSION callers ONLY
     * — absent on oss and for machine credentials. True iff the user's ONLY
     * way in is hub SSO: they hold an `antasphere` account row AND no local
     * credential (password) account row. A break-glass-capable operator has
     * a credential account and is therefore NEVER ssoOnly — the dashboard's
     * hint-watch may auto-sign-out ssoOnly users when the hub hint cookie
     * disappears, and must never sign out an operator.
     */
    ssoOnly: z.boolean().optional()
  });

  return { meResponseSchema };
}
