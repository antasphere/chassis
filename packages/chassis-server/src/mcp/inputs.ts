import { z } from 'zod';
import type { ToolIdentity } from '@antasphere/chassis-contract';

/**
 * The inputs every MCP tool of an instance shares, chassis tools and the
 * tool's own alike: ONE definition, so the same argument reads the same in
 * every tool of `tools/list`. The workspace input names `<toolPrefix>whoami`
 * (the identity tool the chassis registers), hence a factory over the MCP half
 * of the tool's identity. Build it once per server, next to `registerTools`.
 */
export function mcpInputs(identity: Pick<ToolIdentity['mcp'], 'toolPrefix'>) {
  return {
    /** The per-call target workspace; omitted, the caller's default one. */
    workspaceInput: z
      .uuid()
      .optional()
      .describe(
        `Target organization (workspace id). Omit to use your default org — see ${identity.toolPrefix}whoami.`
      ),
    /** The cursor of a paginated list, passed through to the API. */
    cursorInput: z.string().optional().describe('nextCursor from a previous page.'),
    /** The page size of a paginated list. */
    limitInput: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Page size (server max 100). Default 50.')
  };
}

export type McpInputs = ReturnType<typeof mcpInputs>;
