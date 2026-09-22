import type { MiddlewareHandler } from 'hono';
import { apiError } from '../api/errors.js';

/**
 * Nesting cap for request JSON. Deliberately far above anything a contract in
 * `@antasphere/contract` describes (the deepest is three or four levels) and far
 * below the depth at which V8 recursion breaks.
 *
 * Why a cap at all: `JSON.parse` is iterative and swallows any depth, but
 * `JSON.stringify` is RECURSIVE and blows the stack with a `RangeError` past a
 * few thousand levels — and the exact depth depends on the V8 build, so it
 * reproduces inside the shipped `node:22-alpine` image and not on a newer host
 * Node. Every path that echoes, audits, logs, or persists a validated body
 * stringifies it, so an anonymous client could turn one small request body
 * into a 500 plus an error-level stack trace. Rejecting at the edge — before
 * anything parses, let alone stringifies — is the only place the fix is
 * complete.
 */
export const MAX_JSON_DEPTH = 100;

/** Matches better-call's / Hono's JSON content-type test (same regex family). */
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * True when `text` nests `{`/`[` deeper than `max`. A single string-aware
 * scan, no parsing and no allocation: brackets inside JSON string literals
 * (and escaped quotes inside them) do not count. Returns as soon as the limit
 * is passed, so a hostile body costs O(prefix), not O(body).
 */
export function exceedsJsonDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth++;
      if (depth > max) return true;
    } else if (ch === '}' || ch === ']') depth--;
  }
  return false;
}

/**
 * Rejects over-deep JSON bodies with a 400 before any handler, parser or
 * serializer sees them. Non-JSON and bodyless requests pass untouched, so
 * streamed uploads and form-encoded token calls are unaffected. Mount it
 * AFTER the body-size limit so the scan is bounded by that cap.
 */
export function jsonDepthLimit(maxDepth: number = MAX_JSON_DEPTH): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) return next();
    if (!JSON_CONTENT_TYPE.test(raw.headers.get('content-type') ?? '')) return next();
    let text: string;
    try {
      text = await raw.clone().text();
    } catch {
      // Unreadable body — let the normal parser produce the normal error.
      return next();
    }
    if (exceedsJsonDepth(text, maxDepth)) {
      return apiError(c, 400, 'payload_too_deep', `Request JSON nests deeper than ${maxDepth} levels`);
    }
    return next();
  };
}
