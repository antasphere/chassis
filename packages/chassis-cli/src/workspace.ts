import { CliUsageError } from '@antasphere/cli-core';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import type { CliEnv, CliProfile } from './config.js';
import type { CliIdentity } from './identity.js';

/**
 * Which workspace a command runs in (PRDCT-2419).
 *
 * A credential identifies a USER (ADR 014, ADR 019): the workspace is a
 * per-request `X-Workspace-Id`, and the SDK sends it once told which. This
 * module decides which, in its documented order:
 *
 *   workspace: --workspace → <PREFIX>_WORKSPACE → profile activeWorkspaceId
 *              → nothing sent (the server's default membership)
 *
 * A value is a workspace id of the instance (the LOCAL id `/me` lists, never a hub
 * org id) or a workspace name. An id is sent as it is; a name is looked up
 * in `/me`'s `workspaces[]` first. Pure functions only: the wiring (the
 * client, the profile write) lives in context.ts and commands/workspaces.ts.
 */

/** `/me`'s answer, read off the client (the SDK does not export the type by name). */
export type MeResponse = Awaited<ReturnType<ChassisClient<string>['me']>>;
export type MeWorkspace = MeResponse['workspaces'][number];

/** Where the workspace of this invocation came from; `default` = nothing selected. */
export type WorkspaceSource = 'flag' | 'env' | 'profile' | 'default';

export interface WorkspaceSelection {
  /** What the person wrote: an id or a name, trimmed. */
  value: string;
  source: Exclude<WorkspaceSource, 'default'>;
  /** The profile the value was read from, when `source` is `profile`. */
  profileName?: string;
}

/** The server's own selector shape (resolve-membership.ts): anything else is a name. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: string): boolean {
  return UUID_RE.test(value);
}

const stripSlashes = (url: string): string => url.replace(/\/+$/, '');

/** One line per workspace, for the error messages that list the candidates. */
export function workspaceLines(workspaces: readonly MeWorkspace[]): string {
  if (workspaces.length === 0) return '  (none)';
  return workspaces.map((w) => `  ${w.id}  ${w.role.padEnd(6)}  ${w.name}`).join('\n');
}

/**
 * The membership a value names, or null: the exact id first, else the ONE
 * workspace whose name matches without regard to case. `ambiguous` carries
 * the several a name matched.
 */
