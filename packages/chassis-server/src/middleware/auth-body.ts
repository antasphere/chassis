import type { MiddlewareHandler } from 'hono';
import { hasNulDeep } from '@antasphere/chassis-contract';
import { apiError } from '../api/errors.js';

/** Matches better-call's / Hono's JSON content-type test (the json-depth regex). */
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Pre-validates JSON bodies bound for the Better Auth mount (AF-1 + the
 * update-user half of SL-B4, PRDCT-1358).
 *
 * The load-bearing half is NUL: Better Auth's free-text sinks (`/update-user`'s
 * `name`) are outside the contract, so a NUL rode through to Postgres (SQLSTATE
 * 22021) and surfaced as Better Auth's OWN 500 — a response `app.onError` never
 * sees, so the app-level 22021 backstop cannot reach `/auth/*`. Refusing it
 * here, before the mount, is the only complete place.
 *
 * The malformed/empty-JSON half is defence in depth and a wire-shape
 * normalizer: on the pinned Better Auth (better-call ≥ 1.3.7) a JSON parse
 * error already answers 400 (`BAD_REQUEST`), not a 500 — but with better-call's
 * own error code, not this API's. Answering `invalid_json` here keeps the auth
 * surface's parse errors in the same envelope as every other route, and guards
 * a future dependency change that reverts to a 500.
 *
 * A body under a JSON content-type must parse and carry no NUL anywhere;
 * non-JSON content types pass untouched (the OAuth token endpoint is
 * form-encoded), as do bodyless requests. The body is read from a clone — the
 * mount consumes the original.
 */
export function authBodyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) return next();
    if (!JSON_CONTENT_TYPE.test(raw.headers.get('content-type') ?? '')) return next();
    let text: string;
    try {
      text = await raw.clone().text();
    } catch {
      // Unreadable body — let the mount produce its own error.
      return next();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return apiError(c, 400, 'invalid_json', 'Request body is not valid JSON');
    }
    if (hasNulDeep(parsed)) {
      return apiError(
        c,
        400,
        'invalid_characters',
        'Request contains characters that cannot be stored (e.g. a NUL byte)'
      );
    }
    return next();
  };
}
