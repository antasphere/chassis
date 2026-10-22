import { z } from 'zod';
import { connectionFieldsSchema, connectionSourceKeySchema } from '@antasphere/chassis-contract';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpInputs } from './inputs.js';
import { jsonText, wrapToolErrors, type ErrorHints, type ToolTextResult } from './errors.js';
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
 * The seven CONNECTION tools (PRDCT-3773), registered by the chassis right
 * after the webhook tools and only when the tool declares at least one
 * connection source: a connection is a chassis concept (an inbound webhook
 * source the instance receives from, or a key it holds), so the tools over
 * it are the chassis'. Thin shims over the instance's own
 * /api/v1/connections called IN-PROCESS with the caller's bearer forwarded
 * verbatim: the API's fail-closed scope allowlist (the reads under the read
 * scope, the writes under the tool's webhooks scope), its owner-or-admin
 * rule and its 404 for an undeclared source apply unchanged. Nothing here
 * names a tool or a source: the sources are the instance's own list.
 */

const WHAT_IS =
  'A connection is a source this instance is connected to: a service that posts signed deliveries to it, or a key it holds to read a service.';
const WHO =
  'Only an owner or an admin of the organization changes a connection; every member reads the list.';

export function connectionErrorHints(toolPrefix: string): ErrorHints {
  return {
    not_inbound: 'This source holds a key and has no receiving URL: set its key instead.',
    not_connected: `Nothing is connected yet for this source: make the receiving URL with ${toolPrefix}connect_source, or set the key with ${toolPrefix}set_connection_secret.`,
    secret_invalid:
      'The value has not the shape this source declares (its `declared.secretHint` says what it looks like). Nothing was stored.',
    secret_refused: 'The source refused the key (its answer is in the message). Nothing was stored.',
    source_unavailable: 'The source did not answer the probe. Nothing was stored; try again later.',
    unknown_field:
      'That is not a field this source declares: the keys are in `declared.fields` of the connection.',
    field_required: 'A required field of this source is missing: the keys are in `declared.fields`.'
  };
}

function connectionToolHints(toolPrefix: string): ErrorHints {
  return {
    forbidden: `Only an owner or an admin of the organization changes connections. Ask one of them, or read the list with ${toolPrefix}list_connections.`,
    demo_session:
      'This connection was opened by a demonstration link, which may not change connections. A person signed in with their own account must do it.'
  };
}

const sourceInput = connectionSourceKeySchema.describe(
  'The source key, from the list (`source` of each entry).'
);

