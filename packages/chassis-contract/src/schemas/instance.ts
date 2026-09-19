import { z } from 'zod';
import { KNOWN_AUTH_METHODS } from '../seams.js';

/**
 * GET /api/v1/instance — unauthenticated, cacheable discovery. This is what
 * CLIs and MCP clients read to route: which auth methods exist, whether
 * first-boot setup is still pending, and what the instance is.
 */
export const instanceInfoSchema = z.object({
  name: z.string(),
  instanceId: z.string().nullable(),
  edition: z.string(),
  version: z.string(),
  apiVersion: z.literal('v1'),
  setupRequired: z.boolean(),
  auth: z.object({
    // Open enum (ADR 003): the enum documents the known vocabulary, the
    // string branch keeps older clients parsing newer instances. Clients
    // ignore entries they do not recognize.
    methods: z.array(z.enum(KNOWN_AUTH_METHODS).or(z.string())),
    passwordReset: z.boolean(),
    emailChange: z.boolean(),
    twoFactor: z.boolean(),
    /**
     * Hub SSO client hints (cloud edition ONLY — absent on oss, where the
     * discovery wire shape stays byte-identical). The hint cookie is a
     * dashboard-side HINT for the silent auto-connect (attempt vs don't),
     * NEVER a security input: the hub sets it, this tool reads it
     * client-side and clears it on logout / login_required
     * (internal/federation.md, cross-repo contract).
     */
    sso: z
      .object({
        hintCookieName: z.string(),
        hintCookieDomain: z.string()
      })
      .optional()
  }),
  features: z.object({
    mcp: z.boolean(),
    oauth: z.boolean(),
    files: z.boolean()
  })
});
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;
