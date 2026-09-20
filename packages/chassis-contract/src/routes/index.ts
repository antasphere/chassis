import { createRoute, z } from '@hono/zod-openapi';
import type { ChassisContract } from '../define.js';
import type { ToolIdentity } from '../identity.js';
import { apiErrorSchema, cursorPageQuerySchema } from '../schemas/common.js';
import { instanceInfoSchema } from '../schemas/instance.js';
import { setupRequestSchema, setupResponseSchema } from '../schemas/setup.js';
import { onboardingDismissedSchema } from '../schemas/me.js';
import {
  workspaceCreatedSchema,
  workspaceCreateSchema,
  workspaceUpdatedSchema,
  workspaceUpdateSchema
} from '../schemas/workspaces.js';
import {
  memberChangeEmailLinkRequestSchema,
  memberChangeEmailLinkSchema,
  memberResetLinkSchema,
  membersListSchema,
  memberSchema,
  memberUpdateSchema
} from '../schemas/members.js';
import {
  invitationAcceptedSchema,
  invitationAcceptSchema,
  invitationCreatedSchema,
  invitationCreateSchema,
  invitationLookupSchema,
  invitationsListSchema
} from '../schemas/invitations.js';
import { auditListQuerySchema, auditListSchema } from '../schemas/audit.js';
import {
  cliAuthCompleteSchema,
  cliAuthRequestedSchema,
  cliAuthRequestSchema,
  cliAuthRevokedSchema
} from '../schemas/cli-auth.js';
import { ssoCliConnectSchema } from '../schemas/sso-connect.js';
import { ssoLogoutResponseSchema } from '../schemas/sso-logout.js';
import {
  breakGlassClaimOwnershipRequestSchema,
  breakGlassClaimOwnershipSchema,
  breakGlassResetTwoFactorRequestSchema,
  breakGlassResetTwoFactorSchema
} from '../schemas/break-glass.js';
import { fileSchema, filesListSchema, fileUploadedSchema, fileUploadQuerySchema } from '../schemas/files.js';

/**
 * Server-only entry: route contracts for @hono/zod-openapi. Importing this
 * path pulls Hono — the dashboard and SDK must import the package root
 * instead. The OpenAPI document at /api/v1/openapi.json is generated from
 * these definitions; they are the single source of truth for the API shape.
 */

export const jsonBody = <T>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description
});

/**
 * JSON REQUEST bodies are marked `required` so @hono/zod-openapi always runs
 * the body validator. Without the flag, a request with a missing/non-JSON
 * content-type SKIPS validation entirely and hands the handler `{}` cast as
 * the body type — a guaranteed TypeError → 500 on every pre-auth body route
 * (the schema-mismatch 400 path never runs). Responses keep plain jsonBody
 * (`required` is not a response-object field).
 */
export const jsonRequestBody = <T>(schema: T, description: string) => ({
  ...jsonBody(schema, description),
  required: true
});

export const errorResponses = {
  400: jsonBody(apiErrorSchema, 'Validation error'),
  401: jsonBody(apiErrorSchema, 'Not authenticated'),
  403: jsonBody(apiErrorSchema, 'Not authorized'),
  404: jsonBody(apiErrorSchema, 'Not found'),
  410: jsonBody(apiErrorSchema, 'Gone'),
  429: jsonBody(apiErrorSchema, 'Rate limited'),
  500: jsonBody(apiErrorSchema, 'Internal error')
} as const;

/** Opt-in retry-safe creates: replay-or-409 semantics per docs/security/security.md. */
export const idempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).max(200).optional()
});

/**
 * Every `{id}` path param is a UUID, validated in the contract: a non-UUID
 * id answers a clean 400 validation_error instead of reaching Postgres and
 * surfacing its uuid-cast error as a sanitized 500 (see LESSONS.md).
 */
export const uuidParams = z.object({ id: z.uuid() });

export const instanceRoute = createRoute({
  method: 'get',
  path: '/instance',
  tags: ['instance'],
  summary: 'Instance discovery (unauthenticated, cacheable)',
  responses: {
    200: jsonBody(instanceInfoSchema, 'Instance descriptor')
  }
});

export const setupRoute = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['instance'],
  summary: 'One-shot first-boot setup: create the owner and the workspace',
  request: {
    body: jsonRequestBody(setupRequestSchema, 'Setup payload')
  },
  responses: {
    201: jsonBody(setupResponseSchema, 'Instance initialized'),
    400: errorResponses[400],
    403: errorResponses[403],
    410: errorResponses[410],
    500: errorResponses[500]
  }
});

