import { z } from 'zod';
import { plainText, workspaceRoleSchema } from './common.js';

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  invitedBy: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});
export type InvitationInfo = z.infer<typeof invitationSchema>;

export const invitationsListSchema = z.object({
  invitations: z.array(invitationSchema),
  nextCursor: z.string().nullable()
});

export const invitationCreateSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema.default('member')
});
export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

/**
 * The copyable acceptance link is ALWAYS returned — SMTP is never required
 * to get a teammate in. `emailSent` says whether a mail also went out.
 */
export const invitationCreatedSchema = z.object({
  invitation: invitationSchema,
  acceptUrl: z.string(),
  emailSent: z.boolean()
});
export type InvitationCreated = z.infer<typeof invitationCreatedSchema>;

/**
 * Deliberately carries NO account-existence signal (the collaborator-lookup
 * rule, PRDCT-1437): an admin who creates an invitation naming any address
 * holds the copyable accept URL, so the lookup was an instance-global
 * account oracle. The accept page offers sign-in and create-account
 * neutrally; the accept endpoint answers `account_exists` when a create
 * collides.
 */
export const invitationLookupSchema = z.object({
  email: z.string(),
  role: workspaceRoleSchema,
  workspaceName: z.string(),
  expiresAt: z.string()
});
export type InvitationLookup = z.infer<typeof invitationLookupSchema>;

export const invitationAcceptSchema = z.object({
  token: z.string().min(16),
  /** Required when the invited email has no account yet. */
  name: plainText(1, 120).optional(),
  password: z.string().min(12).max(256).optional()
});
export type InvitationAccept = z.infer<typeof invitationAcceptSchema>;

export const invitationAcceptedSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: workspaceRoleSchema
});