export function findWorkspace(
  workspaces: readonly MeWorkspace[],
  value: string
): { match: MeWorkspace | null; ambiguous: MeWorkspace[] } {
  const wanted = value.trim();
  const byId = workspaces.find((w) => w.id.toLowerCase() === wanted.toLowerCase());
  if (byId) return { match: byId, ambiguous: [] };
  const byName = workspaces.filter((w) => w.name.trim().toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { match: byName[0]!, ambiguous: [] };
  return { match: null, ambiguous: byName };
}

/** `findWorkspace`, erroring with the candidates on an unknown or ambiguous value. */
export function matchWorkspace(workspaces: readonly MeWorkspace[], value: string): MeWorkspace {
  const { match, ambiguous } = findWorkspace(workspaces, value);
  if (match) return match;
  if (ambiguous.length > 1) {
    throw new CliUsageError(
      `Several of your workspaces are named "${value}". Name one by its id:\n${workspaceLines(ambiguous)}`
    );
  }
  throw new CliUsageError(`"${value}" is not one of your workspaces. Yours:\n${workspaceLines(workspaces)}`);
}

/** The workspace functions that spell the tool: its environment variable, its binary. */
export interface CliWorkspace {
  WORKSPACE_ENV: string;
  pickWorkspaceSelection(input: {
    flag: string | undefined;
    env: CliEnv;
    profile: CliProfile | undefined;
    profileName: string | undefined;
    baseUrl: string;
  }): WorkspaceSelection | undefined;
  describeSelection(selection: Pick<WorkspaceSelection, 'source' | 'profileName'>): string;
  describeSource(source: WorkspaceSource, profileName: string | undefined): string;
  explainRefusal(input: {
    code: string;
    status: number;
    selection: WorkspaceSelection;
    workspaceId: string;
    me: MeResponse;
    baseUrl: string;
  }): string | null;
}

export function createWorkspace(identity: CliIdentity): CliWorkspace {
  const WORKSPACE_ENV = `${identity.envPrefix}_WORKSPACE`;

  /**
   * The selection of this invocation, or undefined when nothing selects one.
   *
   * An empty `--workspace` is a usage error (somebody meant to name one); an
   * empty <PREFIX>_WORKSPACE is an unset one (a CI variable that expanded to
   * nothing) and falls through. The profile field counts only when the profile
   * names the instance this request goes to: a workspace id means nothing on
   * another instance — the same rule that scopes the cached hub-connect key.
   */
  function pickWorkspaceSelection(input: {
    flag: string | undefined;
    env: CliEnv;
    profile: CliProfile | undefined;
    profileName: string | undefined;
    baseUrl: string;
  }): WorkspaceSelection | undefined {
    if (input.flag !== undefined) {
      const value = input.flag.trim();
      if (!value) throw new CliUsageError('--workspace needs a workspace id or name.');
      return { value, source: 'flag' };
    }
    const fromEnv = input.env[WORKSPACE_ENV]?.trim();
    if (fromEnv) return { value: fromEnv, source: 'env' };

    const saved = input.profile?.activeWorkspaceId;
    const profileUrl = input.profile?.baseUrl;
    if (
      typeof saved === 'string' &&
      saved.trim() &&
      profileUrl !== undefined &&
      stripSlashes(profileUrl) === stripSlashes(input.baseUrl)
    ) {
      return {
        value: saved.trim(),
        source: 'profile',
        ...(input.profileName !== undefined ? { profileName: input.profileName } : {})
      };
    }
    return undefined;
  }

  /** How a selection reads in a sentence: `the --workspace flag`, `profile "work"`. */
  function describeSelection(selection: Pick<WorkspaceSelection, 'source' | 'profileName'>): string {
    if (selection.source === 'flag') return 'the --workspace flag';
    if (selection.source === 'env') return WORKSPACE_ENV;
    return selection.profileName !== undefined ? `profile "${selection.profileName}"` : 'the profile';
  }

  /** The same, for `whoami`'s `chosen by` line. */
  function describeSource(source: WorkspaceSource, profileName: string | undefined): string {
    if (source === 'default') return "the server's default (nothing selected)";
    return describeSelection({ source, ...(profileName !== undefined ? { profileName } : {}) });
  }

  /**
   * What a refused request really meant, once `/me` answered WITHOUT the
   * selection (so the key itself is good). Two refusals are the selection's:
   *
   *  - 403 `workspace_mismatch`: the key is pinned, and a selector-less `/me`
   *    always resolves a pinned key to its pin — so `me.workspace` IS the pin.
   *  - 401 `invalid_api_key`: the server answers a workspace the person does
   *    not belong to exactly like an unknown key (no oracle, resolve-
   *    membership.ts), which alone would send the person to check a good key.
   *
   * null = the selection does not explain it; the caller prints the plain error.
   */
  function explainRefusal(input: {
    code: string;
    status: number;
    selection: WorkspaceSelection;
    workspaceId: string;
    me: MeResponse;
    baseUrl: string;
  }): string | null {
    const { selection, me } = input;
    const by = describeSelection(selection);
    const selected = me.workspaces.find((w) => w.id.toLowerCase() === input.workspaceId.toLowerCase());
    if (input.code === 'workspace_mismatch' && input.status === 403) {
      const pin = me.workspace ? `"${me.workspace.name}" (${me.workspace.id})` : 'another workspace';
      const asked = selected ? `"${selected.name}" (${selected.id})` : `"${selection.value}"`;
      return (
        `This API key is pinned to the workspace ${pin}, and ${by} selects ${asked}. ` +
        'A pinned key only ever acts in its own workspace: drop the selection, or use a key that is not pinned.'
      );
    }
    if (input.code === 'invalid_api_key' && input.status === 401 && !selected) {
      return (
        `The workspace "${selection.value}" (selected by ${by}) is not one of yours on ${input.baseUrl}; ` +
        `the API key itself works. Yours:\n${workspaceLines(me.workspaces)}` +
        (selection.source === 'profile'
          ? `\nRun \`${identity.bin} workspace use --clear\` to drop the saved selection.`
          : '')
      );
    }
    return null;
  }

  return { WORKSPACE_ENV, pickWorkspaceSelection, describeSelection, describeSource, explainRefusal };
}