// ── Onboarding dismiss (cloud edition only) ─────────────────────────────────
// SESSION-ONLY like /sso/logout: deliberately UNLISTED in the machine scope
// allowlist (fail-closed 403 for keys/tokens); the handler resolves the
// session route-locally so zero-membership sessions can dismiss too. The
// route exists ONLY on EDITION=cloud; oss answers the JSON 404 terminator.

export const onboardingDismissRoute = createRoute({
  method: 'post',
  path: '/me/onboarding/dismiss',
  tags: ['auth'],
  summary: 'Dismiss the first-run welcome (cloud edition; sessions only; idempotent)',
  responses: {
    200: jsonBody(onboardingDismissedSchema, 'Dismissal recorded — firstRunPending is now false'),
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// ── Workspace creation (PRDCT-2444 / PRDCT-2443) ────────────────────────────
// SESSION-ONLY: deliberately UNLISTED in the machine scope allowlist
// (fail-closed 403 for keys/tokens) and re-checked in the handler. One route
// for both editions: local creation on self-hosted, creation at the hub AS
// THE CALLER + immediate local projection on cloud.

export const workspaceCreateRoute = createRoute({
  method: 'post',
  path: '/workspaces',
  tags: ['workspaces'],
  summary: 'Create another workspace with the caller as its owner (sessions only)',
  request: { body: jsonRequestBody(workspaceCreateSchema, 'The new workspace'), headers: idempotencyHeaders },
  responses: {
    201: jsonBody(workspaceCreatedSchema, 'The created workspace (its LOCAL id)'),
    400: errorResponses[400],
    401: jsonBody(
      apiErrorSchema,
      'Not authenticated; hub_grant_expired or hub_reauth_required on cloud — both healed by signing in again'
    ),
    403: jsonBody(
      apiErrorSchema,
      'session_required, guest_forbidden, workspace_creation_disabled, workspace_limit_reached, hub_link_required, hub_unavailable, hub_refused'
    ),
    409: jsonBody(apiErrorSchema, 'Idempotency conflict'),
    429: errorResponses[429]
  }
});

// ── Members ──────────────────────────────────────────────────────────────────

export const workspaceUpdateRoute = createRoute({
  method: 'patch',
  path: '/workspace',
  tags: ['workspaces'],
  summary: "Change the active workspace's name or look (owner/admin, sessions only)",
  request: { body: jsonRequestBody(workspaceUpdateSchema, 'The name, the look, or both') },
  responses: {
    200: jsonBody(workspaceUpdatedSchema, 'The workspace as it now is'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: jsonBody(
      apiErrorSchema,
      'session_required, insufficient_role, guest_forbidden, hub_managed (a rename of a hub-origin workspace)'
    )
  }
});

export const membersListRoute = createRoute({
  method: 'get',
  path: '/members',
  tags: ['members'],
  summary: 'List workspace members (cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: { 200: jsonBody(membersListSchema, 'Members, newest first'), 401: errorResponses[401] }
});

export const memberUpdateRoute = createRoute({
  method: 'patch',
  path: '/members/{id}',
  tags: ['members'],
  summary: 'Change a member role or active state (admin+)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(memberUpdateSchema, 'Fields to change')
  },
  responses: {
    200: jsonBody(memberSchema, 'Updated member'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const memberDeleteRoute = createRoute({
  method: 'delete',
  path: '/members/{id}',
  tags: ['members'],
  summary: 'Delete a member account (admin+; sessions only — files they uploaded stay)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(memberSchema, 'Deleted member (final snapshot)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Account belongs to other workspaces (member_of_other_workspaces)')
  }
});

export const memberResetLinkRoute = createRoute({
  method: 'post',
  path: '/members/{id}/reset-link',
  tags: ['members'],
  summary: 'Generate a one-time password reset link for a member (OWNER only)',
  request: { params: uuidParams, headers: idempotencyHeaders },
  responses: {
    200: jsonBody(memberResetLinkSchema, 'Copyable reset link + expiry'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});

export const memberChangeEmailLinkRoute = createRoute({
  method: 'post',
  path: '/members/{id}/change-email-link',
  tags: ['members'],
  summary: 'Generate a one-time email change link for a member (OWNER only; the link also signs them in)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(memberChangeEmailLinkRequestSchema, 'The new email address'),
    headers: idempotencyHeaders
  },
  responses: {
    200: jsonBody(memberChangeEmailLinkSchema, 'Copyable email change link + expiry'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Email already in use (email_taken) or idempotency conflict')
  }
});

// ── Invitations ──────────────────────────────────────────────────────────────

export const invitationsListRoute = createRoute({
  method: 'get',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'List invitations (admin+, cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(invitationsListSchema, 'Invitations, newest first'),
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

export const invitationCreateRoute = createRoute({
  method: 'post',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'Invite by email (admin+). Always returns a copyable accept link.',
  request: { body: jsonRequestBody(invitationCreateSchema, 'Invitee'), headers: idempotencyHeaders },
  responses: {
    201: jsonBody(invitationCreatedSchema, 'Invitation + copyable link'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: jsonBody(apiErrorSchema, 'Already a member, already invited, or idempotency conflict')
  }
});

export const invitationRevokeRoute = createRoute({
  method: 'delete',
  path: '/invitations/{id}',
  tags: ['invitations'],
  summary: 'Revoke an open invitation (admin+)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(invitationSchemaRef(), 'Revoked invitation'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const invitationLookupRoute = createRoute({
  method: 'get',
  path: '/invitations/lookup',
  tags: ['invitations'],
  summary: 'Resolve an invitation token (public; drives the accept page)',
  request: { query: z.object({ token: z.string().min(16) }) },
  responses: {
    200: jsonBody(invitationLookupSchema, 'Invitation context'),
    404: errorResponses[404]
  }
});

export const invitationAcceptRoute = createRoute({
  method: 'post',
  path: '/invitations/accept',
  tags: ['invitations'],
  summary: 'Accept an invitation (public: creates the account when needed)',
  request: { body: jsonRequestBody(invitationAcceptSchema, 'Token + credentials for new accounts') },
  responses: {
    200: jsonBody(invitationAcceptedSchema, 'Joined the workspace'),
    400: errorResponses[400],
    403: jsonBody(apiErrorSchema, 'Workspace membership is hub-managed (hub_managed, cloud edition)'),
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Account exists — sign in to accept'),
    410: errorResponses[410]
  }
});

// ── CLI auth (browserless email-OTP → API key) ──────────────────────────────
// The MINT pair is PUBLIC pre-auth like /setup: listed in PUBLIC_API_PATHS
// (middleware/auth-context.ts) and deliberately UNLISTED in the machine
// scope allowlist — a key/token presented there is pointless anyway (the flow
// EXISTS to obtain a key) and 403s fail-closed. Sign-up stays closed: the
// flow rides the emailOTP plugin's disableSignUp, so codes only sign in
// EXISTING accounts. Both endpoints are rate-limited (request: the OTP wall
// per IP + email; complete: the login wall per IP + email) and OTP
// verification is better-auth's atomic, attempt-limited (3) check. On the
// CLOUD edition both refuse outright (403 cli_otp_disabled) — hub-only login
// (D1): CLI keys are minted via `antasphere login` + /sso/cli-connect there.
// DELETE /cli/auth/key is the logout counterpart: an AUTHENTICATED route that
// revokes exactly the PRESENTING key (self-revocation — possession is the
// authority to kill itself), machine-allowed under presentations:write in the
// scope allowlist, and open on BOTH editions (revocation narrows access).

export const cliAuthRequestRoute = createRoute({
  method: 'post',
  path: '/cli/auth/request',
  tags: ['cli-auth'],
  summary: 'Send a sign-in code to an email (public; generic success — no account enumeration)',
  request: { body: jsonRequestBody(cliAuthRequestSchema, 'The account email') },
  responses: {
    200: jsonBody(cliAuthRequestedSchema, 'Code sent if the account exists'),
    400: jsonBody(apiErrorSchema, 'Validation error, or no email driver (otp_unavailable)'),
    403: jsonBody(apiErrorSchema, 'cli_otp_disabled: cloud edition — sign in with `antasphere login`'),
    429: errorResponses[429],
    500: errorResponses[500]
  }
});

export const cliAuthRevokeRoute = createRoute({
  method: 'delete',
  path: '/cli/auth/key',
  tags: ['cli-auth'],
  summary: 'Revoke the PRESENTING API key (CLI logout; self-revocation only)',
  responses: {
    200: jsonBody(cliAuthRevokedSchema, 'The presenting key is revoked'),
    401: errorResponses[401],
    403: jsonBody(apiErrorSchema, 'The credential is not an API key (sessions manage keys in the dashboard)')
  }
});

// ── SSO logout (cloud edition only) ──────────────────────────────────────────
// SESSION-ONLY by construction: deliberately UNLISTED in the machine scope
// allowlist (middleware/scopes.ts), so API keys and OAuth bearers 403
// fail-closed before the handler runs; the handler resolves the Better Auth
// session route-locally (the /me zero-state pattern) so ZERO-MEMBERSHIP
// sessions — the cloud operator pre-break-glass, a hub user whose last org
// was removed — can still log out. The route exists ONLY on EDITION=cloud;
// oss answers the JSON 404 terminator. Order inside the handler: resolve
// session → build the hub end-session URL (any failure → null) → revoke the
// local session server-side (better-auth's cookie-clearing Set-Cookie is
// forwarded) → clear the shared hint cookie → respond. The local revoke and
// hint clear happen even when url is null.

export const ssoLogoutRoute = createRoute({
  method: 'post',
  path: '/sso/logout',
  tags: ['sso'],
  summary:
    'Single logout (cloud edition; sessions only): revokes the local session, clears the SSO hint cookie, ' +
    'and returns the hub end-session URL to visit (null = local signout only)',
  responses: {
    200: jsonBody(ssoLogoutResponseSchema, 'Local session revoked; url is the hub logout leg or null'),
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * The export route, with the name of the scope a key needs in its summary.
 * That name is the tool's, so the SERVER registers the contract built from
 * the tool's identity (`defineWorkspaceExportRoute(identity.scopes.dataExport)`)
 * and the OpenAPI document prints the tool's own scope. The static export
 * below is the same contract with no tool named: what a client-side reader of
 * the route list (the SDK's coverage guard) sees.
 */
export const defineWorkspaceExportRoute = (exportScope: string) =>
  createRoute({
    method: 'get',
    path: '/workspace/export',
    tags: ['workspace'],
    summary: `Full workspace export as a streamed zip (admin+; keys need ${exportScope})`,
    responses: {
      // Deliberately NO `content` key on the 200: that is what lets the
      // api.openapi handler legally return a plain streamed Response.
      200: { description: 'Zip archive stream (application/zip)' },
      401: errorResponses[401],
      403: errorResponses[403],
      429: errorResponses[429]
    }
  });

export const workspaceExportRoute = defineWorkspaceExportRoute('the export scope');

// ── Break-glass (superadmin recovery, ADR 010) ──────────────────────────────
// Session-only by construction: both paths are deliberately UNLISTED in the
// machine scope allowlist (middleware/scopes.ts), so API keys and OAuth
// tokens 403 fail-closed. The handlers additionally resolve the Better Auth
// session directly and require a verified email on the SUPERADMIN_EMAILS
// allowlist — no membership required (the recovering operator may have none).

export const breakGlassClaimOwnershipRoute = createRoute({
  method: 'post',
  path: '/admin/break-glass/claim-ownership',
  tags: ['admin'],
  summary:
    'Break-glass: make the calling superadmin (or a named existing user) an ACTIVE OWNER of a workspace (superadmin sessions only; adds an owner, never removes one; workspaceId required once the instance has several)',
  request: {
    body: jsonRequestBody(
      breakGlassClaimOwnershipRequestSchema,
      'Optional target user (default: the caller) and target workspace (required with several workspaces)'
    )
  },
  responses: {
    200: jsonBody(breakGlassClaimOwnershipSchema, 'The recovered owner membership'),
    400: jsonBody(
      apiErrorSchema,
      'Validation error, or several workspaces and none named (workspace_required)'
    ),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Instance not set up yet (not_setup)'),
    429: errorResponses[429]
  }
});

export const breakGlassResetTwoFactorRoute = createRoute({
  method: 'post',
  path: '/admin/break-glass/reset-2fa',
  tags: ['admin'],
  summary: "Break-glass: clear a locked-out user's 2FA (superadmin sessions only, audited)",
  request: {
    body: jsonRequestBody(breakGlassResetTwoFactorRequestSchema, 'The target user')
  },
  responses: {
    200: jsonBody(breakGlassResetTwoFactorSchema, '2FA cleared (idempotent)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    429: errorResponses[429]
  }
});

// ── Audit ────────────────────────────────────────────────────────────────────

export const auditListRoute = createRoute({
  method: 'get',
  path: '/audit',
  tags: ['audit'],
  summary: 'Read the audit log (admin+, cursor-paginated, filterable)',
  description:
    'Every filter is optional and they combine with AND: `q` (actor email or action, case-insensitive), ' +
    '`action` (comma-separated; an item ending in `.` matches the family), `actorVia` (comma-separated), ' +
    '`actor` (a user id, or `system`), `resourceType`, `resourceId`, `from`/`to` (ISO 8601). ' +
    'The cursor stays the last row id; the same filters must ride every page of one listing. ' +
    '`total` is counted on the first page only.',
  request: { query: auditListQuerySchema },
  responses: {
    200: jsonBody(auditListSchema, 'Audit entries, newest first'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// Local alias to keep the revoke route readable without a forward reference.
function invitationSchemaRef() {
  return invitationsListSchema.shape.invitations.element;
}

// ── Files ────────────────────────────────────────────────────────────────────
// Every read here is per-deck authorized (ADR 013): you get the blobs you
// uploaded plus those belonging to decks you can read; workspace admins and
// owners get the whole workspace. Anything outside that scope answers 404,
// never 403 — a blob you cannot read must not be probeable.

export const filesListRoute = createRoute({
  method: 'get',
  path: '/files',
  tags: ['files'],
  summary: 'List the files you can read (cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: { 200: jsonBody(filesListSchema, 'Files, newest first'), 401: errorResponses[401] }
});

export const fileGetRoute = createRoute({
  method: 'get',
  path: '/files/{id}',
  tags: ['files'],
  summary: 'File metadata (404 when you cannot read the blob)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(fileSchema, 'File'),
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const fileUploadRoute = createRoute({
  method: 'post',
  path: '/files',
  tags: ['files'],
  summary: 'Upload raw bytes (streamed; content-type header = file type)',
  request: {
    query: fileUploadQuerySchema,
    body: {
      content: { 'application/octet-stream': { schema: z.any() } },
      description: 'The file bytes'
    }
  },
  responses: {
    201: jsonBody(fileUploadedSchema, 'Stored (content-addressed, idempotent per workspace)'),
    401: errorResponses[401],
    403: errorResponses[403],
    413: jsonBody(apiErrorSchema, 'Payload exceeds the instance size cap'),
    400: errorResponses[400]
  }
});

/**
 * The delete route, with the tool's wording of its 409. What references a
 * blob is the tool's to name, so the SERVER registers the contract built from
 * the tool's copy (`defineFileDeleteRoute(copy.fileInUseOpenApi)`), the same
 * way as `defineWorkspaceExportRoute`; the static export names no domain.
 */
export const defineFileDeleteRoute = (inUseDescription: string) =>
  createRoute({
    method: 'delete',
    path: '/files/{id}',
    tags: ['files'],
    summary: 'Delete a file (metadata soft-deleted, blob removed)',
    request: { params: uuidParams },
    responses: {
      200: jsonBody(fileSchema, 'Deleted file'),
      401: errorResponses[401],
      404: errorResponses[404],
      // ADR 011 blob-delete guard: a blob the tool still references is not
      // deletable through the generic files surface.
      409: jsonBody(apiErrorSchema, inUseDescription)
    }
  });

export const fileDeleteRoute = defineFileDeleteRoute('file_in_use: the tool still references this file');

/**
 * The route contracts that carry the TOOL's scope vocabulary: every route
 * whose request or response schema transitively holds `scopeSchema`. Built
 * from the contract `defineChassisContract({ scopes })` returned and from the
 * tool's identity (the one summary that names the CLI key's grant) — no
 * module-level state, one instantiation per tool.
 */
export function defineChassisRoutes<TScope extends string>(
  contract: ChassisContract<TScope>,
  identity: Pick<ToolIdentity, 'cliKeyScopesLabel'>
) {
  const {
    meResponseSchema,
    apiKeyCreatedSchema,
    apiKeyCreateSchema,
    apiKeySchema,
    apiKeysListSchema,
    cliAuthCompletedSchema
  } = contract;

  const meRoute = createRoute({
    method: 'get',
    path: '/me',
    tags: ['auth'],
    summary: 'Resolved identity of the calling principal',
    responses: {
      200: jsonBody(meResponseSchema, 'The caller identity'),
      401: errorResponses[401]
    }
  });

  // ── API keys ─────────────────────────────────────────────────────────────────

  const apiKeysListRoute = createRoute({
    method: 'get',
    path: '/api-keys',
    tags: ['api-keys'],
    summary: 'List YOUR API keys (keys are user credentials; cursor-paginated)',
    request: { query: cursorPageQuerySchema },
    responses: { 200: jsonBody(apiKeysListSchema, 'Your API keys, newest first'), 401: errorResponses[401] }
  });

  const apiKeyCreateRoute = createRoute({
    method: 'post',
    path: '/api-keys',
    tags: ['api-keys'],
    summary:
      'Mint an API key (sessions only — a key never mints a key). User-scoped by default; pass workspaceId to pin it to one workspace',
    request: {
      body: jsonRequestBody(apiKeyCreateSchema, 'Key name, scopes, and the optional workspace pin'),
      headers: idempotencyHeaders
    },
    responses: {
      201: jsonBody(apiKeyCreatedSchema, 'Created; the full key appears only here'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: jsonBody(apiErrorSchema, 'sessions_only, or no_membership for the requested pin'),
      409: jsonBody(apiErrorSchema, 'Idempotency conflict')
    }
  });

  const apiKeyRevokeRoute = createRoute({
    method: 'delete',
    path: '/api-keys/{id}',
    tags: ['api-keys'],
    summary: 'Revoke an API key (its creator only — keys are user credentials)',
    request: { params: uuidParams },
    responses: {
      200: jsonBody(apiKeySchema, 'Revoked key'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404]
    }
  });

  const cliAuthCompleteRoute = createRoute({
    method: 'post',
    path: '/cli/auth/complete',
    tags: ['cli-auth'],
    summary: `Verify a sign-in code and mint an API key (shown once, ${identity.cliKeyScopesLabel})`,
    request: { body: jsonRequestBody(cliAuthCompleteSchema, 'Email + code (+ optional key name/TTL)') },
    responses: {
      201: jsonBody(cliAuthCompletedSchema, 'Key minted; the full key appears only here'),
      400: jsonBody(apiErrorSchema, 'Validation error, or no email driver (otp_unavailable)'),
      401: jsonBody(apiErrorSchema, 'invalid_otp: wrong/expired code or no such account'),
      403: jsonBody(
        apiErrorSchema,
        'two_factor_required, no active workspace membership, or cli_otp_disabled (cloud edition)'
      ),
      429: jsonBody(apiErrorSchema, 'Too many attempts'),
      500: errorResponses[500]
    }
  });

  // ── CLI cross-tool connect (cloud edition only) ─────────────────────────────
  // PUBLIC pre-auth endpoint like /cli/auth/* (listed in PUBLIC_API_PATHS,
  // unlisted in the machine scope allowlist): the hub-minted 120 s exchange
  // JWT IS the credential — verified against the hub JWKS with hard iss/aud
  // pinning, `purpose: 'sso-connect'` required, and the `jti` consumed
  // one-time-use (a replay inside the TTL mints nothing). On success the user
  // is JIT-provisioned through the SAME projection path as an SSO login and
  // an ordinary `slk_` key is minted, bound to the projected workspace. The
  // route exists ONLY on EDITION=cloud; oss answers 404. Rate-limited (the
  // login wall, per IP).

  const ssoCliConnectRoute = createRoute({
    method: 'post',
    path: '/sso/cli-connect',
    tags: ['sso'],
    summary: 'Exchange a hub-minted connect JWT for an API key (cloud edition; shown once)',
    request: { body: jsonRequestBody(ssoCliConnectSchema, 'The hub exchange token') },
    responses: {
      201: jsonBody(cliAuthCompletedSchema, 'Key minted; the full key appears only here'),
      400: jsonBody(apiErrorSchema, 'Validation error'),
      401: jsonBody(apiErrorSchema, 'invalid_token: bad signature/iss/aud/purpose, expired, or replayed jti'),
      403: jsonBody(
        apiErrorSchema,
        'Provisioning refused (identity/email conflict, link refused) or hub_grant_missing: no usable hub grant — a key is never minted born-dead'
      ),
      429: errorResponses[429],
      500: errorResponses[500]
    }
  });

  return {
    meRoute,
    apiKeysListRoute,
    apiKeyCreateRoute,
    apiKeyRevokeRoute,
    cliAuthCompleteRoute,
    ssoCliConnectRoute
  };
}
