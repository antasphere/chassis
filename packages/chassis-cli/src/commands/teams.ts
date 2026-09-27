import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import type { Team, TeamMemberInfo } from '@antasphere/chassis-contract';
import { CliApiRefusal, CliUsageError, drainPages, printJson, table, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';

/**
 * The team commands: a team is a named group of the workspace's own members,
 * on both editions. Every non-guest member reads the teams and their members;
 * an owner or an admin creates, renames and deletes them and seats people.
 * In a workspace the Antasphere account site manages, the teams are its
 * projection: read here, every write refused with `hub_managed` and the page
 * where they are managed. The family mirrors the hub's `antasphere teams`
 * with this chassis's conventions: `<team>` is a slug or an id, every human
 * line goes through the sanitizing sinks the runner installed (a team name is
 * somebody else's text), and `--json` is the API payload verbatim.
 */

/** What a `member_not_found` was about: the workspace (`add`) or the team (`remove`). */
export type TeamLookup = 'team' | 'workspace-member' | 'team-member';

/** The refusal context only the command knows: the slug it passed, the person it named. */
export interface TeamRefusalContext {
  lookup: TeamLookup;
  /** The slug the caller passed; absent, the server derived it from the name. */
  slug?: string | undefined;
  /** The person the caller named, for `already_member`. */
  who?: string | undefined;
}

/**
 * The server's team refusals as sentences. Returns the line, or null when the
 * error is not one of them (the runner's generic handling is then the honest
 * answer).
 */
export function explainTeamRefusal(e: PlatformApiError, ctx: TeamRefusalContext): string | null {
  switch (e.code) {
    case 'forbidden':
      return e.status === 403 ? 'Only an owner or an admin manages teams.' : null;
    case 'hub_managed': {
      const url = (e.details as { manageUrl?: unknown } | undefined)?.manageUrl;
      return typeof url === 'string' && url
        ? `Teams of this workspace are managed on the Antasphere account site: ${url}`
        : 'Teams of this workspace are managed on the Antasphere account site.';
    }
    case 'slug_taken':
      return ctx.slug !== undefined
        ? `A team of this workspace already uses the slug "${ctx.slug}".`
        : 'A team of this workspace already uses the slug this name makes; pass --slug.';
    case 'already_member':
      return `${ctx.who ?? 'That person'} is already in this team.`;
    case 'member_not_found':
      return ctx.lookup === 'team-member'
        ? 'That person is not a member of this team.'
        : 'No active member of this workspace matches — check the user id or email. Only a member of the workspace can join a team.';
    case 'not_found':
      return 'No such team in this workspace.';
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not take part in its teams.';
    default:
      return null;
  }
}

/** Run a team call, turning the known refusals into sentences. */
export async function explainedTeam<T>(ctx: TeamRefusalContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      const line = explainTeamRefusal(e, ctx);
      if (line) throw new CliApiRefusal(line, e.status);
    }
    throw e;
  }
}

