import { PlatformApiError, type ChassisClient, type ClientOptions } from '@antasphere/chassis-sdk';
import type { Command } from 'commander';
import {
  activeHubProfile,
  CliUsageError,
  connectOnDemand,
  lookupConnectKey,
  printJson as corePrintJson,
  resolveApiKey,
  resolveBaseUrl,
  resolveProfile as coreResolveProfile,
  type CliIo as CoreCliIo,
  type ResolvedProfile
} from '@antasphere/cli-core';
import type { CliConfig, CliConfigStore, CliProfile } from './config.js';
import type { CliIdentity } from './identity.js';
import {
  isWorkspaceId,
  matchWorkspace,
  type CliWorkspace,
  type WorkspaceSelection,
  type WorkspaceSource
} from './workspace.js';

// The injectable I/O seam, the usage-error class, and the resolution
// helpers live in @antasphere/cli-core (extracted from this CLI); re-exported
// so the command modules' imports stay unchanged.
export { CliUsageError } from '@antasphere/cli-core';

/**
 * The tool's I/O seam: cli-core's, plus an injectable stdin reader so the
 * `--*-stdin` secret flags (stdin.ts) stay testable in-process. The bin
 * leaves it unset and the default reads `process.stdin`.
 */
export interface CliIo extends CoreCliIo {
  readStdin?: () => Promise<string>;
  /**
   * `process.stdout` carries `isTTY`; a pipe does not. The only signal the
   * CLI reads before opening a browser unasked (open.ts): a piped run is a
   * script or an agent, and a browser popping up on a build agent is a bug.
   */
  out: CoreCliIo['out'] & { isTTY?: boolean };
  /**
   * The browser opener seam. The bin leaves it unset and the default spawns
   * the platform command (open.ts); tests inject a recorder.
   */
  openUrl?: (url: string) => void;
}

// ── Terminal-control sanitation ──────────────────────────────────────────────

/**
 * Strip terminal control sequences from human output.
 *
 * Almost everything the CLI prints in its human mode is content someone
 * ELSE wrote: annotation bodies and author names from a share-link
 * recipient, deck and share-token titles, form-response payloads, stored
 * filenames, and server error messages. A terminal renders ANSI escapes in
 * all of it — colours and cursor moves are the mild end; OSC 8 hyperlinks
 * hide a URL behind friendly text, OSC 52 writes the user's clipboard, and
 * a CSI sequence can scrub the line above so the owner never sees what the
 * command really did.
 *
 * So the human sinks are wrapped (`ttySafeIo`) and everything they print
 * loses C0 (except tab / LF / CR, which the tables and the CSV need), the
 * 8-bit C1 introducers, and complete CSI/OSC/two-character escapes. `--json`
 * output deliberately bypasses this: it is data, not display, and
 * `JSON.stringify` already escapes every C0 byte.
 */
export function sanitizeForTty(s: string): string {
  /* eslint-disable no-control-regex -- matching control characters IS the job here. */
  return (
    s
      // OSC: ESC ] … terminated by BEL, ST (ESC \\) or the end of the string.
      .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, '')
      // CSI: ESC [ params intermediates final.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // Any other two-character escape (charset switches, RIS, …).
      .replace(/\u001b[@-Z\\-_]/g, '')
      // Whatever is left: stray C0 (ESC included), DEL, and the 8-bit C1
      // block whose 0x9b / 0x9d are CSI / OSC on their own. Tab (0x09),
      // LF (0x0a) and CR (0x0d) survive — tables and CSV are built of them.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  );
  /* eslint-enable no-control-regex */
}

/** Raw sink behind a sanitizing one, so `--json` can still print verbatim. */
const rawSinks = new WeakMap<CliIo, CliIo>();

/** Wrap an io so every human write is sanitized (see sanitizeForTty). */
export function ttySafeIo(io: CliIo): CliIo {
  const safe: CliIo = {
    ...io,
    // `isTTY` rides along: the open decision reads it through the wrapper.
    out: {
      write: (s: string) => io.out.write(sanitizeForTty(s)),
      ...(io.out.isTTY !== undefined ? { isTTY: io.out.isTTY } : {})
    },
    err: { write: (s: string) => io.err.write(sanitizeForTty(s)) }
  };
  rawSinks.set(safe, io);
  return safe;
}

