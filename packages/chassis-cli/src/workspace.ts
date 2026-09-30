import { CliUsageError } from '@antasphere/cli-core';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import type { CliEnv } from './config.js';
import type { CliIdentity } from './identity.js';

/**
 * Which workspace a command runs in (PRDCT-2419, PRDCT-2947).
 *
 * A credential identifies a USER (ADR 014, ADR 019): the workspace is a
 * per-request `X-Workspace-Id`, and the SDK sends it once told which. There
 * is ONE organization notion in the tool family: the server's default
 * organization applies when a command names none, and a command may name
 * one of two ways:
 *
 *   --org <hub organization id or name>   or <PREFIX>_ORG
 *   --workspace <workspace id or name>    or <PREFIX>_WORKSPACE
 *
 * `--org` names the organization the Antasphere way (the id the account
 * site shows, or its name); the instance maps a hub organization id to its
 * own workspace through `central_account_id`. `--workspace` names a
 * workspace of this instance (a self-hosted instance has no hub ids). Both
 * at once is a usage error; a flag wins over its variable. Nothing is saved
 * on this machine: the default is the server's (`workspace default` on a
 * self-hosted instance, the Antasphere account on the cloud).
 *
 * A value that is a uuid is sent as it is (the server accepts a local id or a
 * hub organization id, and fails closed on one that is not the person's); a
 * name is looked up in `/me`'s `workspaces[]` first, by id, by hub
 * organization id, then by name. Pure functions only: the wiring (the client,
 * the header) lives in context.ts.
 */

/** `/me`'s answer, read off the client (the SDK does not export the type by name). */
export type MeResponse = Awaited<ReturnType<ChassisClient<string>['me']>>;
export type MeWorkspace = MeResponse['workspaces'][number];

/** Which flag or variable named the selection. */
export type SelectionKind = 'org' | 'workspace';

/** Where the workspace of this invocation came from; `default` = nothing selected. */
export type WorkspaceSource = 'flag' | 'env' | 'default';

export interface WorkspaceSelection {
  /** What the person wrote: an id or a name, trimmed. */
  value: string;
  source: Exclude<WorkspaceSource, 'default'>;
  /** `--org` / `<PREFIX>_ORG`, or `--workspace` / `<PREFIX>_WORKSPACE`. */
  kind: SelectionKind;
}

/** The server's own selector shape (resolve-membership.ts): anything else is a name. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: string): boolean {
  return UUID_RE.test(value);
}

/** The hub organization id of a listed workspace, when it projects one (an older server sends none). */
function orgIdOf(w: MeWorkspace): string | null {
  const id = (w as { centralAccountId?: unknown }).centralAccountId;
  return typeof id === 'string' && id ? id : null;
}

/** One line per workspace, for the error messages that list the candidates. */
export function workspaceLines(workspaces: readonly MeWorkspace[]): string {
  if (workspaces.length === 0) return '  (none)';
  return workspaces
    .map((w) => {
      const org = orgIdOf(w);
      return `  ${w.id}  ${w.role.padEnd(6)}  ${w.name}${org ? `  (organization ${org})` : ''}`;
    })
    .join('\n');
}

/**
 * The membership a value names, or null: the exact workspace id first, then
 * the exact hub organization id, else the ONE workspace whose name matches
 * without regard to case. `ambiguous` carries the several a name matched.
 */
export function findWorkspace(
  workspaces: readonly MeWorkspace[],
  value: string
): { match: MeWorkspace | null; ambiguous: MeWorkspace[] } {
  const wanted = value.trim().toLowerCase();
  const byId = workspaces.find((w) => w.id.toLowerCase() === wanted);
  if (byId) return { match: byId, ambiguous: [] };
  const byOrg = workspaces.find((w) => orgIdOf(w)?.toLowerCase() === wanted);
  if (byOrg) return { match: byOrg, ambiguous: [] };
  const byName = workspaces.filter((w) => w.name.trim().toLowerCase() === wanted);
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

/** The workspace functions that spell the tool: its environment variables, its binary. */
export interface CliWorkspace {
  WORKSPACE_ENV: string;
  ORG_ENV: string;
  pickWorkspaceSelection(input: {
    workspaceFlag: string | undefined;
    orgFlag: string | undefined;
    env: CliEnv;
  }): WorkspaceSelection | undefined;
  describeSelection(selection: Pick<WorkspaceSelection, 'source' | 'kind'>): string;
  describeSource(source: WorkspaceSource, kind: SelectionKind | undefined): string;
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
  const ORG_ENV = `${identity.envPrefix}_ORG`;

  /**
   * The selection of this invocation, or undefined when nothing selects one.
   *
   * An empty `--org` or `--workspace` is a usage error (somebody meant to
   * name one); an empty variable is an unset one (a CI variable that
   * expanded to nothing) and falls through. Two flags, or two variables, at
   * once is a usage error: one command runs in one place.
   */
  function pickWorkspaceSelection(input: {
    workspaceFlag: string | undefined;
    orgFlag: string | undefined;
    env: CliEnv;
  }): WorkspaceSelection | undefined {
    if (input.orgFlag !== undefined && input.workspaceFlag !== undefined) {
      throw new CliUsageError('Pass --org or --workspace, not both.');
    }
    if (input.orgFlag !== undefined) {
      const value = input.orgFlag.trim();
      if (!value) throw new CliUsageError('--org needs an organization id or name.');
      return { value, source: 'flag', kind: 'org' };
    }
    if (input.workspaceFlag !== undefined) {
      const value = input.workspaceFlag.trim();
      if (!value) throw new CliUsageError('--workspace needs a workspace id or name.');
      return { value, source: 'flag', kind: 'workspace' };
    }
    const org = input.env[ORG_ENV]?.trim();
    const workspace = input.env[WORKSPACE_ENV]?.trim();
    if (org && workspace) {
      throw new CliUsageError(`Set ${ORG_ENV} or ${WORKSPACE_ENV}, not both.`);
    }
    if (org) return { value: org, source: 'env', kind: 'org' };
    if (workspace) return { value: workspace, source: 'env', kind: 'workspace' };
    return undefined;
  }

  /** How a selection reads in a sentence: `the --org flag`, `<PREFIX>_WORKSPACE`. */
  function describeSelection(selection: Pick<WorkspaceSelection, 'source' | 'kind'>): string {
    if (selection.source === 'flag')
      return selection.kind === 'org' ? 'the --org flag' : 'the --workspace flag';
    return selection.kind === 'org' ? ORG_ENV : WORKSPACE_ENV;
  }

  /** The same, for `whoami`'s `chosen by` line. */
  function describeSource(source: WorkspaceSource, kind: SelectionKind | undefined): string {
    if (source === 'default' || kind === undefined) return "the server's default (nothing selected)";
    return describeSelection({ source, kind });
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
    const noun = selection.kind === 'org' ? 'organization' : 'workspace';
    const selected = findWorkspace(me.workspaces, input.workspaceId).match;
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
        `The ${noun} "${selection.value}" (selected by ${by}) is not one of yours on ${input.baseUrl}; ` +
        `the API key itself works. Yours:\n${workspaceLines(me.workspaces)}`
      );
    }
    return null;
  }

  return {
    WORKSPACE_ENV,
    ORG_ENV,
    pickWorkspaceSelection,
    describeSelection,
    describeSource,
    explainRefusal
  };
}
