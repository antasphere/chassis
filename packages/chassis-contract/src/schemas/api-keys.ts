import { z } from 'zod';
import { plainText } from './common.js';
import type { ScopeSchema } from './scope.js';

/** The API-key schemas carry the tool's scope vocabulary: built per tool (../define.ts). */
export function defineApiKeySchemas<TScope extends string>(scopeSchema: ScopeSchema<TScope>) {
  const apiKeySchema = z.object({
    id: z.string(),
    name: z.string(),
    keyId: z.string(),
    scopes: z.array(scopeSchema),
    /**
     * The key's optional workspace PIN (user-scoped credential model). null =
     * user-scoped: the key acts as its creator and the target workspace is a
     * per-request parameter (X-Workspace-Id / the user's default). A value =
     * the key reaches ONLY that workspace, forever.
     */
    workspaceId: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    expiresAt: z.string().nullable()
  });

  const apiKeysListSchema = z.object({
    apiKeys: z.array(apiKeySchema),
    nextCursor: z.string().nullable()
  });

  const apiKeyCreateSchema = z.object({
    name: plainText(1, 120),
    scopes: z.array(scopeSchema).min(1),
    /** TTL at mint; the server computes the absolute expiry. Omit = never expires. */
    expiresInDays: z.number().int().min(1).max(3650).optional(),
    /**
     * Optional workspace PIN (least privilege): the key then reaches ONLY this
     * workspace — an ACTIVE membership of it is required at mint. Omit for a
     * user-scoped key (the default): it acts as you in whichever of your
     * workspaces each request names.
     */
    workspaceId: z.uuid().optional()
  });

  /** The secret appears exactly once, in this response. */
  const apiKeyCreatedSchema = z.object({
    apiKey: apiKeySchema,
    /** Full key `<prefix>_<keyid>_<secret>` — shown once, never retrievable. */
    key: z.string()
  });

  return { apiKeySchema, apiKeysListSchema, apiKeyCreateSchema, apiKeyCreatedSchema };
}