/** Register the connection tools on a server, after the webhook tools. */
export function registerConnectionTools(
  server: McpServer,
  ctx: McpToolContext,
  identity: McpIdentity,
  scopes: McpScopes,
  checkScope: ScopeCheck<string>,
  hints: ErrorHints
): void {
  const { workspaceInput, cursorInput, limitInput } = mcpInputs(identity);
  const prefix = identity.toolPrefix;
  const t = (name: string) => `${prefix}${name}`;
  const toolHints: ErrorHints = { ...hints, ...connectionToolHints(prefix) };
  // The writes ride the tool's webhooks scope, like the webhook family; without one they are closed to machines.
  const writeScope = scopes.webhooks ?? null;

  const run = (
    scope: string | null,
    workspace: string | undefined,
    body: (c: McpToolContext) => Promise<unknown>
  ): Promise<ToolTextResult> => {
    if (scope === null) {
      return Promise.resolve({
        content: [{ type: 'text', text: 'This instance opens no connection write to a machine credential.' }],
        isError: true
      });
    }
    const denied = checkScope(ctx.principal, scope);
    if (denied) return Promise.resolve(denied);
    const c = forWorkspace(ctx, workspace);
    return wrapToolErrors(async () => jsonText(await body(c)), toolHints);
  };

  const send = (method: string, value?: unknown): RequestInit =>
    value === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };

  const base = '/api/v1/connections';
  const at = (source: string, rest = '') => `${base}/${encodeURIComponent(source)}${rest}`;

  server.registerTool(
    t('list_connections'),
    {
      description:
        `List every connection source this instance declares, with its state in the organization. ${WHAT_IS} ${WHO} ` +
        'Returns { connections: [{ source, name, kind, declared: { description, verifier, events, secretHint, fields, sibling }, ' +
        'connected, receiving: { madeAt, madeBy } | null, secretState: { set, readable, setAt, setBy }, fields, lastDelivery, check, sibling }] } ' +
        '— never a secret, never a receiving URL. `kind` is `inbound` (the source posts here), `key` (a key this instance holds) or `both`.',
      inputSchema: { workspace: workspaceInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace }) => run(scopes.read, workspace, (c) => callApi(c, base))
  );

  server.registerTool(
    t('connect_source'),
    {
      description:
        `Make the receiving URL of an inbound source, or rotate it — confirm with the user first. ${WHAT_IS} ${WHO} ` +
        'The answer is { connection, receivingUrl }: the URL is shown ONCE and never again (only its fingerprint is kept); ' +
        'give it to the source as the endpoint to post to. A rotation makes the previous URL answer 404 at once. ' +
        `Then set the signing secret the source showed with ${t('set_connection_secret')}.`,
      inputSchema: { workspace: workspaceInput, source: sourceInput }
    },
    async ({ workspace, source }) => run(writeScope, workspace, (c) => callApi(c, at(source), send('POST')))
  );

  server.registerTool(
    t('set_connection_secret'),
    {
      description:
        `Set a source's signing secret or key, stored sealed and never shown again. ${WHO} ` +
        'A key source is probed first and a refused key is not stored (`secret_refused`, the source’s answer in the message). ' +
        'The value travels in this call only: never log it, never repeat it back.',
      inputSchema: {
        workspace: workspaceInput,
        source: sourceInput,
        secret: z.string().min(1).max(4096).describe('The secret or the key as the source showed it.')
      }
    },
    async ({ workspace, source, secret }) =>
      run(writeScope, workspace, (c) => callApi(c, at(source, '/secret'), send('PUT', { secret })))
  );

  server.registerTool(
    t('set_connection_fields'),
    {
      description:
        `Store a source's declared fields (a folder, the inboxes to read). ${WHO} The keys are the connection's ` +
        '`declared.fields[].key`; a key absent keeps its value, null clears it; a `multiple` field takes a list.',
      inputSchema: {
        workspace: workspaceInput,
        source: sourceInput,
        fields: connectionFieldsSchema.describe('The fields by declared key.')
      }
    },
    async ({ workspace, source, fields }) =>
      run(writeScope, workspace, (c) => callApi(c, at(source), send('PATCH', { fields })))
  );

  server.registerTool(
    t('test_connection'),
    {
      description:
        `Test a connection: a key source is probed with the stored key, an inbound source checks that its URL is made and its secret opens. ${WHO} ` +
        'Returns { ok, detail, connection }; the result is kept as the connection’s last check.',
      inputSchema: { workspace: workspaceInput, source: sourceInput }
    },
    async ({ workspace, source }) =>
      run(writeScope, workspace, (c) => callApi(c, at(source, '/test'), send('POST')))
  );

  server.registerTool(
    t('disconnect_source'),
    {
      description: `Disconnect a source — confirm with the user first: its secret, its receiving URL and its delivery log are gone. ${WHO}`,
      inputSchema: { workspace: workspaceInput, source: sourceInput }
    },
    async ({ workspace, source }) => run(writeScope, workspace, (c) => callApi(c, at(source), send('DELETE')))
  );

  server.registerTool(
    t('connection_deliveries'),
    {
      description:
        'The deliveries the instance took for a source, newest first. A read, open to every member under the read scope; ' +
        'the API’s own role rule on the delivery log still applies. Returns { deliveries: [{ id, source, deliveryId, type, receivedAt, outcome, detail, error }], nextCursor } ' +
        '— `outcome` is processed, ignored (a ping, or no handler) or failed. When nextCursor is non-null, call again with cursor set to it.',
      inputSchema: { workspace: workspaceInput, source: sourceInput, limit: limitInput, cursor: cursorInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, source, limit, cursor }) =>
      run(scopes.read, workspace, (c) => callApi(c, pageQuery(at(source, '/deliveries'), { cursor, limit })))
  );
}
