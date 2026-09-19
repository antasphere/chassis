import { z } from 'zod';

/**
 * API conventions (fixed): plain resource JSON on success — no
 * `{ success, data }` envelope; errors are `{ error: { code, message,
 * details? } }`; cursor pagination.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
/**
 * Free text a client may send that ends up in a Postgres `text`/`varchar`
 * column, a filename, or a log line.
 *
 * Postgres cannot store a NUL byte in a text value: it raises SQLSTATE 22021
 * from deep inside the driver, which surfaces as an unhandled 500 whose
 * error-level log line prints the failing statement AND its bound parameters.
 * An anonymous client can drive that on any free-text sink (`/setup`, the
 * invitation accept, the CLI key mint). NUL is never meaningful in a name, a
 * label, or a title, so the contract refuses it and the caller gets the
 * ordinary 400 validation_error instead.
 *
 * The other C0 controls are rejected with it: they are invisible in every UI,
 * they are the raw material of log-injection and terminal-escape tricks, and
 * no legitimate name contains one. Newlines and tabs are ALLOWED — multi-line
 * free text is a real thing; a sink that must stay single-line adds its own
 * `.regex()`.
 */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Tab / LF / CR are legitimate in multi-line free text.
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function noControlChars<T extends z.ZodType<string>>(schema: T): T {
  return schema.refine((v) => !hasControlChars(v), {
    error: 'must not contain NUL or other control characters'
  }) as unknown as T;
}

/**
 * Postgres int4 ceiling. Every integer the API accepts that lands in an
 * `integer` column (version numbers, cursors) must be bounded by it at the
 * contract: `Number.isInteger(1e15)` is true, so a bare `.int()` lets a value
 * past bigint-free column range through to Postgres, which refuses it with
 * a numeric-overflow error that would surface as a 500.
 */
export const INT4_MAX = 2_147_483_647;

/**
 * A deck version number in a JSON body: a positive int4. The upper bound is
 * part of the contract (FUZZ-9's generalization): `version` lands in a
 * Postgres `integer` column, and 1e15 passes `.int()` but overflows int4 into
 * a driver error → 500.
 */
export const versionNumberSchema = z.number().int().min(1).max(INT4_MAX);

/**
 * A deck version number arriving as a STRING (path segment or query param):
 * strictly digits, then int4-bounded (FUZZ-9). `z.coerce.number()` alone
 * accepted `1e5`, `0x10`, ` 1 `, and `99999999999999999999` — the last one is
 * `Number.isInteger`-true and overflowed Postgres int4 into a 500.
 */
export const versionParamSchema = z
  .string()
  .regex(/^\d{1,10}$/, 'version must be a positive integer')
  .transform(Number)
  .pipe(versionNumberSchema);

/**
 * True when the value graph carries a NUL character in any string — object
 * keys included. Postgres cannot store NUL in `text` (SQLSTATE 22021) or in
 * `jsonb` (`\u0000` raises 22P05), so any client-supplied structure bound for
 * a jsonb column (annotation selections, form payloads, deck metadata) is
 * refused at the contract instead of surfacing a driver error. Iterative walk
 * — never recursion — so a deeply nested value cannot blow the stack in the
 * very guard meant to protect against hostile shapes.
 */
export function hasNulDeep(value: unknown): boolean {
  const stack: unknown[] = [value];
  // A shared value graph (the contract is documented safe to run outside the
  // server, where a caller may hand it a live object carrying a cycle) would
  // spin this walk forever; the seen-set makes each container visited once.
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (current.includes('\u0000')) return true;
    } else if (Array.isArray(current)) {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const [key, item] of Object.entries(current)) {
        if (key.includes('\u0000')) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

/**
 * Nesting depth of a parsed JSON value, computed iteratively (the point is to
 * measure hostile depth without recursing over it). Scalars are depth 0; an
 * object or array adds one level. Contracts cap opaque structures with this
 * BEFORE any `JSON.stringify` runs on them — stringify is recursive and blows
 * the V8 stack with a RangeError at a build-dependent depth (SL-B5), so the
 * check must come first, and the contract must stay safe even when consumed
 * outside the server (SDK, dashboard) where no edge middleware ran.
 */
export function jsonDepthOf(value: unknown): number {
  let max = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  // Same cycle guard as hasNulDeep: a live object with a back-reference must
  // not make the depth walk (or the caller's later stringify) run forever.
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) max = depth;
    if (node !== null && typeof node === 'object') {
      if (seen.has(node)) continue;
      seen.add(node);
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) stack.push({ node: item, depth: depth + 1 });
    }
  }
  return max;
}

