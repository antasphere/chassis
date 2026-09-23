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
  rate_limited: 'Rate limited — wait before retrying.',
  plan_required:
    'The workspace\u2019s plan does not allow this — the upgrade link in this message is where a human raises it.',
  // The same code on both editions: the cloud's credit refusal (402, with the
  // top-up link) and a self-hosted instance's cap (413, no details).
  entitlement_denied:
    'The instance refused this action: on the cloud the organization lacks the credits and the top-up link in this message is where a human adds them; on a self-hosted instance the request exceeds the operator’s cap.'
};

/** The chassis hints plus a tool's own: ONE table, the one every lookup reads. */
export function mergeErrorHints(toolHints: ErrorHints): ErrorHints {
  return { ...DOMAIN_HINTS, ...toolHints };
}

/** Thrown when the in-process API call returns a non-2xx wire-shape response. */
export class ApiToolError extends Error {
  readonly status: number;
  readonly code: string | null;

  /** The wire's `error.details`, when the API sent any (a plan refusal's upgrade link rides here). */
  readonly details: unknown;

  constructor(status: number, code: string | null, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiToolError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toUserFacingText(hints: ErrorHints = DOMAIN_HINTS): string {
    const hint = this.code ? hints[this.code] : undefined;
    const codePart = this.code ? `, code: ${this.code}` : '';
    // A plan refusal carries its upgrade link (the billing rail, §7): the
    // agent relays it, a human follows it. Text, never a structured field.
    const upgradeUrl = (this.details as { upgradeUrl?: unknown } | null)?.upgradeUrl;
    const upgrade = typeof upgradeUrl === 'string' && upgradeUrl ? ` Upgrade: ${upgradeUrl}` : '';
    // A credit refusal (402 `entitlement_denied`, PRDCT-2664) carries its
    // top-up link, the price and the balance: the same, as text. The
    // self-hosted cap's 413 has no details, so no top-up sentence.
    const { topUpUrl, credits, balance } = (this.details ?? {}) as {
      topUpUrl?: unknown;
      credits?: unknown;
      balance?: unknown;
    };
    let topUp = '';
    // The gate's message already carries the link, the price and the balance;
    // the sentence is added only for a message that does not (verifier
    // round 1: the URL was printed twice).
    if (typeof topUpUrl === 'string' && topUpUrl && !this.message.includes(topUpUrl)) {
      const needs = typeof credits === 'number' ? [`this needs ${credits} credits`] : [];
      const holds = typeof balance === 'number' ? [`the organization holds ${balance}`] : [];
      const numbers = [...needs, ...holds].join(', ');
      topUp = ` Top up: ${topUpUrl}${numbers ? ` (${numbers}).` : ''}`;
    }
    return `API error (HTTP ${this.status}${codePart}): ${this.message}${hint ? ` — Next: ${hint}` : ''}${upgrade}${topUp}`;
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