/**
 * The `--api-key-stdin` value, parked against this invocation's io because
 * `resolveContext` is synchronous and cannot read stdin itself.
 */
const stdinApiKeys = new WeakMap<CliIo, string>();

export function setStdinApiKey(io: CliIo, key: string): void {
  stdinApiKeys.set(io, key);
}

/** The key `--api-key-stdin` already read, if any. */
export function stdinApiKey(io: CliIo): string | undefined {
  return stdinApiKeys.get(io);
}

/**
 * `--json` output goes to the RAW sink: machine output must stay
 * byte-exact, and JSON.stringify already escapes the C0 range.
 */
export function printJson(io: CliIo, value: unknown): void {
  corePrintJson(rawSinks.get(io) ?? io, value);
}

export interface CliContext<TClient extends ChassisClient<string> = ChassisClient<string>> {
  client: TClient;
  baseUrl: string;
  apiKey: string | undefined;
  json: boolean;
  io: CliIo;
  /** The profile the context resolved against (undefined = flags/env only). */
  profileName: string | undefined;
  config: CliConfig;
  /**
   * What selects the workspace (workspace.ts), undefined = the server's
   * default. Resolved here, APPLIED by `requireApiKey`: a name needs `/me`,
   * and `resolveContext` is synchronous.
   */
  workspaceSelection: WorkspaceSelection | undefined;
  /** The id `requireApiKey` put on the client; undefined until then, or with no selection. */
  workspaceId: string | undefined;
}

interface GlobalOpts {
  apiUrl?: string;
  url?: string;
  apiKey?: string;
  profile?: string;
  workspace?: string;
  json?: boolean;
}

/** The context whose selection reached the wire, for the runner's error path. */
const appliedContexts = new WeakMap<CliIo, CliContext>();

/** What `createContext` hands back: the context functions of ONE tool. */
export interface CliContextKit<TClient extends ChassisClient<string>> {
  resolveProfile(
    config: CliConfig,
    requested: string | undefined
  ): { name: string | undefined; profile: CliProfile | undefined };
  resolveContext(cmd: Command, io: CliIo): CliContext<TClient>;
  requireApiKey(ctx: CliContext<TClient>, opts?: { workspace?: boolean }): Promise<string>;
  workspaceSource(ctx: CliContext<TClient>): WorkspaceSource;
  explainWorkspaceRefusal(io: CliIo, e: unknown): Promise<string | null>;
  workspaceNotFoundHint(io: CliIo): string;
}

/**
 * The context functions, bound to one tool: its identity (identity.ts), the
 * client it talks through, and the config and workspace functions already
 * bound to the same identity.
 */
