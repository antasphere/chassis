import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The one error wire shape: { error: { code, message, details? } }. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown
): Response {
  return c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
}
