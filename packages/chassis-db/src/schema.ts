import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { account, user } from './auth-schema.js';

// Better Auth owns the shape of user/session/account/verification (generated
// via @better-auth/cli, snapshot-checked in CI); everything below is domain.
export * from './auth-schema.js';

/**
 * Singleton instance row. Exactly one row (id = 'instance') exists after
 * first-boot setup; its presence is what makes POST /api/v1/setup return 410.
 * Inserted by the setup endpoint with ON CONFLICT DO NOTHING so concurrent
 * setup calls cannot both win.
 */
export const instanceSettings = pgTable('instance_settings', {
  id: text('id').primaryKey(), // always 'instance'
  instanceId: text('instance_id').notNull(), // ULID minted at setup; used in usage events + discovery
  name: text('name').notNull(),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }).notNull().defaultNow(),
  schemaVersion: integer('schema_version').notNull().default(1),
  telemetryEnabled: boolean('telemetry_enabled').notNull().default(false),
  /**
   * The EDITION this instance was set up as (R7 boot guard,
   * internal/federation.md). Boot refuses an env EDITION that differs unless
   * EDITION_CHANGE_ALLOWED=true re-stamps it — an edition flip under
   * existing users/workspaces silently changes identity semantics. The
   * default covers pre-column rows honestly: everything so far is oss.
   */
  edition: text('edition').notNull().default('oss'),
  /**
   * The user setup minted as the instance operator (CLOUD-3, PRDCT-1356).
   * On cloud the operator holds NO membership (every cloud workspace is a
   * hub projection), which made them structurally an orphan: the purge
   * deleted the only local credential and the only break-glass identity.
   * A durable record here excludes them from the sweep by construction —
   * not by an env allowlist the operator may never have set. NULL on
   * instances set up before this column existed.
   */
  operatorUserId: text('operator_user_id')
});

/**
 * Multi-workspace schema AND runtime (ADR 014): setup creates the FIRST
 * workspace, the cloud edition creates later ones through the registry's
 * WorkspaceService, and every request is scoped to exactly ONE workspace —
 * the one named by the presented credential. Every domain table carries a
 * workspace_id and every read/write filters on the principal's.
 */
export const workspaceHubStatuses = ['active', 'suspended'] as const;
export type WorkspaceHubStatus = (typeof workspaceHubStatuses)[number];

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Central-rail seam: a projected workspace names the ONE hub org it
    // mirrors (cloud edition SSO, internal/federation.md); NULL = locally owned.
    centralAccountId: text('central_account_id'),
    /**
     * The hub-asserted org status, materialized locally so suspension is
     * readable inside the resolvers (visible-but-blocked). Written ONLY by
     * the cloud edition's hub reconcile; local workspaces and every oss row
     * stay 'active' forever.
     */
    hubStatus: text('hub_status', { enum: workspaceHubStatuses }).notNull().default('active'),
    /**
     * The workspace's look (PRDCT-2439 made it per workspace, in the browser;
     * the settings pass of 2026-09-19 made it a fact of the workspace): one
     * of the brand's theme keys and one pattern key of its library, as the
     * dashboard names them. NULL = the dashboard's default for this
     * workspace (the paper theme, a form dealt from the id). Validated as
     * short slugs server-side; the dashboard falls back to its defaults on
     * a key it does not know, so a retired theme never breaks a workspace.
     */
    lookTheme: text('look_theme'),
    lookPattern: text('look_pattern'),
    /** 0..1: how much of the field's gradient shows, how much grain sits on it. NULL = the brand's constant. */
    lookField: doublePrecision('look_field'),
    lookGrain: doublePrecision('look_grain'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // A hub org projects into AT MOST ONE workspace (migration 0021): two
    // concurrent first-logins into a fresh org race their inserts, and the
    // loser must land on the winner's row (ON CONFLICT + re-select in the
    // SSO projection) — never on a second projection of the same org.
    uniqueIndex('workspaces_central_account_uniq')
      .on(t.centralAccountId)
      .where(sql`${t.centralAccountId} IS NOT NULL`),
    check('workspaces_hub_status_check', sql`${t.hubStatus} IN ('active', 'suspended')`)
  ]
);

export const workspaceRoles = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

