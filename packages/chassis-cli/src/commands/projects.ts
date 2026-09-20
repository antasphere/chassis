import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient, type ListParams } from '@antasphere/chassis-sdk';
import type {
  Project,
  ProjectCreate,
  ProjectMember,
  ProjectMemberAdd,
  ProjectRole,
  ProjectsArchivedFilter,
  ProjectUpdate
} from '@antasphere/chassis-contract';
import { CliUsageError, printJson, table, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';

/**
 * The project commands: a project is a subgroup of the workspace with its own
 * members and three roles (viewer < editor < manager). The chassis owns the
 * concept, so these commands spell no tool and no resource — what a project
 * HOLDS is the tool's own group's business.
 *
 * Every refusal the server has a code for is turned into a sentence here
 * (`explainProjectRefusal`): the wire messages are correct but terse, and the
 * tiered answer (404 for a project the caller cannot read, 403 for a proven
 * reader who may not act, 409 for an archived one) only reads as an
 * explanation once it says WHICH of the three happened. Anything else is
 * rethrown and the runner prints it unchanged.
 *
 * `--json` is the API payload verbatim through `printJson` (the raw sink);
 * every human line goes through the sanitizing sinks the runner installed —
 * a project name, a description and a member's display name are all somebody
 * else's text heading for a terminal.
 */

const ROLES: readonly ProjectRole[] = ['viewer', 'editor', 'manager'];

/** `--role`, validated here so a typo is a usage error, never a 400. */
function parseRole(value: string): ProjectRole {
  if ((ROLES as readonly string[]).includes(value)) return value as ProjectRole;
  throw new CliUsageError(`Unknown role "${value}" — one of ${ROLES.join(', ')}.`);
}

/** `--archived <false|true|all>`; `false` (the live projects) is the server's default. */
function parseArchivedFilter(value: string): ProjectsArchivedFilter {
  if (value === 'false' || value === 'true' || value === 'all') return value;
  throw new CliUsageError(`Unknown --archived value "${value}" — one of false, true, all.`);
}

/** `--metadata <json>`: a JSON OBJECT, the opaque seam the contract defines. */
function parseMetadata(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliUsageError('--metadata takes a JSON object, and this did not parse as JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUsageError('--metadata takes a JSON object (not an array, a string, or null).');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The membership argument: an `@` makes it an email, anything else a user id.
 * Better Auth ids are opaque text, so there is no id shape to test for — but
 * an email always carries the `@`, and a user id never may (the server reads
 * exactly one of the two fields, so guessing wrong is a `member_not_found`
 * rather than a silent mismatch).
 */
export function memberRef(value: string): { email: string } | { userId: string } {
  return value.includes('@') ? { email: value } : { userId: value };
}

/**
 * What the command was looking for, which is the ONE thing the wire cannot
 * say: `member_not_found` means "nobody in this workspace matches" on `add`
 * (the lookup is workspace-wide) and "not a member of this project" on
 * `role` / `remove` (the lookup is inside the project). Same code, two
 * different things to do about it.
 */
export type ProjectLookup = 'project' | 'workspace-member' | 'project-member';

/**
 * The server's project refusals as sentences. Returns the line, or null when
 * the error is not one of them (the runner's generic handling is then the
 * honest answer).
 */
export function explainProjectRefusal(e: PlatformApiError, what: ProjectLookup): string | null {
  switch (e.code) {
    case 'not_found':
      return 'No such project, or it is not yours to read. (A project you are not a member of answers the same way: its existence is not probeable.)';
    case 'insufficient_project_role':
      return 'You need the manager role on this project to do that.';
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not take part in projects.';
    case 'project_archived':
      return 'This project is archived and read-only. Unarchive it first to change it.';
    case 'project_not_archived':
      return 'This project is not archived, so there is nothing to unarchive.';
    case 'already_member':
      return 'That person is already a member of this project. Change their role with `members role` instead.';
    case 'member_not_found':
      return what === 'workspace-member'
        ? 'No active member of this workspace matches — check the user id or email. Only a member of the workspace can join a project.'
        : 'That person is not a member of this project.';
    case 'guest_target':
      return 'That person is a guest of the workspace, and a guest cannot be a project member. Invite them as a workspace member first.';
    default:
      return null;
  }
}

/** Run a project call, turning the known refusals into sentences. */
async function explained<T>(what: ProjectLookup, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      const line = explainProjectRefusal(e, what);
      if (line) throw new CliUsageError(line);
    }
    throw e;
  }
}

/** One project, as the human sees it. */
function projectLines(p: Project): string {
  const metadataKeys = Object.keys(p.metadata);
  return (
    `${p.name}${p.archivedAt ? '  [archived]' : ''}\n` +
    `  id:          ${p.id}\n` +
    `  your role:   ${p.myRole}\n` +
    `  members:     ${p.memberCount}\n` +
    (p.description ? `  description: ${p.description}\n` : '') +
    (metadataKeys.length > 0 ? `  metadata:    ${metadataKeys.join(', ')}\n` : '') +
    (p.archivedAt ? `  archived:    ${p.archivedAt}\n` : '') +
    `  created:     ${p.createdAt}\n`
  );
}

/** One member, as the human sees it. */
function memberLine(m: ProjectMember): string {
  return `${m.name} <${m.email}> is a ${m.role} of this project (user ${m.userId}).\n`;
}

export function registerProjectCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext } = kit;

  const projects = program
    .command('projects')
    .description('Manage the projects of the workspace (subgroups with their own members)');

  // ── projects list ─────────────────────────────────────────────────────────
  projects
    .command('list')
    .description('List the projects you belong to (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .option('--archived <false|true|all>', 'which projects to list (default: false, the live ones)')
    .action(
      async (opts: { cursor?: string; limit?: number; all: boolean; archived?: string }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const params: ListParams & { archived?: ProjectsArchivedFilter } = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        if (opts.archived !== undefined) params.archived = parseArchivedFilter(opts.archived);
        const first = await explained('project', () => ctx.client.projects(params));
        const rows = [...first.projects];
        if (opts.all) {
          let cursor = first.nextCursor;
          while (cursor) {
            const next = cursor;
            const page = await explained('project', () => ctx.client.projects({ ...params, cursor: next }));
            rows.push(...page.projects);
            cursor = page.nextCursor;
          }
        }
        const nextCursor = opts.all ? null : first.nextCursor;
        // The wire shape, so scripts can thread nextCursor (--all drains it to null).
        if (ctx.json) return printJson(io, { projects: rows, nextCursor });
        if (rows.length === 0) {
          io.out.write('No projects.\n');
          return;
        }
        io.out.write(
          table(
            rows.map((p) => [
              p.id,
              p.myRole,
              `${p.memberCount} member${p.memberCount === 1 ? '' : 's'}`,
              `${p.name}${p.archivedAt ? '  [archived]' : ''}`
            ])
          )
        );
        if (nextCursor) {
          io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
      }
    );

  // ── projects get ──────────────────────────────────────────────────────────
  projects
    .command('get <id>')
    .description('Show one project, with your own role on it')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const project = await explained('project', () => ctx.client.project(id));
      if (ctx.json) return printJson(io, project);
      io.out.write(projectLines(project));
    });

  // ── projects create ───────────────────────────────────────────────────────
  projects
    .command('create <name>')
    .description('Create a project; you become its first manager')
    .option('--description <text>', 'what the project is for')
    .option('--metadata <json>', 'a JSON object of your own, opaque to the server')
    .action(async (name: string, opts: { description?: string; metadata?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const body: ProjectCreate = {
        name,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.metadata !== undefined ? { metadata: parseMetadata(opts.metadata) } : {})
      };
      const project = await explained('project', () => ctx.client.createProject(body));
      if (ctx.json) return printJson(io, project);
      io.out.write(`Created project "${project.name}".\n${projectLines(project)}`);
    });

  // ── projects update ───────────────────────────────────────────────────────
  projects
    .command('update <id>')
    .description("Change a project's name, description or metadata (manager)")
    .option('--name <name>', 'rename the project')
    .option('--description <text>', 'replace the description')
    .option('--clear-description', 'remove the description', false)
    .option('--metadata <json>', 'replace the whole metadata object (a JSON object)')
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          description?: string;
          clearDescription: boolean;
          metadata?: string;
        },
        cmd: Command
      ) => {
        if (opts.description !== undefined && opts.clearDescription) {
          throw new CliUsageError('Pass either --description <text> or --clear-description, not both.');
        }
        const patch: ProjectUpdate = {
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.clearDescription
            ? { description: null }
            : opts.description !== undefined
              ? { description: opts.description }
              : {}),
          ...(opts.metadata !== undefined ? { metadata: parseMetadata(opts.metadata) } : {})
        } as ProjectUpdate;
        if (Object.keys(patch).length === 0) {
          throw new CliUsageError(
            'Nothing to change — pass --name, --description, --clear-description or --metadata.'
          );
        }
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const project = await explained('project', () => ctx.client.updateProject(id, patch));
        if (ctx.json) return printJson(io, project);
        io.out.write(`Updated project "${project.name}".\n${projectLines(project)}`);
      }
    );

  // ── projects archive / unarchive ──────────────────────────────────────────
  projects
    .command('archive <id>')
    .description('Archive a project: out of the default list and read-only (manager). Never deleted')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const project = await explained('project', () => ctx.client.archiveProject(id));
      if (ctx.json) return printJson(io, project);
      io.out.write(
        `Archived "${project.name}". It is read-only and out of \`projects list\` until you unarchive it.\n`
      );
    });

  projects
    .command('unarchive <id>')
    .description('Bring an archived project back (manager)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const project = await explained('project', () => ctx.client.unarchiveProject(id));
      if (ctx.json) return printJson(io, project);
      io.out.write(`Unarchived "${project.name}". It is writable again.\n`);
    });

  // ── projects members ──────────────────────────────────────────────────────
  const members = projects.command('members').description("Manage a project's members");

  members
    .command('list <project>')
    .description('List the members of a project')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(
      async (project: string, opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const params: ListParams = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        const first = await explained('project', () => ctx.client.projectMembers(project, params));
        const rows = [...first.members];
        if (opts.all) {
          let cursor = first.nextCursor;
          while (cursor) {
            const next = cursor;
            const page = await explained('project', () =>
              ctx.client.projectMembers(project, { ...params, cursor: next })
            );
            rows.push(...page.members);
            cursor = page.nextCursor;
          }
        }
        const nextCursor = opts.all ? null : first.nextCursor;
        if (ctx.json) return printJson(io, { members: rows, nextCursor });
        if (rows.length === 0) {
          io.out.write('No members.\n');
          return;
        }
        io.out.write(table(rows.map((m) => [m.userId, m.role, m.email, m.name])));
        if (nextCursor) {
          io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
      }
    );

  members
    .command('add <project> <userIdOrEmail>')
    .description('Add a member of the workspace to the project (manager)')
    .requiredOption('--role <viewer|editor|manager>', 'the role they get on this project')
    .action(async (project: string, who: string, opts: { role: string }, cmd: Command) => {
      const role = parseRole(opts.role);
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const body: ProjectMemberAdd = { ...memberRef(who), role };
      // `add` looks the person up across the WORKSPACE, so its
      // `member_not_found` is about the workspace, not about the project.
      const member = await explained('workspace-member', () => ctx.client.addProjectMember(project, body));
      if (ctx.json) return printJson(io, member);
      io.out.write(`Added ${memberLine(member)}`);
    });

  members
    .command('role <project> <userId> <role>')
    .description("Change a member's role on the project (manager)")
    .action(async (project: string, userId: string, role: string, _opts, cmd: Command) => {
      const parsed = parseRole(role);
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const member = await explained('project-member', () =>
        ctx.client.setProjectMemberRole(project, userId, parsed)
      );
      if (ctx.json) return printJson(io, member);
      io.out.write(`Now ${memberLine(member)}`);
    });

  members
    .command('remove <project> <userId>')
    .description('Remove a member from the project (a manager removes anyone; anyone removes themselves)')
    .action(async (project: string, userId: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const member = await explained('project-member', () => ctx.client.removeProjectMember(project, userId));
      if (ctx.json) return printJson(io, member);
      io.out.write(`Removed ${member.name} <${member.email}> from this project.\n`);
    });
}
