import { z } from 'zod';
import { workspaceRoleSchema } from './common.js';

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: workspaceRoleSchema,
  isActive: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable()
});
export type Member = z.infer<typeof memberSchema>;

export const membersListSchema = z.object({
  members: z.array(memberSchema),
  nextCursor: z.string().nullable()
});

// Both fields optional, so an empty body must be refused HERE: `{}` used to
// pass validation and build an empty drizzle `.set({})`, which Postgres
// refuses — an anonymous-shaped 500 for a plain client mistake (FUZZ-5,
// PRDCT-1358).
export const memberUpdateSchema = z
  .object({
    role: workspaceRoleSchema.optional(),
    isActive: z.boolean().optional()
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    error: 'at least one of role or isActive is required'
  });
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

/** Admin-generated password reset link for a member (the SMTP-free recovery path). */
export const memberResetLinkSchema = z.object({
  resetUrl: z.string(),
  expiresAt: z.string()
});
export type MemberResetLink = z.infer<typeof memberResetLinkSchema>;

/** Admin-generated email change link for a member (the SMTP-free email-change path). */
export const memberChangeEmailLinkRequestSchema = z.object({
  newEmail: z.email()
});
export type MemberChangeEmailLinkRequest = z.infer<typeof memberChangeEmailLinkRequestSchema>;

export const memberChangeEmailLinkSchema = z.object({
  verifyUrl: z.string(),
  newEmail: z.string(),
  expiresAt: z.string()
});
export type MemberChangeEmailLink = z.infer<typeof memberChangeEmailLinkSchema>;
