import { z } from 'zod';
import { plainText } from './common.js';

/**
 * A workspace's look: one of the dashboard's theme keys and one pattern key
 * of the brand's library. A fact of the WORKSPACE (every member sees the
 * same tile), kept as two short slugs the server does not interpret: the
 * dashboard owns the catalogue and falls back to its defaults on a key it
 * does not know, so retiring a theme never breaks a workspace. null = the
 * dashboard's default for this workspace.
 */
const lookKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'a short lowercase key')
  .nullable();
/**
 * How much of the field's gradient reaches the page, and how much grain sits
 * on it: 0..1, the workspace's too (they were each browser's until
 * 2026-09-19, so two members never saw the same page). null = the brand's
 * constant.
 */
const lookLevel = z.number().min(0).max(1).nullable();
export const workspaceLookSchema = z.object({
  theme: lookKey,
  pattern: lookKey,
  field: lookLevel,
  grain: lookLevel
});
export type WorkspaceLook = z.infer<typeof workspaceLookSchema>;

/**
 * POST /api/v1/workspaces — a signed-in person creates ANOTHER workspace from
 * inside the product (PRDCT-2444 self-hosted, PRDCT-2443 cloud). One route,
 * one body, one answer on both editions; the dashboard keys off
 * `/me.canCreateWorkspace` and never sniffs the edition.
 *
 *  - Self-hosted: the workspace is created locally with the caller as its
 *    active owner, under the operator's per-person cap
 *    (`MAX_WORKSPACES_PER_USER`).
 *  - Cloud: the organization is created at Antasphere AS THE CALLER, then
 *    projected locally before the answer — `workspace.id` is always the
 *    LOCAL workspace id, the one `X-Workspace-Id` selects.
 *
 * Sessions only: API keys and OAuth bearers are refused (the route is
 * deliberately absent from the machine scope allowlist). The name is trimmed
 * server-side; a name that is blank once trimmed answers 400. The look the
 * person picked in the dialog rides along, so the workspace is born with it
 * on every member's screen.
 */
export const workspaceCreateSchema = z.object({
  name: plainText(1, 120),
  look: workspaceLookSchema.partial().optional()
});
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceCreatedSchema = z.object({
  workspace: z.object({
    /** The LOCAL workspace id — pass it as `X-Workspace-Id` to work in it. */
    id: z.string(),
    name: z.string(),
    look: workspaceLookSchema
  })
});
export type WorkspaceCreated = z.infer<typeof workspaceCreatedSchema>;

/**
 * PATCH /api/v1/workspace — the ACTIVE workspace's own settings (its name,
 * its look), by an owner or an admin of it, from a browser session. The
 * route names no id: a request works in exactly one workspace (ADR 014),
 * and that is the one it edits. On the cloud edition a hub-origin
 * workspace's NAME is the hub's (P7): a rename answers 403 `hub_managed`
 * with the console to do it at; its look stays a local fact and is
 * accepted.
 */
export const workspaceUpdateSchema = z
  .object({
    name: plainText(1, 120).optional(),
    look: workspaceLookSchema.partial().optional()
  })
  .refine((b) => b.name !== undefined || b.look !== undefined, { message: 'nothing to change' });
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;

export const workspaceUpdatedSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    look: workspaceLookSchema
  })
});
export type WorkspaceUpdated = z.infer<typeof workspaceUpdatedSchema>;
