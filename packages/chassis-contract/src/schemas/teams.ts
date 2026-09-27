import { z } from 'zod';
import { cursorPageQuerySchema, noControlChars, plainText, workspaceRoleSchema } from './common.js';

/**
 * Teams: named groups of the workspace's people, on BOTH editions with the
 * same routes and screens; only the source differs (PRDCT-2813). On the
 * self-hosted edition, and in a cloud-local workspace, owners and admins
 * make and shape them here; in a hub-origin workspace they are the hub's
 * projection, read here and managed on the account site (every write answers
 * `hub_managed`). Every non-guest member reads the teams and a team's
 * members. A team holds the workspace's MEMBERSHIPS, so it can never hold an
 * outsider, and a person leaves every team with their membership.
 *
 * The shapes mirror the hub's own teams contract (its `schemas/teams.ts`), so
 * the two Teams pages read the same; a person is named by their user id or
 * their email, as on this tool's project routes.
 */

/** A team's slug: lowercase words joined by single dashes, unique within a workspace. */
export const teamSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters and digits, joined by single dashes')
  .min(1)
  .max(60);

export const teamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  membersCount: z.number().int(),
  /** The caller belongs to this team. */
  isMember: z.boolean(),
  /**
   * The hub's team id when the team is the account site's projection (the
   * Manage link opens it there); null for a team the tool owns.
   */
  hubTeamId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Team = z.infer<typeof teamSchema>;

export const teamsListSchema = z.object({
  teams: z.array(teamSchema),
  nextCursor: z.string().nullable()
});
export type TeamsList = z.infer<typeof teamsListSchema>;

export const teamsListQuerySchema = cursorPageQuerySchema;

export const teamCreateSchema = z.object({
  name: plainText(1, 80),
  /** Absent: derived from the name (lowercased, non-alphanumerics to dashes, cut to 60). */
  slug: teamSlugSchema.optional()
});
export type TeamCreate = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z
  .object({
    name: plainText(1, 80).optional(),
    slug: teamSlugSchema.optional()
  })
  .refine((b) => b.name !== undefined || b.slug !== undefined, { error: 'nothing to change' });
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;

export const teamMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  /** The person's role in the WORKSPACE (a team has no roles of its own). */
  role: workspaceRoleSchema,
  isActive: z.boolean(),
  addedAt: z.string()
});
export type TeamMemberInfo = z.infer<typeof teamMemberSchema>;

export const teamMembersListSchema = z.object({
  members: z.array(teamMemberSchema),
  nextCursor: z.string().nullable()
});
export type TeamMembersList = z.infer<typeof teamMembersListSchema>;

/**
 * Seat one of the workspace's OWN active non-guest members, named by user id
 * or by email: exactly one of the two. Nothing is invited or minted here.
 */
export const teamMemberAddSchema = z
  .object({
    userId: plainText(1, 200).optional(),
    email: z.email().optional()
  })
  .refine((v) => (v.userId === undefined) !== (v.email === undefined), {
    error: 'exactly one of userId or email is required'
  });
export type TeamMemberAdd = z.infer<typeof teamMemberAddSchema>;

/** `{id}` the team (a uuid); `{userId}` Better Auth's text id: bounded free text, no control characters. */
export const teamMemberParamsSchema = z.object({
  id: z.uuid(),
  userId: noControlChars(z.string().min(1).max(200))
});