/**
 * Where a membership row came from — who its source of truth is (G2,
 * the cloud-binding plan §5). Pure data in Phase 1 (no enforcement):
 *
 *  - 'local': created by setup, workspace invitations, or admin surfaces —
 *    this instance owns it.
 *  - 'hub':   created/updated ONLY by the cloud edition's SSO JIT projection
 *    and re-asserted against the hub (Phase 3+); local surfaces never mint it.
 *  - 'guest': created by the collaborator claim path — an external party
 *    invited to ONE resource whose membership exists only because principal
 *    resolution requires one. Excluded from hub re-assertion; guest
 *    capability limits arrive in Phase 6.
 *
 * No backfill needed: pre-launch, no production data — the default covers
 * every existing row's honest origin.
 */
export const workspaceMemberOrigins = ['local', 'hub', 'guest'] as const;
export type WorkspaceMemberOrigin = (typeof workspaceMemberOrigins)[number];

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: workspaceRoles }).notNull().default('member'),
    origin: text('origin', { enum: workspaceMemberOrigins }).notNull().default('local'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * The user's DEFAULT workspace marker (user-scoped credential model): a
     * request that names no workspace resolves here first, then falls back
     * to the deterministic oldest-active ordering. At most one row per user
     * (partial unique index). Nothing sets it locally yet — on cloud the hub
     * reconcile materializes the hub-level per-user default org into it; on
     * oss it stays false, so resolution is byte-identical to the pre-column
     * behavior.
     */
    isDefault: boolean('is_default').notNull().default(false),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('workspace_members_workspace_user_uniq').on(t.workspaceId, t.userId),
    index('workspace_members_user_idx').on(t.userId),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('workspace_members_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    // ONE default workspace per user, enforced by the database.
    uniqueIndex('workspace_members_user_default_uniq')
      .on(t.userId)
      .where(sql`${t.isDefault}`)
  ]
);

/**
 * Token-bearing invitations. Tokens are never stored — only their sha256 —
 * and the acceptance link always works without SMTP (copyable link).
 *
 * Two tokens per invitation, one row: `token_hash` is the admin-visible
 * copyable link (always returned by the create response), `email_token_hash`
 * is a SECOND token that appears ONLY in the invitation email. Accepting with
 * the emailed token proves control of the invited address (the admin never
 * saw it), so that accept path may honestly set `emailVerified`; accepting
 * with the copyable link proves nothing about the address. Nullable because
 * pre-existing invitations (and rows from products that disable the email
 * leg) have no emailed token.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: workspaceRoles }).notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    emailTokenHash: text('email_token_hash'),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uniq').on(t.tokenHash),
    uniqueIndex('invitations_email_token_hash_uniq').on(t.emailTokenHash),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('invitations_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    index('invitations_email_idx').on(t.email)
  ]
);

/**
 * API keys: `<prefix>_<keyId8>_<secret>`. keyId gives O(1) indexed lookup;
 * the secret is stored as sha256(secret + server pepper) and compared in
 * constant time. Minted by sessions only — a key never mints a key.
 *
 * A key is a USER credential (user-scoped credential model): it acts as its
 * creator, and the target workspace is chosen per request (X-Workspace-Id /
 * the user's default) against the creator's LIVE memberships. `workspace_id`
 * is an OPTIONAL PIN, not the identity: NULL (the mint default) = the key
 * reaches any workspace its creator is an active member of; a value pins the
 * key to that ONE workspace forever (least privilege — and the grandfathered
 * behavior of every key minted before the model change, which stays exactly
 * as issued).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    secretHash: text('secret_hash').notNull(),
    // Which pepper version hashed this key's secret (apps/server
    // apikeys/peppers.ts). Version 1 = the AUTH_SECRET-derived pepper that
    // hashed every key before versioning existed (hence the backfilling
    // default); higher versions come from API_KEY_PEPPERS. Resolution fails
    // closed on a version it cannot map.
    pepperVersion: smallint('pepper_version').notNull().default(1),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // null = never expires; enforced at resolution, normalized to revoked_at
    // by the nightly sweep. Deliberately unindexed: the sweep seq-scans a
    // tiny table once a night, and the hot path rides api_keys_key_id_uniq.
    expiresAt: timestamp('expires_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('api_keys_key_id_uniq').on(t.keyId),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('api_keys_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    // Serves the own-keys listing (keys are user credentials: created_by,
    // created_at DESC, id DESC).
    index('api_keys_created_by_created_id_idx').on(t.createdBy, t.createdAt, t.id)
  ]
);

/**
 * Idempotency-Key replay store for the non-idempotent create POSTs. One row
 * per (workspace, user, client key): claimed (insert-first) before the
 * handler runs, then filled with the response so a retried create replays
 * instead of double-creating. The body is stored AES-256-GCM encrypted
 * (see apps/server middleware/idempotency.ts) because these responses carry
 * one-shot secrets — the full API key, the invitation accept token, the
 * reset link — whose plaintext is deliberately never persisted anywhere
 * else. Rows live 24h; a nightly purge deletes expired ones.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    // Both null while the first request is in flight; filled best-effort
    // once the handler's 2xx response is known.
    responseStatus: integer('response_status'),
    responseBodyEnc: text('response_body_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
  },
  (t) => [
    uniqueIndex('idempotency_keys_ws_user_key_uniq').on(t.workspaceId, t.userId, t.key),
    // Serves the nightly purge (expires_at range scan).
    index('idempotency_keys_expires_idx').on(t.expiresAt)
  ]
);

/**
 * One-time-use ledger for hub→tool exchange JWTs (`POST /sso/cli-connect`,
 * cloud edition only — internal/federation.md P5). The hub mints every 120 s
 * exchange token with a unique `jti`; consuming a token INSERTs its jti
 * here first, and the primary-key conflict IS the replay detection — a
 * replayed token inside its TTL loses the insert and is rejected before it
 * can mint a second key. Postgres-backed so the guard is MULTI-REPLICA
 * SAFE by construction (every replica races the same table), unlike any
 * in-memory set. Rows are inert once `expires_at` passes (the token itself
 * is expired then — the hub never re-mints a jti) and are swept
 * best-effort on later exchanges; the table stays tiny (rows live ~2 min,
 * arrivals are rate-limited), so the sweep needs no index.
 */