/**
 * Depth cap for the opaque JSON objects the contract carries (metadata,
 * annotation selections, form payloads). Far above any legitimate shape —
 * the deepest real structure is a handful of levels — and far below both the
 * server edge cap (100) and the stringify breaking depth (~5000 on
 * node:22-alpine).
 */
export const MAX_OPAQUE_JSON_DEPTH = 32;

/**
 * The shared guard for an opaque client-supplied JSON object bound for a
 * jsonb column: depth-capped first (so the later size refine may stringify
 * safely), then NUL-free. Compose it onto a `z.record(...)` with `.check`
 * short-circuiting: zod runs refinements in order and skips later ones once
 * one fails only when `abort` is set, so both checks abort.
 */
export function opaqueJsonChecks<T extends z.ZodType<Record<string, unknown>>>(schema: T): T {
  return schema
    .refine((v) => jsonDepthOf(v) <= MAX_OPAQUE_JSON_DEPTH, {
      error: `must not nest deeper than ${MAX_OPAQUE_JSON_DEPTH} levels`,
      abort: true
    })
    .refine((v) => !hasNulDeep(v), {
      error: 'must not contain NUL characters in keys or values',
      abort: true
    }) as unknown as T;
}

/**
 * The one free-text string builder: length-bounded and NUL-free.
 * Every user-supplied name/label/title in this contract goes through it.
 */
export function plainText(min: number, max: number) {
  return noControlChars(z.string().min(min).max(max));
}

/**
 * RFC 7231 media type: `token "/" token`, optionally followed by
 * `;`-separated `token=token|quoted-string` parameters. The manifest's
 * `contentType` is copied VERBATIM into the response `Content-Type` header
 * when the blob is served (`files/serve.ts`), including on the anonymous
 * viewer — and versions are immutable, so a committed value that the
 * `Headers` constructor refuses (a non-Latin-1 character, say) was a
 * permanent anonymous 500 on that asset (PLT-5, PRDCT-1358). The grammar
 * check at commit is the fix; the serve-time sanitizer is the backstop for
 * rows committed before it.
 */
const MEDIA_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
export const MEDIA_TYPE_RE = new RegExp(
  `^${MEDIA_TYPE_TOKEN}\\/${MEDIA_TYPE_TOKEN}` +
    `(?:[ \\t]*;[ \\t]*${MEDIA_TYPE_TOKEN}=(?:${MEDIA_TYPE_TOKEN}|"[^"\\\\\\u0000-\\u001f\\u007f]*"))*$`
);

/**
 * A response header VALUE is a ByteString: setting it converts each UTF-16
 * code unit and throws a TypeError on any unit above 0xFF. The token grammar
 * already excludes those in unquoted positions, but a quoted parameter value
 * (`charset="€"`) can carry any character the regex's negated class does not
 * name — U+20AC passes the pattern and then throws at the `Headers` set. So
 * the Latin-1 ceiling is a SEPARATE, explicit check: every code unit ≤ 0xFF,
 * which also rejects astral characters and lone surrogates (their code units
 * are all ≥ 0xD800). Without it the grammar check is not the closure PLT-5
 * needs.
 */
function isLatin1(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

export function isValidMediaType(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && isLatin1(value) && MEDIA_TYPE_RE.test(value);
}
