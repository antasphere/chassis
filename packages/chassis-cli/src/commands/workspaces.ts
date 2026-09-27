import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import { CliApiRefusal, CliUsageError, printJson, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';
import { findWorkspace, matchWorkspace } from '../workspace.js';

/**
 * Which workspace the commands run in (PRDCT-2419): `workspaces` lists the
 * memberships, `workspace use` saves a selection on the profile. The shape
 * mirrors the hub CLI's `org list` / `org use`.
 *
 * Both talk to `/me` WITHOUT the selection (`workspace: false`): they are the
 * commands a person repairs a stale selection with, so a selection the
 * server refuses must never stop them. There is deliberately no
 * `workspaces create`: `POST /workspaces` is a session-only act.
 *
 * `workspace default` (PRDCT-2815) is the other half: not what THIS profile
 * runs in, but what the SERVER resolves for the person when a request names
 * no workspace, for every credential of theirs. Set here on a self-hosted
 * instance; on the cloud it is a setting of the Antasphere account, and the
 * refusal names the page.
 */

const stripSlashes = (url: string): string => url.replace(/\/+$/, '');

export function registerWorkspaceCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { identity, loadConfig, requireApiKey, resolveContext, saveConfig, workspaceSource } = kit;
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
            'workspaces, so commands that use it are refused.' +
            (selection.source === 'profile'
              ? ` Drop it with \`${identity.bin} workspace use --clear\`.`
              : '') +
            '\n'
        );
      }
      if (ctx.json) {
        return printJson(io, { workspaces: me.workspaces, selectedWorkspaceId: selected, source });
      }
      if (me.workspaces.length === 0) {
        io.out.write('No workspaces.\n');
        return;
      }
      for (const w of me.workspaces) {
        const flags = [w.default ? '(default)' : null, w.suspended ? '[suspended]' : null]
          .filter(Boolean)
          .join(' ');
        io.out.write(
          `${w.id === selected ? '*' : ' '} ${w.id}  ${w.role.padEnd(6)}  ${w.name}${flags ? `  ${flags}` : ''}\n`
        );
      }
      const chosenBy = !selection
        ? 'the server (nothing is selected; `workspace use` selects one)'
        : selected === null
          ? `${describeSelection(selection)}; none is marked, the selection names none of these`
          : describeSelection(selection);
      io.out.write(
        `\n* = the workspace the commands run in, chosen by ${chosenBy}\n` +
          '(default) = what a request naming no workspace resolves to\n'
      );
    });

  const workspace = program.command('workspace').description('Select the workspace the commands run in');

  workspace
    .command('use [workspace]')
    .description('Save a workspace (id or name) on the profile; every later command runs in it')
    .option('--clear', 'remove the saved selection (back to the server default)', false)
    .action(async (value: string | undefined, opts: { clear: boolean }, cmd: Command) => {
      if ((value !== undefined) === opts.clear) {
        throw new CliUsageError('Pass exactly one of <workspace> (an id or a name) or --clear.');
      }
      const ctx = resolveContext(cmd, io);
      const profileName = ctx.profileName;
      if (profileName === undefined || !ctx.config.profiles[profileName]) {
        throw new CliUsageError(
          `No profile to save the selection on. Sign in first (\`${identity.bin} login\`), or select per ` +
            `command with --workspace / ${identity.envPrefix}_WORKSPACE.`
        );
      }

      if (opts.clear) {
        const config = loadConfig(io.env);
        const profile = config.profiles[profileName];
        if (profile) {
          delete profile.activeWorkspaceId;
          saveConfig(io.env, config);
        }
        if (ctx.json) return printJson(io, { profile: profileName, activeWorkspaceId: null });
        io.out.write(`Profile "${profileName}" selects no workspace; commands run in the server default.\n`);
        return;
      }

      // The id is the INSTANCE's: saving one looked up on another instance
      // than the profile's would select nothing the profile can reach.
      const profileUrl = ctx.config.profiles[profileName]!.baseUrl;
      if (profileUrl === undefined || stripSlashes(profileUrl) !== ctx.baseUrl) {
        throw new CliUsageError(
          `Profile "${profileName}" points at ${profileUrl ?? '(no instance)'}, and this command ran against ` +
            `${ctx.baseUrl}. A workspace belongs to one instance: drop --api-url / ${identity.envPrefix}_URL, or pick the ` +
            'profile of that instance with --profile.'
        );
      }
      await requireApiKey(ctx, { workspace: false });
      const me = await ctx.client.me();
      const target = matchWorkspace(me.workspaces, value!);

      // cli-core's `setActiveWorkspace` is hardcoded to the hub tool, so the
      // tool profile's field is written here (TEMPLATE-FEEDBACK.md). Re-load:
      // connect-on-demand may have cached a key on the profile meanwhile.
      const config = loadConfig(io.env);
      config.profiles[profileName] = { ...config.profiles[profileName], activeWorkspaceId: target.id };
      saveConfig(io.env, config);

      if (ctx.json) {
        return printJson(io, {
          profile: profileName,
          activeWorkspaceId: target.id,
          workspace: { id: target.id, name: target.name, role: target.role }
        });
      }
      io.out.write(
        `Profile "${profileName}" now runs in "${target.name}" (${target.id}).` +
          (target.suspended ? ' This workspace is suspended: requests into it are refused.' : '') +
          '\n'
      );
      // The environment variable still wins over the one just saved; say so
      // rather than let the next command land somewhere else in silence.
      const louder = ctx.workspaceSelection;
      if (louder?.source === 'env') {
        io.err.write(`Note: ${describeSelection(louder)} is set and wins over the profile while it is.\n`);
      }
    });
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
              `\nTo choose where this profile runs, use \`${identity.bin} workspace use\`.`,
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
