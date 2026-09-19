import type { Context } from 'hono';

/**
 * The low-cardinality, secret-free label for a request, used by BOTH the
 * completion log line and the trace span.
 *
 * The raw `c.req.path` must never reach the log stream or a span attribute.
 * Path segments are request data like any other: the moment a route puts a
 * capability in the URL — a share secret, a one-time token, an invitation
 * code — every log sink, every trace backend, and every operator with
 * `docker logs` holds a working credential, and the redaction list cannot
 * help (it keys off object properties, and `path` is one opaque string).
 * Logging the MATCHED ROUTE PATTERN instead (`/v/:secret`, not
 * `/v/9f3c…`) keeps the line just as useful for debugging and cardinality
 * bounded, and it is secret-free by construction for every route that will
 * ever be added.
 *
 * `routePath` is only populated once routing has run, so callers must read
 * this AFTER `await next()`. Unmatched requests have no pattern to report:
 * they get the literal `(unmatched)` rather than the attacker-controlled URL
 * they probed with.
 */
export function routeLabel(c: Context): string {
  const matched = c.req.routePath;
  // Hono answers '/*' for a catch-all match and for no match at all; neither
  // says anything the pattern doesn't, and both are safe to report as-is.
  if (!matched) return '(unmatched)';
  return matched;
}
