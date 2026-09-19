import { z } from 'zod';
import { plainText } from './common.js';

/**
 * POST /api/v1/setup — one-shot first-boot wizard: creates the owner user
 * and, on the OSS edition, the instance's FIRST workspace (later ones come
 * from `POST /workspaces`). Guarded by the
 * singleton instance_settings row (second attempt → 410) and, optionally, a
 * SETUP_TOKEN. On the CLOUD edition setup creates NO workspace (the
 * response's `workspaceId` is null): every cloud workspace is a hub-org
 * projection, so the operator bootstrap mints a verified, break-glass
 * capable USER only (internal/federation.md, user-scoped federation).
 */
export const setupRequestSchema = z.object({
  instanceName: plainText(1, 120),
  owner: z.object({
    email: z.email(),
    name: plainText(1, 120),
    password: z.string().min(12).max(256)
  }),
  setupToken: z.string().optional()
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const setupResponseSchema = z.object({
  instanceId: z.string(),
  /** The first workspace (oss); null on cloud — no workspace is created there. */
  workspaceId: z.string().nullable(),
  ownerUserId: z.string()
});
export type SetupResponse = z.infer<typeof setupResponseSchema>;
