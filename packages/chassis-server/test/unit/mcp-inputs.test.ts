import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { buildMcpServer, mcpInputs, type McpToolContext } from '@antasphere/chassis-server/mcp';

/**
 * The shared MCP inputs (`mcpInputs`) are the ones the chassis's own three
 * tools are declared with: a tool that builds its set from the same factory
 * shows the same `workspace`, `cursor` and `limit` in `tools/list`.
 */

const identity = { serverName: 'things', toolPrefix: 'things_' };

async function listedTools() {
  const server = buildMcpServer(
    {} as McpToolContext, // read at call time only; nothing is called here
    { version: '0.0.0-test', instanceName: 'Inputs' },
    {
      registerTools: () => {},
      instructions: () => 'test',
      errorHints: {},
      scopes: { read: 'things:read', write: 'things:write' }
    },
    identity
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'inputs-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** The JSON schema a zod input is listed as, the way the MCP SDK lists it. */
const listed = (input: z.ZodType) => {
  const schema = z.toJSONSchema(z.object({ v: input }), { io: 'input' }) as unknown as {
    properties: { v: Record<string, unknown> };
  };
  return schema.properties.v;
};

describe('mcpInputs, the shared MCP inputs', () => {
  const inputs = mcpInputs(identity);

  it('names `<toolPrefix>whoami` in the workspace input, and nothing of a tool elsewhere', () => {
    expect(inputs.workspaceInput.description).toBe(
      'Target organization (workspace id). Omit to use your default org — see things_whoami.'
    );
    expect(inputs.cursorInput.description).toBe('nextCursor from a previous page.');
    expect(inputs.limitInput.description).toBe('Page size (server max 100). Default 50.');
    expect(mcpInputs({ toolPrefix: 'other_' }).workspaceInput.description).toContain('see other_whoami.');
  });

  it('are the inputs the three chassis tools are listed with', async () => {
    const tools = await listedTools();
    expect(tools.map((t) => t.name)).toEqual(['get_me', 'list_files', 'things_whoami']);
    const props = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Record<string, unknown>>;

    for (const name of ['get_me', 'list_files', 'things_whoami']) {
      expect(props(name).workspace).toEqual(listed(inputs.workspaceInput));
      expect(props(name).workspace!.description).toBe(inputs.workspaceInput.description);
    }
    expect(props('list_files').cursor).toEqual(listed(inputs.cursorInput));
    expect(props('list_files').limit).toEqual(listed(inputs.limitInput));
    expect(props('list_files').cursor!.description).toBe(inputs.cursorInput.description);
    expect(props('list_files').limit!.description).toBe(inputs.limitInput.description);
    expect(Object.keys(props('list_files')).sort()).toEqual(['cursor', 'limit', 'workspace']);
  });

  it('validate as the API expects: a uuid, a string, an integer from 1 to 100, all optional', () => {
    expect(inputs.workspaceInput.safeParse(undefined).success).toBe(true);
    expect(inputs.workspaceInput.safeParse('not-a-uuid').success).toBe(false);
    expect(inputs.limitInput.safeParse(100).success).toBe(true);
    expect(inputs.limitInput.safeParse(101).success).toBe(false);
    expect(inputs.limitInput.safeParse(0).success).toBe(false);
    expect(inputs.limitInput.safeParse(1.5).success).toBe(false);
    expect(inputs.cursorInput.safeParse(undefined).success).toBe(true);
  });
});
