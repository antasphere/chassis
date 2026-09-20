import { z } from 'zod';
import { cursorPageQuerySchema, noControlChars } from './common.js';

export const auditEntrySchema = z.object({
  id: z.number(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorVia: z.enum(['session', 'api_key', 'oauth', 'system']),
  apiKeyId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string()
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditViaSchema = z.enum(['session', 'api_key', 'oauth', 'system']);
export type AuditVia = z.infer<typeof auditViaSchema>;

/** The actor filter's reserved word: rows nobody signed (actor_user_id IS NULL). */
export const AUDIT_ACTOR_SYSTEM = 'system';

/**
 * A comma-separated list of actions or families: an item ending in `.`
 * matches the family (`apikey.` is every API key action), any
 * other item matches exactly. The fallback action of an unlabelled route is
 * `<method> <path>`, so a space and a slash are legitimate characters.
 */
const AUDIT_ACTION_LIST_RE = /^[a-z0-9_.\-/ ]+(,[a-z0-9_.\-/ ]+)*$/;
const AUDIT_VIA_LIST_RE = /^(session|api_key|oauth|system)(,(session|api_key|oauth|system))*$/;

/**
 * The audit list's filters, every one optional and combined with AND. Each
 * free-text one is bounded and control-char free: every value lands in a
 * WHERE comparison, and a NUL there is a driver error (22021) that would
 * surface as a 500 for a plain client mistake.
 */
export const auditListQuerySchema = cursorPageQuerySchema.extend({
  /** Free text, matched case-insensitively against the actor's email and the action. */
  q: noControlChars(z.string().max(120)).optional(),
  /** Actions or families, comma-separated (`member.,apikey.create`); at most 20. */
  action: z
    .string()
    .max(600)
    .regex(AUDIT_ACTION_LIST_RE)
    .refine((v) => v.split(',').length <= 20, { error: 'at most 20 actions' })
    .optional(),
  /** How the actor authenticated, comma-separated (`session,api_key`). */
  actorVia: z.string().max(40).regex(AUDIT_VIA_LIST_RE).optional(),
  /** One user id (a member of the workspace), or `system` for rows nobody signed. */
  actor: noControlChars(z.string().min(1).max(64)).optional(),
  resourceType: noControlChars(z.string().min(1).max(64)).optional(),
  resourceId: noControlChars(z.string().min(1).max(200)).optional(),
  /** Entries created at or after this instant (ISO 8601). */
  from: z.iso.datetime().optional(),
  /** Entries created at or before this instant (ISO 8601). */
  to: z.iso.datetime().optional()
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditListSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
  /**
   * How many entries match the filters in all: counted on the first page
   * only (no cursor), null on the pages after it. A client keeps the first
   * page's figure while it loads more.
   */
  total: z.number().int().nullable()
});
export type AuditListResponse = z.infer<typeof auditListSchema>;
