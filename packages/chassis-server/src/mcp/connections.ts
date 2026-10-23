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
 * The nine CONNECTION tools (PRDCT-3773, PRDCT-3774), registered by the chassis right
 * after the webhook tools and only when the tool declares at least one
 * connection source: a connection is a chassis concept (an inbound webhook
 * source the instance receives from, or a key it holds), so the tools over
 * it are the chassis'. Thin shims over the instance's own
 * /api/v1/connections called IN-PROCESS with the caller's bearer forwarded
 * verbatim: the API's fail-closed scope allowlist (the reads under the read
 * scope, the writes under the tool's webhooks scope), its owner-or-admin
 * rule and its 404 for an undeclared source apply unchanged. Nothing here
 * names a tool or a source: the sources are the instance's own list.
 *
 * The last two connect and disconnect a SIBLING source (PRDCT-3774), another
 * tool of the same Antasphere hub, as the person behind the credential: this
 * instance registers its receiving URL on the sibling and stores the signing
 * secret itself, so nothing is copied and nothing is answered but the
 * connection.
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
    field_required: 'A required field of this source is missing: the keys are in `declared.fields`.',
    // The sibling connect (PRDCT-3774).
    not_sibling: `This source is not a sibling tool: make its receiving URL with ${toolPrefix}connect_source and set its secret with ${toolPrefix}set_connection_secret.`,
    sibling_unavailable: `This instance is not on a hub; connect the source by hand (${toolPrefix}connect_source, then ${toolPrefix}set_connection_secret).`,
    sibling_unknown:
      'The hub lists no tool of that slug: the sibling is not installed on this hub. Nothing changed.',
    sibling_scope_missing:
      'The person must sign out and sign in again to this tool so their grant carries the connect scope, then retry.',
    sibling_grant_missing: 'The person must open the sibling tool once with their account, then retry.',
    sibling_access_denied:
      'The hub does not let this person use the sibling tool: an administrator of the hub must give them access, then retry.',
    sibling_workspace_missing:
      'No workspace of the sibling tool belongs to this organization: the person must open the sibling in it once, then retry.',
    sibling_refused:
      'The sibling tool refused the endpoint (its reason is in the message). Nothing changed here.',
    sibling_busy: 'Another connect of this source is running right now: wait for it to finish, then retry.',
    hub_reauth_required: 'The person must sign in again, then retry.'
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
        '— never a secret, never a receiving URL. `kind` is `inbound` (the source posts here), `key` (a key this instance holds) or `both`. ' +
        '`declared.sibling` is { toolSlug, events } when the source is a sibling tool of the same hub (connected as the person with ' +
        `${t('connect_sibling')}), and \`sibling\` is then { endpointId }, null until connected.`,
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
        'every member but a guest reads it, like the list. Returns { deliveries: [{ id, source, deliveryId, type, receivedAt, outcome, detail, error }], nextCursor } ' +
        '— `outcome` is processed, ignored (a ping, or no handler) or failed. When nextCursor is non-null, call again with cursor set to it.',
      inputSchema: { workspace: workspaceInput, source: sourceInput, limit: limitInput, cursor: cursorInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, source, limit, cursor }) =>
      run(scopes.read, workspace, (c) => callApi(c, pageQuery(at(source, '/deliveries'), { cursor, limit })))
  );

  server.registerTool(
    t('connect_sibling'),
    {
      description:
        'Connect a sibling source — another tool of the same Antasphere hub (`declared.sibling` non-null in the list) — AS THE PERSON behind this credential; confirm with the user first. ' +
        'This instance registers its receiving URL as an endpoint on the sibling and stores the signing secret: nobody copies anything. ' +
        'A re-run replaces the endpoint, the URL and the secret. ' +
        `${WHO} Returns the connection (its \`sibling.endpointId\` set) — never a URL, never a secret. ` +
        'The person must have opened the sibling once and signed in to this tool since it asks the hub for the connect scope. ' +
        'Refusals: not_sibling (the source is not a sibling: connect it by hand), sibling_unavailable (this instance is not on a hub), ' +
        'sibling_unknown (the hub lists no such tool), sibling_scope_missing (the person must sign in again), sibling_grant_missing (the person never opened the sibling), ' +
        'sibling_access_denied (the hub does not let the person use the sibling), sibling_workspace_missing (no workspace of the sibling belongs to this organization), ' +
        'sibling_refused (the sibling refused the endpoint), sibling_busy (another connect of this source is running: retry in a moment), hub_reauth_required (the person must sign in again), source_unavailable (the hub or the sibling did not answer; nothing changed).',
      inputSchema: { workspace: workspaceInput, source: sourceInput }
    },
    async ({ workspace, source }) =>
      run(writeScope, workspace, (c) => callApi(c, at(source, '/sibling'), send('POST')))
  );

  server.registerTool(
    t('disconnect_sibling'),
    {
      description:
        'Disconnect a sibling source as the person — confirm with the user first: the endpoint is deleted on the sibling first, then the connection here (its secret, its receiving URL and its delivery log). ' +
        `${WHO} Returns the connection — never a URL, never a secret. The refusals are those of ${t('connect_sibling')}. ` +
        `To drop the connection here only and leave the endpoint on the sibling, use ${t('disconnect_source')}.`,
      inputSchema: { workspace: workspaceInput, source: sourceInput }
    },
    async ({ workspace, source }) =>
      run(writeScope, workspace, (c) => callApi(c, at(source, '/sibling'), send('DELETE')))
  );
}
