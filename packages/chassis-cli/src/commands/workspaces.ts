import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import { CliApiRefusal, CliUsageError, printJson, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';
import { findWorkspace, matchWorkspace } from '../workspace.js';

/**
 * Which workspace the commands run in (PRDCT-2419, PRDCT-2947): `workspaces`
 * lists the memberships with the organization ids `--org` takes, and
 * `workspace default` (PRDCT-2815) sets what the SERVER resolves for the
 * person when a request names none, for every credential of theirs: set
 * here on a self-hosted instance; on the cloud it is a setting of the
 * Antasphere account, and the refusal names the page. Nothing is saved on
 * this machine: a command names its organization with `--org` or its
 * workspace with `--workspace`, or runs in the default (one organization
 * notion, the hub's).
 *
 * Both talk to `/me` WITHOUT the selection (`workspace: false`): they are the
 * commands a person repairs a stale selection with, so a selection the
 * server refuses must never stop them. There is deliberately no
 * `workspaces create`: `POST /workspaces` is a session-only act.
 */

export function registerWorkspaceCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext, workspaceSource } = kit;
  const { describeSelection } = kit.workspace;

  program
    .command('workspaces')
    .description('List your workspaces (the one the commands run in marked *)')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx, { workspace: false });
      const me = await ctx.client.me();
      const selection = ctx.workspaceSelection;
      const source = workspaceSource(ctx);
      // With a selection, the mark is the membership it names; without one,
      // the workspace the server resolved (its default, or the key's pin).
      const selected = selection
        ? (findWorkspace(me.workspaces, selection.value).match?.id ?? null)
        : me.activeWorkspaceId;
      if (selection && selected === null) {
        io.err.write(
          `Warning: "${selection.value}" (selected by ${describeSelection(selection)}) names none of these ` +
            'workspaces, so commands that use it are refused.\n'
        );
      }
      if (ctx.json) {
        return printJson(io, { workspaces: me.workspaces, selectedWorkspaceId: selected, source });
      }
      if (me.workspaces.length === 0) {
        io.out.write('No workspaces.\n');
        return;
      }
      let anyOrg = false;
      for (const w of me.workspaces) {
        const org = (w as { centralAccountId?: string | null }).centralAccountId ?? null;
        if (org) anyOrg = true;
        const flags = [w.default ? '(default)' : null, w.suspended ? '[suspended]' : null]
          .filter(Boolean)
          .join(' ');
        io.out.write(
          `${w.id === selected ? '*' : ' '} ${w.id}  ${w.role.padEnd(6)}  ${w.name}${flags ? `  ${flags}` : ''}` +
            `${org ? `  organization ${org}` : ''}\n`
        );
      }
      const chosenBy = !selection
        ? 'the server (nothing is selected; --org or --workspace selects one per command)'
        : selected === null
          ? `${describeSelection(selection)}; none is marked, the selection names none of these`
          : describeSelection(selection);
      io.out.write(
        `\n* = the workspace the commands run in, chosen by ${chosenBy}\n` +
          (me.workspaces.some((w) => w.default)
            ? '(default) = what a request naming no workspace resolves to\n'
            : '') +
          (anyOrg ? 'organization = the Antasphere id --org takes (or its name)\n' : '')
      );
    });

  const workspace = program
    .command('workspace')
    .description('Your default workspace: what the server uses when a command names none');

  workspace
    .command('default [workspace]')
    .description('Choose the workspace (id or name) the server uses when a command names none')
    .option('--clear', 'remove the choice (back to the workspace you joined first)', false)
    .action(async (value: string | undefined, opts: { clear: boolean }, cmd: Command) => {
      if ((value !== undefined) === opts.clear) {
        throw new CliUsageError('Pass exactly one of <workspace> (an id or a name) or --clear.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx, { workspace: false });
      const target = opts.clear ? null : matchWorkspace((await ctx.client.me()).workspaces, value!);
      try {
        await ctx.client.setDefaultWorkspace(target?.id ?? null);
      } catch (e) {
        if (e instanceof PlatformApiError && e.code === 'hub_managed') {
          const url = (e.details as { manageUrl?: unknown } | undefined)?.manageUrl;
          throw new CliApiRefusal(
            'Your default workspace is a setting of your Antasphere account' +
              (typeof url === 'string' && url ? `: choose it on ${url}` : '.') +
              '\nTo run one command elsewhere, pass --org <organization id or name>.',
            e.status
          );
        }
        if (e instanceof PlatformApiError && e.code === 'key_pinned') {
          throw new CliApiRefusal(
            'This key is pinned to one workspace and cannot change your default workspace. Use a key that is not pinned.',
            e.status
          );
        }
        throw e;
      }
      if (ctx.json) {
        return printJson(io, {
          defaultWorkspaceId: target?.id ?? null,
          ...(target ? { workspace: { id: target.id, name: target.name, role: target.role } } : {})
        });
      }
      io.out.write(
        target
          ? `"${target.name}" (${target.id}) is now your default workspace: a command naming none runs in it.\n`
          : 'No default workspace is chosen: a command naming none runs in the workspace you joined first.\n'
      );
      // A selection still wins over the server's default; say so rather than
      // let the next command land somewhere else in silence.
      const selection = ctx.workspaceSelection;
      if (selection && (!target || findWorkspace([target], selection.value).match === null)) {
        io.err.write(
          `Note: ${describeSelection(selection)} selects another workspace and wins over the default while it is set.\n`
        );
      }
    });
}
