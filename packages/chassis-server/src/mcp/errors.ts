/**
 * API error → model-readable hint mapping (the predecessor MCP template's
 * DOMAIN_HINTS pattern). The API returns `{ error: { code, message } }` on
 * failure; each domain code can carry an actionable hint so the model
 * self-corrects instead of retrying blindly. The table below holds the hints of
 * the chassis' own codes; a tool adds its domain's through
 * {@link mergeErrorHints} (the `errorHints` of its MCP definition).
 */
export type ErrorHints = Readonly<Record<string, string>>;

const DOMAIN_HINTS: Record<string, string> = {
  insufficient_scope:
    'Reconnect the MCP server and approve the permission on the consent screen ' +
    '(or mint an API key that includes the scope).',
  endpoint_not_allowed:
    'This endpoint is not opened to machine credentials — a human must do this in the dashboard.',
  invalid_token: 'The OAuth token expired or was revoked. Reconnect the MCP server.',
  unauthenticated: 'No valid credential reached the API. Reconnect the MCP server.',
  rate_limited: 'Rate limited — wait before retrying.'
};

/** The chassis hints plus a tool's own: ONE table, the one every lookup reads. */
export function mergeErrorHints(toolHints: ErrorHints): ErrorHints {
  return { ...DOMAIN_HINTS, ...toolHints };
}

/** Thrown when the in-process API call returns a non-2xx wire-shape response. */
export class ApiToolError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ApiToolError';
    this.status = status;
    this.code = code;
  }

  toUserFacingText(hints: ErrorHints = DOMAIN_HINTS): string {
    const hint = this.code ? hints[this.code] : undefined;
    const codePart = this.code ? `, code: ${this.code}` : '';
    return `API error (HTTP ${this.status}${codePart}): ${this.message}${hint ? ` — Next: ${hint}` : ''}`;
  }
}

export interface ToolTextResult {
  // Index signature: the MCP SDK's CallToolResult carries extra open fields.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export const jsonText = (result: unknown): ToolTextResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
});

export const deny = (text: string): ToolTextResult => ({
  content: [{ type: 'text' as const, text }],
  isError: true as const
});

/**
 * Wrap a tool body so any thrown ApiToolError surfaces as a structured MCP
 * tool error (`isError: true` + text) rather than a protocol-level exception.
 * Other errors propagate to the SDK.
 */
export async function wrapToolErrors(
  fn: () => Promise<ToolTextResult>,
  hints: ErrorHints = DOMAIN_HINTS
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiToolError) {
      return { content: [{ type: 'text', text: err.toUserFacingText(hints) }], isError: true };
    }
    throw err;
  }
}
