import { z } from 'zod';
import {
  webhookDeliveryStatusSchema,
  webhookEventPatternSchema,
  webhookFiltersSchema,
  webhookUrlSchema
} from '@antasphere/chassis-contract';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpInputs } from './inputs.js';
import { deny, jsonText, wrapToolErrors, type ErrorHints, type ToolTextResult } from './errors.js';
import {
  callApi,
  forWorkspace,
  pageQuery,
  type McpScopes,
  type McpToolContext,
  type ScopeCheck
} from './tool-kit.js';
import type { McpIdentity } from './server.js';

/**
 * The eleven WEBHOOK tools (PRDCT-3482), registered by the chassis right after
 * the team reads and only when the tool declares a webhooks scope: a webhook
 * is a chassis concept (a URL a workspace registers to be told, by a signed
 * POST, when one of the tool's events happens), so the tools over it are the
 * chassis'. Thin shims over the instance's own /api/v1/webhooks called
 * IN-PROCESS with the caller's bearer forwarded verbatim: the API's
 * fail-closed scope allowlist, its owner-or-admin rule and its 404 for an
 * endpoint of another workspace apply unchanged.
 *
 * Every tool pre-checks the tool's webhooks scope, except the catalog, which
 * is a read (every non-guest member's, under the read scope). Nothing here
 * names a tool, a brand or a domain: the prefix arrives as
 * `identity.toolPrefix`, the event types as the instance's catalog.
 */

/** What a webhook IS, opening the descriptions. */
const WHAT_IS_A_WEBHOOK =
  'A webhook is a URL an organization registers to be told, by a signed HTTP POST, when something ' +
  'happens (for example `thing.created`).';

/** Who manages them. */
const WHO_MANAGES = 'Only an owner or an admin of the organization manages webhooks, reads included.';

/** How the `events` list of an endpoint reads. */
const EVENT_PATTERNS =
  'Each entry of `events` is an exact event type (`thing.created`), a family (`thing.*`) or ' +
  'everything (`*`).';

/**
 * The webhook code only the webhook routes answer, merged into the instance's
 * hint table by `composeErrorHints` like the project hints. The codes the
 * webhook routes SHARE with the rest of the instance (`forbidden`,
 * `demo_session`, `plan_required`) are worded for webhooks on the webhook
 * tools alone ({@link webhookToolHints}): in the instance's table they would
 * misread every other route's refusal.
 */
export function webhookErrorHints(toolPrefix: string): ErrorHints {
  return {
    url_refused:
      'This instance does not deliver to that address. Refused: a scheme other than http or https ' +
      '(https only on the cloud), a URL carrying a user name or password, a port other than the ' +
      'scheme’s default, and an address that is not on the public internet (localhost, a private or ' +
      'link-local network), unless the operator of a self-hosted instance opened private networks. ' +
      `Use a public address of the receiver, then call ${toolPrefix}create_webhook or ` +
      `${toolPrefix}update_webhook again.`
  };
}

/** The shared codes, worded for the webhook tools only (layered over the instance's table there). */
function webhookToolHints(toolPrefix: string): ErrorHints {
  return {
    forbidden:
      'Only an owner or an admin of the organization manages webhooks, reads included. Ask one of ' +
      `them to make the change, or to read the endpoints (${toolPrefix}webhook_events stays open to ` +
      'every member).',
    demo_session:
      'This connection was opened by a demonstration link, which may not set up webhooks. A person ' +
      'signed in with their own account must do it.',
    plan_required:
      'The organization’s plan does not include this — the upgrade link in this message is where a ' +
      'human raises it; nothing was created.'
  };
}

const webhookIdInput = z
  .uuid()
  .describe('The webhook id, from the webhook list or the create answer (never its URL).');

const deliveryIdInput = z.uuid().describe('The delivery id, from the delivery list of this webhook.');

const urlInput = webhookUrlSchema.describe(
  'Where the deliveries go: a public http or https URL without credentials (https only on the cloud).'
);

const eventsInput = z
  .array(webhookEventPatternSchema)
  .min(1)
  .max(50)
  .describe(`What the endpoint subscribes to. ${EVENT_PATTERNS}`);

const descriptionInput = z.string().max(200).describe('A short note on what the endpoint is for.');

const filtersInput = webhookFiltersSchema.describe(
  'Narrows the subscription by subject: a subject key of the catalog (its `subjects[].key`) mapped to ' +
    'the ids it accepts, AND across keys, OR within a key; an event that does not carry a filtered ' +
    'subject does not match. An empty object filters nothing.'
);

const enabledInput = z.boolean().describe('false pauses the deliveries without deleting the endpoint.');