export const ssoConnectJtis = pgTable('sso_connect_jtis', {
  jti: text('jti').primaryKey(),
  /** The token's own `exp` — after this the row only documents history. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * The hub-grant PRESENTATION marker (PRDCT-1370, internal/federation.md
 * "Ambiguous refresh outcomes"): written by HubGrantService immediately
 * BEFORE it presents a user's refresh token to the hub's token endpoint,
 * cleared once the hub's answer is known (a rotation, or a definitive
 * refusal). A row that survives therefore means "this exact token was
 * presented and its answer never arrived" — a client-side timeout, a lost
 * response, a socket reset after the hub committed. The hub rotates BEFORE
 * it answers and cannot roll back, so blindly re-presenting that token
 * would trip the hub's RFC 9700 reuse detection and tear down the user's
 * whole (client, user) grant family, the CLI grant included. With the
 * marker in place the next refresh PROBES the token through the hub's
 * RFC 7662 introspection endpoint first (read-only: it never rotates and
 * never tears down) and only presents a token the hub still calls active.
 *
 * Keyed by the `account` row (one hub link per user); `refresh_token` is
 * the ciphertext presented, so a browser re-login that re-seeds the row
 * mid-flight invalidates the marker by construction (the ciphertext no
 * longer matches). Postgres-backed so every replica sees it — the refresh
 * lock is cross-replica, and so must the memory of an unanswered
 * presentation be.
 */
export const hubGrantPresentations = pgTable('hub_grant_presentations', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => account.id, { onDelete: 'cascade' }),
  /** The refresh-token CIPHERTEXT that was presented (matches account.refresh_token). */
  refreshToken: text('refresh_token').notNull(),
  presentedAt: timestamp('presented_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * TOOL-LOCAL first-run onboarding state (SL-6; written on the cloud
 * edition's SSO login path, read by /me). An APP domain table, not a
 * Better Auth column — no drift-guard involvement. The welcome-banner
 * decision reads ONLY this table and is RETRY-SAFE BY CONSTRUCTION:
 * `firstRunPending := NOT EXISTS (row WHERE dismissed_at IS NOT NULL)` —
 * the absence of a DISMISSAL means the welcome is still owed, so a
 * transiently-failed first-login insert self-heals on the next login and
 * only an explicit dismissal ever hides the banner. The hub's advisory
 * `tool_first_login` id_token claim is deliberately ignored for behavior
 * (the hub's user_tool_usage table stays the ECOSYSTEM analytics truth;
 * this table owns the banner). The deploy-time backfill migration inserts
 * DISMISSED rows for every pre-existing user — nobody gets a retroactive
 * welcome.
 */
export const userOnboarding = pgTable('user_onboarding', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** First observed login (informational; the banner keys on dismissed_at). */
  firstLoginAt: timestamp('first_login_at', { withTimezone: true }).notNull().defaultNow(),
  /** NULL = welcome still owed; set once by POST /me/onboarding/dismiss (or the backfill). */
  dismissedAt: timestamp('dismissed_at', { withTimezone: true })
});

/**
 * Audit log: who did what to which resource, when, with which credential.
 * Append-only; bigint identity keeps inserts cheap on the hot path.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // NULL = INSTANCE-attributed: the event belongs to no workspace (ADR 014)
    // — e.g. the orphan-user purge, whose subjects have no workspace home.
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    actorVia: text('actor_via', { enum: ['session', 'api_key', 'oauth', 'system'] }).notNull(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    requestId: text('request_id'),
    ip: text('ip'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt),
    // Serves the admin API's keyset pagination (workspace_id, id DESC).
    index('audit_log_workspace_id_idx').on(t.workspaceId, t.id),
    // Serves the nightly retention purge (created_at range scan across all
    // workspaces); the workspace-leading index above cannot.
    index('audit_log_created_idx').on(t.createdAt)
  ]
);

/**
 * File metadata over the content-addressed StorageDriver. Rows are
 * workspace-scoped; blobs are stored once per (workspace, sha256).
 *
 * `created_by` is nullable with `set null` on user delete (migration 0008):
 * files are WORKSPACE data, not the uploader's personal data — deleting the
 * account anonymizes the uploader (like audit_log.actor_user_id) while the
 * file stays with the workspace (ADR 006).
 */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    originalName: text('original_name').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('files_workspace_sha_uniq').on(t.workspaceId, t.sha256),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('files_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
  ]
);

/**
 * Proof of possession: every user who has PUSHED these exact bytes into the
 * workspace, not just the first one (SL-B1 / ADR 013 on the blob surface).
 *
 * `files` is content-addressed and unique per (workspace, sha256), so a
 * second uploader of identical bytes deduplicates onto the FIRST uploader's
 * row and `files.created_by` keeps naming that first uploader. Once blob
 * reads are per-resource authorized, that single column is no longer a truthful
 * answer to "may this principal see these bytes": a member who uploaded a
 * shared logo that another member had uploaded first would be locked out of
 * a blob they demonstrably hold — and their version commit, which must only
 * bind shas they may read, would be refused. This table records each
 * distinct uploader so possession survives deduplication.
 *
 * `on delete cascade` on both sides: attribution is personal data (it dies
 * with the account, like the anonymized `files.created_by`) and carries no
 * value once the file row is gone.
 */
export const fileUploaders = pgTable(
  'file_uploaders',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.userId] }),
    // Serves the per-principal blob visibility probe (file_id + user_id is
    // the PK, so the lookup is the PK index; this one serves the reverse
    // "everything this user uploaded" direction the cascade delete walks).
    index('file_uploaders_user_idx').on(t.userId)
  ]
);

