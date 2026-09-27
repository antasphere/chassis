import { z } from 'zod';
import { cursorPageQuerySchema, noControlChars, opaqueJsonChecks, plainText } from './common.js';

/**
 * A PROJECT is a subgroup of a workspace: a name, a description, members with
 * a role, and the tool's resources linked to it. The chassis owns the
 * concept; what a project HOLDS is the tool's (its own link table, its own
 * routes). A project is archived, never deleted.
 */

/**
 * The three project roles, each one containing the one before it:
 *  - `viewer`: reads the project and what is linked to it;
 *  - `editor`: viewer + writes what is linked to it, links resources of their own;
 *  - `manager`: editor + edits the project, archives it, manages its members.
 * A workspace owner or admin acts as a manager on every project.
 */
export const projectRoleSchema = z.enum(['manager', 'editor', 'viewer']);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, manager: 2 };

/** True when `role` is `min` or contains it (`manager` ≥ `editor` ≥ `viewer`). */
export function projectRoleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[min];
}

/**
 * Serialized size cap for a project's owner-defined metadata object, in
 * JSON.stringify characters (an environment-free proxy for bytes: the
 * contract runs in browsers and Node alike).
 */
export const PROJECT_METADATA_MAX_LENGTH = 16 * 1024;

/**
 * Owner-defined structured metadata: a plain JSON object, opaque to the
 * server beyond shape and size. This is the tool's and the integrator's seam,
 * the reason no tool ever needs a column on the project. PATCH replaces the
 * whole object; merge is a client concern.
 */
export const projectMetadataSchema = opaqueJsonChecks(z.record(z.string(), z.unknown())).refine(
  (v) => JSON.stringify(v).length <= PROJECT_METADATA_MAX_LENGTH,
  `metadata must serialize to at most ${PROJECT_METADATA_MAX_LENGTH} characters`
);

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  /** Set while the project is archived: out of the default list, read-only. */
  archivedAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The CALLER's effective role (`manager` for a workspace owner or admin). */
  myRole: projectRoleSchema,
  memberCount: z.number().int()
});
export type Project = z.infer<typeof projectSchema>;

export const projectsListSchema = z.object({
  projects: z.array(projectSchema),
  nextCursor: z.string().nullable()
});
export type ProjectsList = z.infer<typeof projectsListSchema>;

/** `false` (the default) = the live projects, `true` = the archived ones, `all` = both. */
export const projectsArchivedFilterSchema = z.enum(['false', 'true', 'all']);
export type ProjectsArchivedFilter = z.infer<typeof projectsArchivedFilterSchema>;

export const projectsListQuerySchema = cursorPageQuerySchema.extend({
  archived: projectsArchivedFilterSchema.default('false')
});

export const projectCreateSchema = z.object({
  name: plainText(1, 200),
  description: plainText(0, 2000).optional(),
  metadata: projectMetadataSchema.optional()
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

// Every field optional, so an empty body is refused HERE (an empty drizzle
// `.set({})` is a Postgres error, not a client mistake answered 400).
export const projectUpdateSchema = z
  .object({
    name: plainText(1, 200).optional(),
    /** `null` clears the description. */
    description: plainText(0, 2000).nullable().optional(),
    metadata: projectMetadataSchema.optional()
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.metadata !== undefined, {
    error: 'at least one of name, description or metadata is required'
  });
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

/**
 * A project's members are people AND teams, each with a role (PRDCT-2794):
 * one list, told apart by `kind`. A team entry's role is what every active
 * non-guest member of the team holds through it; a person's effective role
 * is the highest of their own entry and their teams' entries. `kind` is
 * `person` on every entry that predates teams, so a reader that never asked
 * for teams still reads what it did.
 */
export const projectPersonMemberSchema = z.object({
  kind: z.literal('person'),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: projectRoleSchema,
  addedBy: z.string().nullable(),
  createdAt: z.string()
});
export type ProjectPersonMember = z.infer<typeof projectPersonMemberSchema>;

export const projectTeamMemberSchema = z.object({
  kind: z.literal('team'),
  teamId: z.string(),
  slug: z.string(),
  name: z.string(),
  /**
   * How many seats the team holds here, the account site's count. A
   * deactivated member keeps their seat (a pause) and holds nothing through
   * it until reactivated; the team's page shows each seat's state.
   */
  membersCount: z.number().int(),
  /** The hub's team id when the team is the account site's projection; null for the tool's own. */
  hubTeamId: z.string().nullable(),
  role: projectRoleSchema,
  addedBy: z.string().nullable(),
  createdAt: z.string()
});
export type ProjectTeamMember = z.infer<typeof projectTeamMemberSchema>;

export const projectMemberSchema = z.discriminatedUnion('kind', [
  projectPersonMemberSchema,
  projectTeamMemberSchema
]);
export type ProjectMember = z.infer<typeof projectMemberSchema>;

export const projectMembersListSchema = z.object({
  members: z.array(projectMemberSchema),
  nextCursor: z.string().nullable()
});
export type ProjectMembersList = z.infer<typeof projectMembersListSchema>;

/**
 * Add one of the workspace's OWN active members, named by user id or by
 * email, or one of the workspace's teams by its id: exactly one of the three.
 * No invitation, no claim token, no account is ever minted here.
 */
export const projectMemberAddSchema = z
  .object({
    userId: plainText(1, 200).optional(),
    email: z.email().optional(),
    teamId: z.uuid().optional(),
    role: projectRoleSchema
  })
  .refine((v) => [v.userId, v.email, v.teamId].filter((k) => k !== undefined).length === 1, {
    error: 'exactly one of userId, email or teamId is required'
  });
export type ProjectMemberAdd = z.infer<typeof projectMemberAddSchema>;

export const projectMemberRoleSchema = z.object({ role: projectRoleSchema });
export type ProjectMemberRoleUpdate = z.infer<typeof projectMemberRoleSchema>;

/** A user id is Better Auth's text id, never a uuid: bounded free text, no control characters. */
export const projectMemberParamsSchema = z.object({
  id: z.uuid(),
  userId: noControlChars(z.string().min(1).max(200))
});

/** `{id}` the project and `{teamId}` the team, both uuids. */
export const projectTeamParamsSchema = z.object({ id: z.uuid(), teamId: z.uuid() });
