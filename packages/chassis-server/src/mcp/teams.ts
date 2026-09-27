import { z } from 'zod';
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
 * The two TEAM reads (PRDCT-2813), registered by the chassis right after the
 * project tools: a team is a chassis concept (a named group of a workspace's
 * own members, on both editions), so the tools over it are the chassis'. Thin
 * shims over the instance's own /api/v1/teams called IN-PROCESS with the
 * caller's bearer forwarded verbatim, like every other chassis tool.
 *
 * READS ONLY, by design: shaping a team (creating it, seating people) is a
 * person's act on the People page, or on the Antasphere account site for a
 * workspace it manages; an agent puts a team on a project through
 * `<toolPrefix>add_project_member` with `teamId`. Nothing here names a tool,
 * a brand or a domain.
 */

/** What a team IS, opening both descriptions. */
const WHAT_IS_A_TEAM =
  'A team is a named group of the organization’s own members (for example "Design" or "Sales"). ' +
  'A team can be put on a project with a role, and every member of the team then holds that role ' +
  'on the project.';

/** Where teams come from and where they are shaped. */
const WHERE_TEAMS_LIVE =
  'In an organization managed by the Antasphere account site, the teams come from there and are ' +
  'read-only here. Creating a team or adding people to one is done by a person on the People page, ' +
  'or on the Antasphere account site for an organization it manages, never through these tools.';

const teamIdInput = z.uuid().describe('The team id, from the teams list (never the team name or slug).');

/** Register the two team reads on a server, after the project tools. */
export function registerTeamTools(
  server: McpServer,
  ctx: McpToolContext,
  identity: McpIdentity,
  scopes: McpScopes,
  checkScope: ScopeCheck<string>,
  hints: ErrorHints
): void {
  const { workspaceInput, cursorInput, limitInput } = mcpInputs(identity);
  const prefix = identity.toolPrefix;

  const read = (workspace: string | undefined, path: string): Promise<ToolTextResult> => {
    const denied = checkScope(ctx.principal, scopes.read);
    if (denied) return Promise.resolve(denied);
    const c = forWorkspace(ctx, workspace);
    return wrapToolErrors(async () => jsonText(await callApi(c, path)), hints);
  };

  server.registerTool(
    `${prefix}list_teams`,
    {
      description:
        `List the teams of an organization, newest first. ${WHAT_IS_A_TEAM} ${WHERE_TEAMS_LIVE} ` +
        'Returns { teams: [{ id, slug, name, membersCount, isMember, hubTeamId, createdAt, ' +
        'updatedAt }], nextCursor } — `isMember` says whether YOU are in the team, and `hubTeamId` ' +
        'is set when the team comes from the Antasphere account site. Pass a team `id` as `teamId` ' +
        `to ${prefix}list_team_members or ${prefix}add_project_member. When nextCursor is non-null, ` +
        'call again with cursor set to it.',
      inputSchema: { workspace: workspaceInput, limit: limitInput, cursor: cursorInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, limit, cursor }) => read(workspace, pageQuery('/api/v1/teams', { cursor, limit }))
  );

  server.registerTool(
    `${prefix}list_team_members`,
    {
      description:
        `List the members of one team. ${WHAT_IS_A_TEAM} ${WHERE_TEAMS_LIVE} Returns { members: ` +
        '[{ userId, email, name, role, isActive, addedAt }], nextCursor } — `role` is the person’s ' +
        'role in the ORGANIZATION (a team has no roles of its own). When nextCursor is non-null, call ' +
        'again with cursor set to it.',
      inputSchema: {
        workspace: workspaceInput,
        teamId: teamIdInput,
        limit: limitInput,
        cursor: cursorInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, teamId, limit, cursor }) =>
      read(workspace, pageQuery(`/api/v1/teams/${teamId}/members`, { cursor, limit }))
  );
}