/** Register the eleven webhook tools on a server, after the team reads. */
export function registerWebhookTools(
  server: McpServer,
  ctx: McpToolContext,
  identity: McpIdentity,
  scopes: McpScopes,
  checkScope: ScopeCheck<string>,
  hints: ErrorHints
): void {
  const webhooksScope = scopes.webhooks;
  if (!webhooksScope) return;
  const { workspaceInput, cursorInput, limitInput } = mcpInputs(identity);
  const prefix = identity.toolPrefix;
  const t = (name: string) => `${prefix}${name}`;
  const toolHints: ErrorHints = { ...hints, ...webhookToolHints(prefix) };

  const run = (
    scope: string,
    workspace: string | undefined,
    body: (c: McpToolContext) => Promise<unknown>
  ): Promise<ToolTextResult> => {
    const denied = checkScope(ctx.principal, scope);
    if (denied) return Promise.resolve(denied);
    const c = forWorkspace(ctx, workspace);
    return wrapToolErrors(async () => jsonText(await body(c)), toolHints);
  };

  const send = (method: string, value?: unknown): RequestInit =>
    value === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };

  const base = '/api/v1/webhooks';

  // ── The catalog: a read ──────────────────────────────────────────────────

  server.registerTool(
    t('webhook_events'),
    {
      description:
        `The event catalog of this instance: every event type it delivers to webhooks. ${WHAT_IS_A_WEBHOOK} ` +
        'Returns { subjects: [{ key, field, description }], events: [{ type, description, subjects, ' +
        'schema }] } — `subjects` are what an event is about (the key a filter uses, and the field of ' +
        'the envelope’s `subjects` its value is written under: one id or a list of ids), `schema` is ' +
        'the JSON Schema of the event’s `data`. ' +
        `${EVENT_PATTERNS} Read this before ${t('create_webhook')}. Every member may read it.`,
      inputSchema: { workspace: workspaceInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace }) => run(scopes.read, workspace, (c) => callApi(c, `${base}/events`))
  );

  // ── Endpoints ────────────────────────────────────────────────────────────

  server.registerTool(
    t('list_webhooks'),
    {
      description:
        `List the organization’s webhooks, newest first. ${WHAT_IS_A_WEBHOOK} ${WHO_MANAGES} Returns ` +
        '{ webhooks: [{ id, url, description, events, filters, enabled, createdBy, createdAt, ' +
        'updatedAt, disabledAt, disabledReason, consecutiveFailures, lastDeliveryAt, ' +
        'lastDeliveryStatus, previousSecretExpiresAt }], nextCursor } — never a signing secret. ' +
        '`disabledAt` is set when the instance switched the endpoint off after failing too long. When ' +
        'nextCursor is non-null, call again with cursor set to it.',
      inputSchema: { workspace: workspaceInput, limit: limitInput, cursor: cursorInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, limit, cursor }) =>
      run(webhooksScope, workspace, (c) => callApi(c, pageQuery(base, { cursor, limit })))
  );

  server.registerTool(
    t('create_webhook'),
    {
      description:
        `Register a webhook — confirm with the user first (URL and events included). ${WHAT_IS_A_WEBHOOK} ` +
        `${WHO_MANAGES} ${EVENT_PATTERNS} The types are checked against ${t('webhook_events')}, and ` +
        'the keys of `filters` are the catalog’s subject keys. The answer is the endpoint plus its ' +
        'signing `secret` (`whsec_…`), shown ONCE and never again: give it to the receiver, which ' +
        'verifies every delivery’s Standard Webhooks signature with it, and never store it anywhere ' +
        `else. A lost secret is replaced by ${t('rotate_webhook_secret')}.`,
      inputSchema: {
        workspace: workspaceInput,
        url: urlInput,
        events: eventsInput,
        description: descriptionInput.optional(),
        filters: filtersInput.optional(),
        enabled: enabledInput.optional()
      }
    },
    async ({ workspace, url, events, description, filters, enabled }) =>
      run(webhooksScope, workspace, (c) =>
        callApi(
          c,
          base,
          send('POST', {
            url,
            events,
            ...(description !== undefined ? { description } : {}),
            ...(filters !== undefined ? { filters } : {}),
            ...(enabled !== undefined ? { enabled } : {})
          })
        )
      )
  );

  server.registerTool(
    t('get_webhook'),
    {
      description:
        `Read one webhook, without its secret. ${WHO_MANAGES} Returns the endpoint as ` +
        `${t('list_webhooks')} shows it. A webhook of another organization answers not found.`,
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, webhookId }) =>
      run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}`))
  );

  server.registerTool(
    t('update_webhook'),
    {
      description:
        'Change a webhook’s URL, description, events, filters or enabled switch — confirm with the ' +
        `user first. ${WHO_MANAGES} Send only the fields you are changing; \`events\` and \`filters\` ` +
        `REPLACE the whole list or object. ${EVENT_PATTERNS} Setting enabled back to true resumes an ` +
        'endpoint the instance switched off. The secret is unchanged. Returns the endpoint as it now is.',
      inputSchema: {
        workspace: workspaceInput,
        webhookId: webhookIdInput,
        url: urlInput.optional(),
        description: descriptionInput.optional(),
        events: eventsInput.optional(),
        filters: filtersInput.optional(),
        enabled: enabledInput.optional()
      }
    },
    async ({ workspace, webhookId, url, description, events, filters, enabled }) => {
      const patch = { url, description, events, filters, enabled };
      if (Object.values(patch).every((v) => v === undefined)) {
        return deny(
          'Nothing to change: pass at least one of url, description, events, filters or enabled. ' +
            `Read the webhook first (${t('get_webhook')}) if you need its current values.`
        );
      }
      const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      return run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}`, send('PATCH', body)));
    }
  );

  server.registerTool(
    t('delete_webhook'),
    {
      description:
        'Delete a webhook and its whole delivery history — confirm with the user first; nothing more ' +
        `is sent to it and this cannot be undone. ${WHO_MANAGES} To pause it instead, call ` +
        `${t('update_webhook')} with enabled set to false. Returns a last snapshot of the deleted endpoint.`,
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, webhookId }) =>
      run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}`, send('DELETE')))
  );

  server.registerTool(
    t('rotate_webhook_secret'),
    {
      description:
        'Replace a webhook’s signing secret — confirm with the user first. ' +
        `${WHO_MANAGES} The answer is the endpoint plus its new \`secret\` (\`whsec_…\`), shown ONCE: ` +
        'give it to the receiver and never store it anywhere else. The previous secret keeps signing ' +
        'until `previousSecretExpiresAt`, so the receiver can switch without a gap.',
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput }
    },
    async ({ workspace, webhookId }) =>
      run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}/rotate-secret`, send('POST')))
  );

  server.registerTool(
    t('test_webhook'),
    {
      description:
        'Send a signed `webhook.ping` to a webhook now, once, and answer how it went. ' +
        `${WHO_MANAGES} Returns { delivery: { id, eventId, eventType, status, attempt, ` +
        'lastStatusCode, lastError, … } } — `status` is `delivered` when the receiver answered 2xx, ' +
        '`failed` otherwise, with `lastStatusCode` and `lastError` saying why. A ping is never retried.',
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput }
    },
    async ({ workspace, webhookId }) =>
      run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}/test`, send('POST')))
  );

  // ── Deliveries ───────────────────────────────────────────────────────────

  server.registerTool(
    t('list_webhook_deliveries'),
    {
      description:
        `List a webhook’s deliveries, newest first, optionally by status. ${WHO_MANAGES} A delivery ` +
        'is one event sent to this endpoint, with its attempts. Returns { deliveries: [{ id, ' +
        'endpointId, eventId, eventType, status, attempt, lastStatusCode, lastError, nextAttemptAt, ' +
        'deliveredAt, createdAt, updatedAt, payload }], nextCursor } — `eventId` is the receiver’s ' +
        'dedupe key, `lastStatusCode` and `lastError` describe the latest attempt only. When ' +
        'nextCursor is non-null, call again with cursor set to it.',
      inputSchema: {
        workspace: workspaceInput,
        webhookId: webhookIdInput,
        status: webhookDeliveryStatusSchema
          .optional()
          .describe(
            '`pending` (waiting for an attempt or a retry), `delivered`, `failed`, or `held` (out of ' +
              'retries, kept for a redelivery).'
          ),
        limit: limitInput,
        cursor: cursorInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, webhookId, status, limit, cursor }) =>
      run(webhooksScope, workspace, (c) =>
        callApi(c, pageQuery(`${base}/${webhookId}/deliveries`, { cursor, limit }, { status }))
      )
  );

  server.registerTool(
    t('get_webhook_delivery'),
    {
      description:
        `Read one delivery of a webhook, with the payload as sent and its latest attempt. ${WHO_MANAGES} ` +
        `Returns the delivery as ${t('list_webhook_deliveries')} shows it.`,
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput, deliveryId: deliveryIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, webhookId, deliveryId }) =>
      run(webhooksScope, workspace, (c) => callApi(c, `${base}/${webhookId}/deliveries/${deliveryId}`))
  );

  server.registerTool(
    t('redeliver_webhook'),
    {
      description:
        'Send one delivery’s event to its webhook again, as a new delivery — confirm with the user ' +
        `first. ${WHO_MANAGES} The new delivery carries the same \`eventId\` (the receiver’s dedupe key) ` +
        'and the same payload, and is queued: read its outcome later with ' +
        `${t('get_webhook_delivery')}. Returns the new delivery.`,
      inputSchema: { workspace: workspaceInput, webhookId: webhookIdInput, deliveryId: deliveryIdInput }
    },
    async ({ workspace, webhookId, deliveryId }) =>
      run(webhooksScope, workspace, (c) =>
        callApi(c, `${base}/${webhookId}/deliveries/${deliveryId}/redeliver`, send('POST'))
      )
  );
}