/** Every team of the workspace, page after page. */
export async function allTeams(client: ChassisClient<string>): Promise<Team[]> {
  const first = await client.teams();
  return drainPages({ rows: first.teams, nextCursor: first.nextCursor }, async (cursor) => {
    const page = await client.teams({ cursor });
    return { rows: page.teams, nextCursor: page.nextCursor };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A team named by its slug or its id (the hub's `findTeam`). An id is read
 * directly; a slug, or an id the server does not know (a slug may look like
 * one), is looked up in the workspace's list, by slug first, then by id.
 */
export async function resolveTeam(client: ChassisClient<string>, ref: string): Promise<Team> {
  return explainedTeam({ lookup: 'team' }, async () => {
    if (UUID.test(ref)) {
      try {
        return await client.team(ref);
      } catch (e) {
        if (!(e instanceof PlatformApiError && (e.status === 404 || e.status === 400))) throw e;
      }
    }
    const teams = await allTeams(client);
    const team = teams.find((t) => t.slug === ref) ?? teams.find((t) => t.id === ref);
    if (!team) throw new CliApiRefusal(`No team of this workspace has the slug or id "${ref}".`, 404);
    return team;
  });
}

/** An `@` makes the argument an email, anything else a user id (as `projects members add`). */
function personRef(value: string): { email: string } | { userId: string } {
  return value.includes('@') ? { email: value } : { userId: value };
}

/** The date part of an ISO 8601 timestamp (`2026-10-23`). */
function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** A team's name, marked when the Antasphere account site owns it. */
export function teamName(t: Pick<Team, 'name' | 'hubTeamId'>): string {
  return t.hubTeamId ? `${t.name} (Antasphere)` : t.name;
}

/** One team, as the human sees it. */
function teamLines(t: Team): string {
  return (
    `${teamName(t)}\n` +
    `  id:       ${t.id}\n` +
    `  slug:     ${t.slug}\n` +
    `  members:  ${t.membersCount}\n` +
    `  yours:    ${t.isMember ? 'yes' : 'no'}\n` +
    (t.hubTeamId ? `  managed:  on the Antasphere account site\n` : '') +
    `  created:  ${t.createdAt}\n`
  );
}

/** Every member of one team, page after page. */
async function allTeamMembers(client: ChassisClient<string>, teamId: string): Promise<TeamMemberInfo[]> {
  const first = await client.teamMembers(teamId);
  return drainPages({ rows: first.members, nextCursor: first.nextCursor }, async (cursor) => {
    const page = await client.teamMembers(teamId, { cursor });
    return { rows: page.members, nextCursor: page.nextCursor };
  });
}

export function registerTeamCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext } = kit;

  const teams = program
    .command('teams')
    .description('The teams of the workspace (named groups of its members)')
    .addHelpText(
      'after',
      '\nEvery member reads the teams; an owner or an admin creates, renames and deletes them and\n' +
        'seats people. In a workspace the Antasphere account site manages, the teams are read here\n' +
        'and managed there.\n'
    );

  // ── teams list ────────────────────────────────────────────────────────────
  teams
    .command('list')
    .description("List the workspace's teams (every page)")
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const rows = await explainedTeam({ lookup: 'team' }, () => allTeams(ctx.client));
      if (ctx.json) return printJson(io, { teams: rows, nextCursor: null });
      if (rows.length === 0) {
        io.out.write('No teams.\n');
        return;
      }
      io.out.write(
        table([
          ['SLUG', 'NAME', 'MEMBERS', 'YOURS', 'CREATED'],
          ...rows.map((t) => [
            t.slug,
            teamName(t),
            String(t.membersCount),
            t.isMember ? 'yes' : 'no',
            fmtDate(t.createdAt)
          ])
        ])
      );
    });

  // ── teams get ─────────────────────────────────────────────────────────────
  teams
    .command('get <team>')
    .description('Show one team (<team> is a slug or an id)')
    .action(async (ref: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      if (ctx.json) return printJson(io, team);
      io.out.write(teamLines(team));
    });

  // ── teams create ──────────────────────────────────────────────────────────
  teams
    .command('create <name>')
    .description('Create a team (owner or admin; the slug is derived from the name when --slug is absent)')
    .option('--slug <slug>', 'the team slug (lowercase words joined by dashes)')
    .action(async (name: string, opts: { slug?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await explainedTeam({ lookup: 'team', slug: opts.slug || undefined }, () =>
        ctx.client.createTeam({ name, ...(opts.slug ? { slug: opts.slug } : {}) })
      );
      if (ctx.json) return printJson(io, team);
      io.out.write(`Created team ${team.slug}.\n${teamLines(team)}`);
    });

  // ── teams rename ──────────────────────────────────────────────────────────
  teams
    .command('rename <team>')
    .description('Rename a team or change its slug (owner or admin; <team> is a slug or an id)')
    .option('--name <name>', 'the new name')
    .option('--slug <slug>', 'the new slug')
    .action(async (ref: string, opts: { name?: string; slug?: string }, cmd: Command) => {
      if (opts.name === undefined && opts.slug === undefined) {
        throw new CliUsageError('Nothing to change — pass --name <name>, --slug <slug>, or both.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      const updated = await explainedTeam({ lookup: 'team', slug: opts.slug }, () =>
        ctx.client.updateTeam(team.id, {
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.slug !== undefined ? { slug: opts.slug } : {})
        })
      );
      if (ctx.json) return printJson(io, updated);
      io.out.write(`Team ${updated.slug}: ${updated.name}\n`);
    });

  // ── teams delete ──────────────────────────────────────────────────────────
  teams
    .command('delete <team>')
    .description(
      'Delete a team; its members stay in the workspace (owner or admin; <team> is a slug or an id)'
    )
    .option('--yes', 'confirm the deletion', false)
    .action(async (ref: string, opts: { yes: boolean }, cmd: Command) => {
      if (!opts.yes) {
        throw new CliUsageError(`Deleting a team cannot be undone: rerun with --yes to delete "${ref}".`);
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      const deleted = await explainedTeam({ lookup: 'team' }, () => ctx.client.deleteTeam(team.id));
      if (ctx.json) return printJson(io, deleted);
      io.out.write(`Deleted team ${deleted.slug}. Its members stay in the workspace.\n`);
    });

  // ── teams members ─────────────────────────────────────────────────────────
  teams
    .command('members <team>')
    .description("List a team's members (every page; <team> is a slug or an id)")
    .action(async (ref: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      const rows = await explainedTeam({ lookup: 'team' }, () => allTeamMembers(ctx.client, team.id));
      if (ctx.json) return printJson(io, { members: rows, nextCursor: null });
      if (rows.length === 0) {
        io.out.write(`Team ${team.slug} has no members.\n`);
        return;
      }
      io.out.write(
        table([
          ['USER ID', 'EMAIL', 'ROLE', 'ADDED', 'NAME'],
          ...rows.map((m) => [m.userId, m.email, m.role, fmtDate(m.addedAt), m.name || '-'])
        ])
      );
    });

  // ── teams add ─────────────────────────────────────────────────────────────
  teams
    .command('add <team> <userIdOrEmail>')
    .description('Seat a member of the workspace in a team (owner or admin; an @ makes it an email)')
    .action(async (ref: string, who: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      const added = await explainedTeam({ lookup: 'workspace-member', who }, () =>
        ctx.client.addTeamMember(team.id, personRef(who))
      );
      if (ctx.json) return printJson(io, added);
      io.out.write(`Added ${added.name} <${added.email}> to team ${team.slug}.\n`);
    });

  // ── teams remove ──────────────────────────────────────────────────────────
  teams
    .command('remove <team> <userIdOrEmail>')
    .description('Remove a member from a team; they stay in the workspace (owner or admin)')
    .action(async (ref: string, who: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const team = await resolveTeam(ctx.client, ref);
      // The route takes a user id; an email is looked up among the team's members.
      let userId = who;
      if (who.includes('@')) {
        const wanted = who.trim().toLowerCase();
        const members = await explainedTeam({ lookup: 'team' }, () => allTeamMembers(ctx.client, team.id));
        const hit = members.find((m) => m.email.toLowerCase() === wanted);
        if (!hit) throw new CliApiRefusal('That person is not a member of this team.', 404);
        userId = hit.userId;
      }
      const removed = await explainedTeam({ lookup: 'team-member', who }, () =>
        ctx.client.removeTeamMember(team.id, userId)
      );
      if (ctx.json) return printJson(io, removed);
      io.out.write(`Removed ${removed.name} <${removed.email}> from team ${team.slug}.\n`);
    });
}
