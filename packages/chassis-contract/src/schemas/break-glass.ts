import { z } from 'zod';
import { workspaceRoleSchema } from './common.js';

/**
 * Break-glass superadmin recovery (ADR 010). Session-only endpoints gated by
 * the SUPERADMIN_EMAILS env allowlist — deliberately unlisted in the machine
 * scope allowlist, so API keys and OAuth tokens 403 fail-closed.
 */

/**
 * Optional target user (omitted = the calling superadmin) and target
 * workspace. `workspaceId` may be omitted ONLY while the instance runs a
 * single workspace (every pre-ADR-012 deployment); a multi-workspace
 * instance answers 400 workspace_required — recovery must name its target
 * explicitly, never guess one.
 */
export const breakGlassClaimOwnershipRequestSchema = z.object({
  userId: z.string().min(1).optional(),
  workspaceId: z.uuid().optional()
});
export type BreakGlassClaimOwnershipRequest = z.infer<typeof breakGlassClaimOwnershipRequestSchema>;

export const breakGlassClaimOwnershipSchema = z.object({
  memberId: z.string(),
  userId: z.string(),
  email: z.string(),
  /** The workspace the ownership was claimed in. */
  workspaceId: z.string(),
  role: workspaceRoleSchema,
  isActive: z.boolean(),
  /** true when the membership was created; false when an existing row was promoted/reactivated. */
  created: z.boolean()
});
export type BreakGlassClaimOwnership = z.infer<typeof breakGlassClaimOwnershipSchema>;

export const breakGlassResetTwoFactorRequestSchema = z.object({
  userId: z.string().min(1)
});
export type BreakGlassResetTwoFactorRequest = z.infer<typeof breakGlassResetTwoFactorRequestSchema>;

export const breakGlassResetTwoFactorSchema = z.object({
  userId: z.string(),
  /** true when a factor actually existed (row or enabled flag) before the reset. */
  hadTwoFactor: z.boolean()
});
export type BreakGlassResetTwoFactor = z.infer<typeof breakGlassResetTwoFactorSchema>;
