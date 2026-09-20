import type { ToolIdentity } from '@antasphere/chassis-contract';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonText, mergeErrorHints, wrapToolErrors, type ErrorHints } from './errors.js';
import {
  callApi,
  createScopeCheck,
  forWorkspace,
  pageQuery,
  type McpScopes,
  type McpToolContext
} from './tool-kit.js';

/**
 * The bundled MCP server: tools are thin shims over the instance's own
 * /api/v1 — called IN-PROCESS with the caller's Authorization header
 * forwarded verbatim. MCP is just another API client: no privileged path, no
 * MCP-only endpoints; new behavior lands in the API first. Identity comes
 * from the verified credential, never from a tool parameter.
 *
 * Conventions (ported from the predecessor MCP template):
 *  - read tools: `readOnlyHint: true` + a checkScope on the tool's read scope
 *  - write tools: confirm-first description + the tool's write scope (+ destructiveHint
 *    for deletes) — see the write tools of the tool's own set (its tools.ts)
 *  - checkScope is UX only — the API's fail-closed allowlist is the
 *    enforcement point; this just gives the model a clean, actionable error.
 *
 * get_me and list_files below are the chassis' original example tools (the
 * end-to-end whoami proof + a cursor-paginated list), followed by
 * `<toolPrefix>whoami`, the identity tool under the tool's own prefix; the product tool set
 * (`<toolPrefix>*`) lives in the tool's app (its tools.ts).
 */
export type { McpToolContext } from './tool-kit.js';

export interface McpServerInfo {
  version: string;
  instanceName: string;
}

/**
 * What a tool plugs into the bundled MCP server: its own tool set (registered
 * AFTER the three chassis tools, so `tools/list` keeps its order), the server
 * instructions, the error hints of its domain codes, and the two scope names
 * the chassis tools pre-check.
 */
export interface McpToolDefinition {
  registerTools: (server: McpServer, ctx: McpToolContext) => void;
  instructions: (info: McpServerInfo) => string;
  errorHints: ErrorHints;
  scopes: McpScopes;
}

/** The MCP half of the tool's identity (`ToolIdentity['mcp']`): the server's name and the tool names' prefix. */
export type McpIdentity = ToolIdentity['mcp'];

export function buildMcpServer(
  ctx: McpToolContext,
  info: McpServerInfo,
  tool: McpToolDefinition,
  identity: McpIdentity
): McpServer {
  // `<prefix>whoami` (the contract of `toolPrefix`), registered below: the other chassis tools point at it.
  const whoami = `${identity.toolPrefix}whoami`;
  const checkScope = createScopeCheck(tool.scopes);
  const hints = mergeErrorHints(tool.errorHints);
  const server = new McpServer(
    { name: identity.serverName, version: info.version },
    {
      instructions: tool.instructions(info)
    }
  );

  const workspaceInput = z
    .uuid()
    .optional()
    .describe(`Target organization (workspace id). Omit to use your default org — see ${whoami}.`);

  // ── Pattern 1: READ tool — the end-to-end whoami proof ────────────────────
  server.registerTool(
    'get_me',
    {
      description:
        'Who is connected: the user this MCP connection acts as, with all their organizations. ' +
        'Returns { user: { id, email, name }, workspace, role, via, scopes, workspaces }. ' +
        `Everything done through this server happens as this user. (Alias of ${whoami}.)`,
      inputSchema: { workspace: workspaceInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace }) => {
      const denied = checkScope(ctx.principal, tool.scopes.read);
      if (denied) return denied;
      const c = forWorkspace(ctx, workspace);
      return wrapToolErrors(async () => jsonText(await callApi(c, '/api/v1/me')), hints);
    }
  );

  // ── Pattern 2: LIST tool with cursor pagination passed through ────────────
  server.registerTool(
    'list_files',
    {
      description:
        "List a workspace's files, newest first. Returns { files: [{ id, sha256, sizeBytes, " +
        'contentType, originalName, createdBy, createdAt }], nextCursor }. When nextCursor is ' +
        'non-null, call again with cursor set to it for the next page. Download or upload happen ' +
        'through the API, not through tools.',
      inputSchema: {
        workspace: workspaceInput,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size (server max 100). Default 50.'),
        cursor: z.string().optional().describe('nextCursor from a previous page.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, limit, cursor }) => {
      const denied = checkScope(ctx.principal, tool.scopes.read);
      if (denied) return denied;
      const c = forWorkspace(ctx, workspace);
      return wrapToolErrors(
        async () => jsonText(await callApi(c, pageQuery('/api/v1/files', { cursor, limit }))),
        hints
      );
    }
  );

  // ── Identity under the tool's own prefix ───────────────────────────────────
  // Registered by the chassis (it reads `/me`, nothing of a domain) so that the
  // name every `workspace` argument and `get_me` point at always exists. Third,
  // right before the tool's set: `tools/list` keeps its order.
  server.registerTool(
    whoami,
    {
      description:
        'Who is connected: the user this MCP connection acts as, plus ALL their organizations ' +
        '(workspaces) with per-entry role/default/suspended flags. Returns { user: { id, email, ' +
        'name }, workspace, role, via, scopes, workspaces: [...], activeWorkspaceId }. The ' +
        'credential is the USER; the organization is a PER-CALL parameter: every tool accepts an ' +
        'optional `workspace` (an id from `workspaces[]`) — omitted, the entry flagged `default: ' +
        'true` is used (else the oldest membership). Call this first to discover the ids.',
      inputSchema: { workspace: workspaceInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace }) => {
      const denied = checkScope(ctx.principal, tool.scopes.read);
      if (denied) return denied;
      const c = forWorkspace(ctx, workspace);
      return wrapToolErrors(async () => jsonText(await callApi(c, '/api/v1/me')), hints);
    }
  );

  // The product surface: the tool's own set, after the three chassis tools.
  tool.registerTools(server, ctx);

  return server;
}
