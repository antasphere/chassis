import { z } from 'zod';
import {
  PROJECT_METADATA_MAX_LENGTH,
  projectRoleSchema,
  projectsArchivedFilterSchema
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
 * The nine PROJECT tools, registered by the chassis beside
 * `<toolPrefix>whoami` — a project is a chassis concept (a subgroup of a
 * workspace with its own members and roles), so every tool an instance serves
 * over it is the chassis', not a tool's. Each one is a thin shim over the
 * instance's own /api/v1/projects called IN-PROCESS with the caller's bearer
 * forwarded verbatim: no privileged path, no MCP-only endpoint, and the API's
 * fail-closed scope allowlist plus the tiered project answer (404 before 403
 * before 409) apply unchanged.
 *
 * The conventions of the set are the chassis' (server.ts): reads carry
 * `readOnlyHint: true` and pre-check the read scope, writes describe
 * themselves confirm-first and pre-check the write scope, and every tool
 * takes the same optional `workspace` argument.
 *
 * Nothing here names a tool, a brand or a domain: the prefix arrives as
 * `identity.toolPrefix` and the wire shapes are the contract's.
 */

/**
 * What a project IS, in the words an agent that has never seen one needs. It
 * opens every description in the set, so a model reading `tools/list` learns
 * the concept once from whichever tool it looks at first.
 */
const WHAT_IS_A_PROJECT =
  'A project is a subgroup of an organization (workspace): a named space with its own members, ' +
  'used to group work and who may touch it.';

/**
 * The three roles, each containing the one before it. Written out wherever a
 * role is chosen or shown, because the whole authorization story of the
 * surface is in it.
 */
const ROLE_LADDER =
  'Roles, each containing the one before it: `viewer` reads the project and what is linked to it; ' +
  '`editor` may also write what is linked to it; `manager` may also rename the project, archive it, ' +
  'and manage its members. An organization owner or admin acts as a manager on every project.';

/** How an archived project behaves, and the one way back. */
const ARCHIVED_RULE =
  'An archived project is out of the default list and read-only: every change is refused until it ' +
  'is brought back. A project is never deleted.';

/**
 * The project codes, turned from an API code into a sentence a model can act
 * on. Merged into the instance's hint table (`mergeErrorHints`) so a refusal
 * reads as words rather than as a code. The role a refusal needs is the
 * message's, never assumed here: a tool's own route over a project may gate
 * on `editor` where every chassis route gates on `manager`.
 *
 * Every key here is a code only the project routes answer. `not_found` is
 * DELIBERATELY absent: it is the whole instance's code, a tool already words
 * it for its own domain (and its hint wins, `buildMcpServer`), and a sentence
 * about projects on the answer of every other 404 would be worse than none.
 * The tiered answer is stated in the descriptions instead, where it belongs:
 * a project you cannot read answers not found, so being refused is not proof
 * that it exists.
 */
export const PROJECT_ERROR_HINTS: ErrorHints = {
  insufficient_project_role:
    'Your role on this project is below what this needs (the message names the role; the chassis ' +
    'routes need manager). Ask a project manager, or an owner or admin of the organization, to make ' +
    'the change or to raise your role.',
  project_archived:
    'This project is archived, so it is read-only. Bring it back first (archive the project with ' +
    'archived set to false), then try again.',
  project_not_archived: 'This project is not archived, so there is nothing to bring back.',
  member_not_found:
    'Nobody matches in this organization: a project member must already be an active member of the ' +
    'organization, and is named by the exact user id or email address it joined with.',
  already_member:
    'This person is already a member of the project — change their role instead of adding them again.',
  guest_target:
    'This person is an external guest invited to one item: their account is not this organization’s ' +
    'to put on a project.'
};

/**
 * A project is named by an opaque id, never by its name: two projects may
 * share a name, and the API answers 404 to whoever cannot read one.
 */
const projectIdInput = z
  .uuid()
  .describe('The project id, from the list or the create answer (never the project name).');

const userIdInput = z
  .string()
  .min(1)
  .max(200)
  .describe('The member’s user id, as the member list reports it.');

const roleInput = projectRoleSchema.describe(
  `The role on this project. ${ROLE_LADDER.replace('Roles, each containing the one before it: ', '')}`
);

const nameInput = z.string().min(1).max(200).describe('The project name, as people will read it.');

const descriptionInput = z.string().max(2000).describe('A sentence or two on what the project is for.');

const metadataInput = z
  .record(z.string(), z.unknown())
  .describe(
    'Your own structured data on the project, a plain JSON object the server keeps verbatim ' +
      `(at most ${PROJECT_METADATA_MAX_LENGTH} characters once serialized). It REPLACES the whole ` +
      'object: read the project first and send the merged result, never a fragment.'
  );

/**
 * Register the nine project tools on a server. Called by `buildMcpServer`
 * after `<toolPrefix>whoami` and before the tool's own set, so `tools/list`
 * keeps one stable order: the chassis examples, whoami, the projects, the
 * tool's own.
 */
export function registerProjectTools(
  server: McpServer,
  ctx: McpToolContext,
  identity: McpIdentity,
  scopes: McpScopes,
  checkScope: ScopeCheck<string>,
  hints: ErrorHints
): void {
  const { workspaceInput, cursorInput, limitInput } = mcpInputs(identity);
  const prefix = identity.toolPrefix;

  /** The read/write pre-check + the per-call workspace seam, in one step. */
  const enter = (
    scope: string,
    workspace: string | undefined
  ): { denied: ToolTextResult } | { ctx: McpToolContext } => {
    const denied = checkScope(ctx.principal, scope);
    return denied ? { denied } : { ctx: forWorkspace(ctx, workspace) };
  };

  const run = (
    scope: string,
    workspace: string | undefined,
    body: (c: McpToolContext) => Promise<unknown>
  ): Promise<ToolTextResult> => {
    const entered = enter(scope, workspace);
    if ('denied' in entered) return Promise.resolve(entered.denied);
    return wrapToolErrors(async () => jsonText(await body(entered.ctx)), hints);
  };

  const jsonBody = (value: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  });

  // ── Reads ────────────────────────────────────────────────────────────────

  server.registerTool(
    `${prefix}list_projects`,
    {
      description:
        `List the projects you belong to in an organization, newest first. ${WHAT_IS_A_PROJECT} ` +
        `${ROLE_LADDER} Returns { projects: [{ id, name, description, metadata, archivedAt, ` +
        'createdBy, createdAt, updatedAt, myRole, memberCount }], nextCursor } — `myRole` is YOUR ' +
        'role on that project, so it tells you in advance what you may do. When nextCursor is ' +
        `non-null, call again with cursor set to it. By default only the live projects are listed; ` +
        `${ARCHIVED_RULE}`,
      inputSchema: {
        workspace: workspaceInput,
        archived: projectsArchivedFilterSchema
          .optional()
          .describe(
            'Which projects to list: "false" (the default) the live ones, "true" the archived ones, ' +
              '"all" both.'
          ),
        limit: limitInput,
        cursor: cursorInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, archived, limit, cursor }) =>
      run(scopes.read, workspace, (c) =>
        callApi(c, pageQuery('/api/v1/projects', { cursor, limit }, { archived }))
      )
  );

  server.registerTool(
    `${prefix}get_project`,
    {
      description:
        `Read one project, with your own role on it. ${WHAT_IS_A_PROJECT} ${ROLE_LADDER} Returns ` +
        '{ id, name, description, metadata, archivedAt, createdBy, createdAt, updatedAt, myRole, ' +
        'memberCount }. A project you are not a member of answers "not found" whether or not it ' +
        'exists — being refused is not proof that it is there.',
      inputSchema: { workspace: workspaceInput, projectId: projectIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, projectId }) =>
      run(scopes.read, workspace, (c) => callApi(c, `/api/v1/projects/${projectId}`))
  );

  server.registerTool(
    `${prefix}list_project_members`,
    {
      description:
        `List a project's members and what each of them may do. ${ROLE_LADDER} Returns ` +
        '{ members: [{ userId, email, name, role, addedBy, createdAt }], nextCursor }; pass the ' +
        '`userId` of a row to the tools that change or remove a member.',
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectIdInput,
        limit: limitInput,
        cursor: cursorInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, projectId, limit, cursor }) =>
      run(scopes.read, workspace, (c) =>
        callApi(c, pageQuery(`/api/v1/projects/${projectId}/members`, { cursor, limit }))
      )
  );

  // ── Writes ───────────────────────────────────────────────────────────────

  server.registerTool(
    `${prefix}create_project`,
    {
      description:
        `Create a project in an organization — confirm with the user first (name included). ` +
        `${WHAT_IS_A_PROJECT} You become its first manager, so you may then add members and set ` +
        `their roles. ${ROLE_LADDER} Returns the new project, whose id is what every other ` +
        'project tool takes.',
      inputSchema: {
        workspace: workspaceInput,
        name: nameInput,
        description: descriptionInput.optional(),
        metadata: metadataInput.optional()
      }
    },
    async ({ workspace, name, description, metadata }) =>
      run(scopes.write, workspace, (c) =>
        callApi(
          c,
          '/api/v1/projects',
          jsonBody({
            name,
            ...(description !== undefined ? { description } : {}),
            ...(metadata !== undefined ? { metadata } : {})
          })
        )
      )
  );

  server.registerTool(
    `${prefix}update_project`,
    {
      description:
        'Change a project’s name, description or metadata — confirm with the user first. Needs the ' +
        'manager role on the project (an organization owner or admin has it everywhere). Send only ' +
        'the fields you are changing; `metadata` REPLACES the whole object, and a description set to ' +
        `null clears it. ${ARCHIVED_RULE} Returns the project as it now is.`,
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectIdInput,
        name: nameInput.optional(),
        description: descriptionInput
          .nullable()
          .optional()
          .describe('A sentence or two on what the project is for; null clears it.'),
        metadata: metadataInput.optional()
      }
    },
    async ({ workspace, projectId, name, description, metadata }) => {
      if (name === undefined && description === undefined && metadata === undefined) {
        return deny(
          'Nothing to change: pass at least one of name, description or metadata. ' +
            'Read the project first if you need its current values.'
        );
      }
      return run(scopes.write, workspace, (c) =>
        callApi(c, `/api/v1/projects/${projectId}`, {
          ...jsonBody({
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(metadata !== undefined ? { metadata } : {})
          }),
          method: 'PATCH'
        })
      );
    }
  );

  server.registerTool(
    `${prefix}archive_project`,
    {
      description:
        'Archive a project, or bring an archived one back — confirm with the user first. Needs the ' +
        `manager role on the project. ${ARCHIVED_RULE} Nothing is lost: archiving is reversible, by ` +
        'calling this same tool with `archived` set to false. Returns the project in its new state.',
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectIdInput,
        archived: z
          .boolean()
          .optional()
          .describe('true (the default) archives the project; false brings an archived one back.')
      },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, projectId, archived }) => {
      const leg = archived === false ? 'unarchive' : 'archive';
      return run(scopes.write, workspace, (c) =>
        callApi(c, `/api/v1/projects/${projectId}/${leg}`, { method: 'POST' })
      );
    }
  );

  server.registerTool(
    `${prefix}add_project_member`,
    {
      description:
        'Put one of the organization’s own members on a project, with a role — confirm with the ' +
        `user first. Needs the manager role on the project. ${ROLE_LADDER} Name the person by ` +
        'either `userId` or `email`, exactly one of the two, and it must be someone who is already ' +
        'an active member of the organization: this invites nobody and creates no account. Returns ' +
        'the new project member.',
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectIdInput,
        userId: userIdInput.optional(),
        email: z.email().optional().describe('The email address the person joined the organization with.'),
        role: roleInput
      }
    },
    async ({ workspace, projectId, userId, email, role }) => {
      if ((userId === undefined) === (email === undefined)) {
        return deny(
          'Name the person exactly one way: either userId or email, not both and not neither. ' +
            'The organization member list has both for everyone who has joined.'
        );
      }
      return run(scopes.write, workspace, (c) =>
        callApi(
          c,
          `/api/v1/projects/${projectId}/members`,
          jsonBody({ ...(userId !== undefined ? { userId } : { email }), role })
        )
      );
    }
  );

  server.registerTool(
    `${prefix}set_project_member_role`,
    {
      description:
        'Change what a project member may do — confirm with the user first. Needs the manager role ' +
        `on the project. ${ROLE_LADDER} Raising someone to manager lets them manage the members and ` +
        'archive the project too. Returns the member as they now are.',
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectIdInput,
        userId: userIdInput,
        role: roleInput
      }
    },
    async ({ workspace, projectId, userId, role }) =>
      run(scopes.write, workspace, (c) =>
        callApi(c, `/api/v1/projects/${projectId}/members/${encodeURIComponent(userId)}`, {
          ...jsonBody({ role }),
          method: 'PATCH'
        })
      )
  );

  server.registerTool(
    `${prefix}remove_project_member`,
    {
      description:
        'Take someone off a project — confirm with the user first; their access to the project and ' +
        'to what is linked to it stops immediately. Needs the manager role on the project (anyone ' +
        'may remove themselves). This removes the person from THIS project only: they stay a member ' +
        'of the organization. Returns a last snapshot of the member that was removed.',
      inputSchema: { workspace: workspaceInput, projectId: projectIdInput, userId: userIdInput },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, projectId, userId }) =>
      run(scopes.write, workspace, (c) =>
        callApi(c, `/api/v1/projects/${projectId}/members/${encodeURIComponent(userId)}`, {
          method: 'DELETE'
        })
      )
  );
}