export function createContext<TClient extends ChassisClient<string>>(input: {
  identity: CliIdentity;
  createClient: (options: ClientOptions) => TClient;
  config: Pick<CliConfigStore, 'loadConfig'>;
  workspace: CliWorkspace;
}): CliContextKit<TClient> {
  const { identity, createClient } = input;
  const { loadConfig } = input.config;
  const { describeSelection, explainRefusal, pickWorkspaceSelection } = input.workspace;

  /** The named (or active) profile, erroring on an explicitly named missing one. */
  function resolveProfile(
    config: CliConfig,
    requested: string | undefined
  ): { name: string | undefined; profile: CliProfile | undefined } {
    const resolved: ResolvedProfile = coreResolveProfile(config, requested, {
      unknownHint: `run \`${identity.bin} profiles\` to list them.`
    });
    return resolved;
  }

  /**
   * Backend + credential resolution, in its documented order:
   *
   *   base URL:  --api-url (or --url) → <PREFIX>_URL → profile baseUrl → error
   *   API key:   --api-key            → <PREFIX>_API_KEY → profile apiKey
   *              → cached hub-connect key (cloud instances)
   *   workspace: --workspace          → <PREFIX>_WORKSPACE → profile
   *              activeWorkspaceId → none (the server's default; workspace.ts)
   *
   * There is deliberately NO hard-coded default URL: a self-hosted CLI must
   * name its instance explicitly (flag, env, or a saved profile) rather than
   * silently talking to the wrong host.
   *
   * The last credential step is the cross-tool connect cache (cli-core
   * binding patterns §7): purely additive — it is consulted only when every
   * direct source came up empty, so oss / single-key flows resolve exactly
   * as before and never read the hub profile. The cached key is USER-scoped
   * (one per hub profile, valid for every org — the org is a per-request
   * selection, never part of the credential) and is only replayed against
   * the instance it was minted on — the profile's baseUrl scopes the cache,
   * so a key minted for the cloud can never be sent to some other instance
   * named by --api-url / <PREFIX>_URL.
   */
  function resolveContext(cmd: Command, io: CliIo): CliContext<TClient> {
    const opts = cmd.optsWithGlobals() as GlobalOpts;
    const config = loadConfig(io.env);
    const { name: profileName, profile } = resolveProfile(config, opts.profile);

    const baseUrl = resolveBaseUrl({
      flag: opts.apiUrl ?? opts.url,
      env: io.env,
      envVar: `${identity.envPrefix}_URL`,
      profile,
      missingMessage:
        `No instance configured. Pass --api-url <url>, set ${identity.envPrefix}_URL, or sign in once with ` +
        `\`${identity.bin} auth login-request --api-url <url> --email <you>\` to save a profile.`
    });
    let apiKey = resolveApiKey({
      flag: opts.apiKey ?? stdinApiKeys.get(io),
      env: io.env,
      envVar: `${identity.envPrefix}_API_KEY`,
      profile
    });
    if (!apiKey && profile?.baseUrl?.replace(/\/+$/, '') === baseUrl) {
      // No direct key: the connect cache's slot is the ACTIVE hub profile
      // (what `antasphere login` stored) — org-independent by design.
      const hub = activeHubProfile(io.env);
      if (hub.name) apiKey = lookupConnectKey(profile, hub.name);
    }
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    return {
      client: createClient({ baseUrl, ...(apiKey ? { apiKey } : {}), fetch: fetchImpl }),
      baseUrl,
      apiKey,
      json: Boolean(opts.json),
      io,
      profileName,
      config,
      workspaceSelection: pickWorkspaceSelection({
        flag: opts.workspace,
        env: io.env,
        profile,
        profileName,
        baseUrl
      }),
      workspaceId: undefined
    };
  }

  const NO_KEY_MESSAGE =
    `An API key is required. Sign in (\`${identity.bin} auth login-request --email <you>\`), paste one ` +
    `(\`${identity.bin} login\`), pass --api-key, or set ${identity.envPrefix}_API_KEY.`;

  /** The tool's own copy for the cli-core seam (byte-identical to the
   *  pre-extraction string — the default lacks the `<prefix_…>` key hint). */
  const MISSING_HUB_LOGIN_MESSAGE =
    `This ${identity.displayName} instance signs in through the Antasphere hub. Run \`antasphere login\` once, ` +
    `then retry — or pass --api-key <${identity.keyPrefix}_…> / set ${identity.envPrefix}_API_KEY.`;

  /**
   * Requires an API key; throws a friendly message the runner turns into exit 1.
   *
   * When nothing resolved, this is the connect-on-demand seam (binding
   * patterns §7, gcloud model), owned by @antasphere/cli-core since 0.3.0:
   * if — and only if — discovery says the instance is an Antasphere-cloud
   * one, the stored `antasphere login` credential is exchanged (hub → tool)
   * for a USER-scoped tool-local API key, which is cached per (tool, hub
   * profile) and used for this invocation — and served from that cache on
   * every subsequent run (no re-exchange, no fresh mint). Self-hosted
   * instances never take this branch: they get the classic error unchanged.
   */
  async function requireApiKey(
    ctx: CliContext<TClient>,
    opts: { workspace?: boolean } = {}
  ): Promise<string> {
    const key = ctx.apiKey ?? (await connectForKey(ctx));
    if (opts.workspace !== false) await applyWorkspace(ctx);
    return key;
  }

  /**
   * Put the selected workspace on the client (PRDCT-2419). Every signed-in
   * command calls `requireApiKey`, so this is the one place the selection is
   * applied and no command names it. An id is sent as it is — the server fails
   * closed on one that is not the person's, and `explainWorkspaceRefusal` says
   * so; a name costs one `/me` to find its id. `workspaces` and `workspace use`
   * pass `workspace: false`: they are how a person repairs a selection that no
   * longer works, so they must answer when it does not.
   */
  async function applyWorkspace(ctx: CliContext<TClient>): Promise<void> {
    const selection = ctx.workspaceSelection;
    if (!selection || ctx.workspaceId !== undefined) return;
    const id = isWorkspaceId(selection.value)
      ? selection.value
      : matchWorkspace((await ctx.client.me()).workspaces, selection.value).id;
    ctx.client.setWorkspace(id);
    ctx.workspaceId = id;
    appliedContexts.set(ctx.io, ctx);
  }

  /** How the workspace of this invocation was chosen (`whoami`). */
  function workspaceSource(ctx: CliContext<TClient>): WorkspaceSource {
    return ctx.workspaceSelection?.source ?? 'default';
  }

  /**
   * The sentence for a refusal the SELECTION caused, or null (workspace.ts
   * `explainRefusal`). Asks `/me` once WITHOUT the selection: when that
   * answers, the key is good and the workspace is what was refused. Any
   * failure of the probe means the plain error is the honest one.
   */
  async function explainWorkspaceRefusal(io: CliIo, e: unknown): Promise<string | null> {
    const ctx = appliedContexts.get(io);
    if (!ctx?.workspaceSelection || ctx.workspaceId === undefined || !ctx.apiKey) return null;
    if (!(e instanceof PlatformApiError)) return null;
    if (e.code !== 'workspace_mismatch' && e.code !== 'invalid_api_key') return null;
    try {
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const me = await createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, fetch: fetchImpl }).me();
      return explainRefusal({
        code: e.code,
        status: e.status,
        selection: ctx.workspaceSelection,
        workspaceId: ctx.workspaceId,
        me,
        baseUrl: ctx.baseUrl
      });
    } catch {
      return null;
    }
  }

  /**
   * The hint for a 404 under a selection: a deck id (a linked folder's, a
   * pasted one) lives in ONE workspace, and the same id asked of another is
   * "not found" — true, and useless without the workspace that was asked.
   */
  function workspaceNotFoundHint(io: CliIo): string {
    const ctx = appliedContexts.get(io);
    if (!ctx?.workspaceSelection || ctx.workspaceId === undefined) return '';
    const { workspaceSelection: selection } = ctx;
    return ` (looked in the workspace "${selection.value}", selected by ${describeSelection(selection)})`;
  }

  async function connectForKey(ctx: CliContext<TClient>): Promise<string> {
    const { io } = ctx;
    const outcome = await connectOnDemand({
      tool: identity.tool,
      toolBaseUrl: ctx.baseUrl,
      ...(ctx.profileName !== undefined ? { profileName: ctx.profileName } : {}),
      env: io.env,
      // Thread the injected fetch so the probe + exchange stay on the test
      // harness wire (and any proxying the runner set up).
      ...(io.fetch ? { fetch: io.fetch } : {}),
      notify: (line) => io.err.write(line),
      messages: { missingHubLogin: MISSING_HUB_LOGIN_MESSAGE }
    });
    if (outcome.outcome === 'not_cloud') {
      // Self-hosted / unreachable: the classic error, byte-identical.
      throw new CliUsageError(NO_KEY_MESSAGE);
    }

    // The minted key becomes this invocation's credential.
    ctx.apiKey = outcome.key;
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    ctx.client = createClient({ baseUrl: ctx.baseUrl, apiKey: outcome.key, fetch: fetchImpl });
    return outcome.key;
  }

  return {
    resolveProfile,
    resolveContext,
    requireApiKey,
    workspaceSource,
    explainWorkspaceRefusal,
    workspaceNotFoundHint
  };
}

/** Human-readable size (B / KB / MB) for the listing commands. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Minimal aligned two-space table for human output. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const first = rows[0]!;
  const widths = first.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return (
    rows
      .map((r) =>
        r
          .map((cell, i) => (i === r.length - 1 ? cell : (cell ?? '').padEnd(widths[i] ?? 0)))
          .join('  ')
          .trimEnd()
      )
      .join('\n') + '\n'
  );
}