/**
 * A PROJECT is a subgroup of a workspace: a name, a description, members with
 * a role, and whatever the tool links to it through a table of ITS OWN. The
 * chassis owns the concept; it knows none of the tool's resources, and no
 * tool ever needs a column here: `metadata` is the opaque, owner-defined seam
 * (the same shape and size rules as the tool's own resource metadata).
 *
 * A project is ARCHIVED, never deleted: there is no delete route and no
 * `deleted_at`. `archived_at` takes it out of the default list and makes it
 * read-only; nothing cascades onto what is linked to it.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves the keyset list (workspace_id, created_at DESC, id DESC).
    index('projects_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
  ]
);

/**
 * The three project roles. A SECURITY vocabulary read by SQL predicates
 * (`projects/access.ts`), so a stray value must be impossible: text + CHECK,
 * never a free string.
 */
export const projectRoles = ['manager', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof projectRoles)[number];

/**
 * One row per (project, person). **The grant rides on the workspace
 * membership and dies with it**: `member_id` references the
 * `workspace_members` row with ON DELETE CASCADE, so a removed member (a
 * local delete, or the hub reconcile sweeping a membership) loses every
 * project grant, and a later re-invite starts with none. The person and the
 * workspace are READ THROUGH that row, never copied beside it: a copy could
 * drift, and every predicate joins the membership anyway for its two live
 * facts (`is_active`, `origin <> 'guest'`).
 */
export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: 'cascade' }),
    role: text('role', { enum: projectRoles }).notNull(),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('project_members_project_member_uniq').on(t.projectId, t.memberId),
    // The reverse direction: "every project of this membership" (the list's
    // WHERE for a plain member, and the cascade's walk).
    index('project_members_member_idx').on(t.memberId),
    // Serves the members list's keyset pagination.
    index('project_members_project_created_id_idx').on(t.projectId, t.createdAt, t.id),
    check('project_members_role_check', sql`${t.role} IN ('manager', 'editor', 'viewer')`)
  ]
);

export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileUploaderRow = typeof fileUploaders.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
