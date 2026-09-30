import { PlatformApiError, type ChassisClient, type ClientOptions } from '@antasphere/chassis-sdk';
import type { Command } from 'commander';
import {
  activeHubProfile,
  CLOUD_PROFILE,
  CliUsageError,
  connectOnDemand,
  lookupConnectKey,
  printJson as corePrintJson,
  refreshConnectKey,
  resolveApiKey,
  resolveBaseUrl,
  sameInstance,
  selectProfile,
  type CliIo as CoreCliIo,
  type ConnectOnDemandOptions,
  type ProfileSource
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
 * A refusal of the API that a command turned into a sentence (the project
 * verbs do), thrown as the usage error it reads as, with the wire status
 * kept: the runner adds what only it knows, the workspace a 404 was asked of.
 */
export class CliApiRefusal extends CliUsageError {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'CliApiRefusal';
  }
}

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
  /**
   * The wait seam. The bin leaves it unset and the default is a timer; tests
   * inject a recorder, so a command that waits out a rate wall is tested
   * without the wait.
   */
  sleep?: (ms: number) => Promise<void>;
}

// ── Terminal-control sanitation ──────────────────────────────────────────────

/**
 * Strip terminal control sequences from human output.
 *
 * Almost everything the CLI prints in its human mode is content someone
 * ELSE wrote: annotation bodies and author names from a share-link
 * recipient, the titles of the tool's resources, form-response payloads, stored
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

/**
 * Where this invocation's credential came from, in the order it resolves:
 * the flag (or `--api-key-stdin`), the tool's key variable, the profile's own
 * key (the tool's login), the key the hub exchange cached on the profile, a
 * fresh hub exchange run by this very command, or nothing yet.
 */
export type CredentialSource = 'flag' | 'env' | 'profile' | 'hub-cache' | 'hub-exchange' | 'none';

export interface CliContext<TClient extends ChassisClient<string> = ChassisClient<string>> {
  client: TClient;
  baseUrl: string;
  apiKey: string | undefined;
  /** Where `apiKey` came from (`whoami` says it; the recovery reads it). */
  credentialSource: CredentialSource;
  json: boolean;
  io: CliIo;
  /**
   * The profile this run selected (cli-core `selectProfile`: --profile, the
   * instance URL, the active profile, the implicit `cloud` profile). Always
   * named on a tool with a cloud URL; `profileCreated` says it is not on
   * disk yet.
   */
  profileName: string | undefined;
  profileSource: ProfileSource | undefined;
  profileCreated: boolean;
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
  org?: string;
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
  /** The instance a profile names: its `baseUrl`, else the tool's cloud URL. */
  profileUrl(profile: CliProfile | undefined): string;
  /** The `connectOnDemand` options of one context (the tool, the instance, the profile, the wire). */
  connectOptions(ctx: CliContext<TClient>): ConnectOnDemandOptions;
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
  const unknownHint = `run \`${identity.bin} profiles\` to list them.`;

  /** The named (or active) profile, erroring on an explicitly named missing one. */
  function resolveProfile(
    config: CliConfig,
    requested: string | undefined
  ): { name: string | undefined; profile: CliProfile | undefined } {
    const { name, profile } = selectProfile({ config, requested, cloudUrl: identity.cloudUrl, unknownHint });
    return { name, profile };
  }

  function profileUrl(profile: CliProfile | undefined): string {
    return profile?.baseUrl ?? identity.cloudUrl;
  }

  /**
   * Backend + credential resolution, in its documented order:
   *
   *   profile:   --profile → the profile of --api-url / <PREFIX>_URL (made in
   *              memory, named for the host, when none is saved) → the active
   *              profile (`<bin> use`) → the implicit `cloud` profile
   *   base URL:  --api-url (or --url) → <PREFIX>_URL → profile baseUrl → the
   *              tool's cloud URL
   *   API key:   --api-key → <PREFIX>_API_KEY → profile apiKey
   *              → the hub-connect key cached on the profile (cloud instances)
   *   workspace: --org / --workspace → <PREFIX>_ORG / <PREFIX>_WORKSPACE
   *              → none (the server's default; workspace.ts)
   *
   * A profile is an instance (cli-core 0.5.0): a cached hub key is read only
   * when the profile names the instance this request goes to, so a key
   * minted for the cloud can never be sent to some other instance named by
   * --api-url / <PREFIX>_URL. A self-hosted CLI names its instance once, as a
   * profile; the cloud needs no flag at all.
   */
  function resolveContext(cmd: Command, io: CliIo): CliContext<TClient> {
    const opts = cmd.optsWithGlobals() as GlobalOpts;
    const config = loadConfig(io.env);
    const apiUrl = opts.apiUrl ?? opts.url ?? io.env[`${identity.envPrefix}_URL`];
    const selected = selectProfile({
      config,
      requested: opts.profile,
      apiUrl,
      cloudUrl: identity.cloudUrl,
      unknownHint
    });
    const { name: profileName, profile } = selected;

    const baseUrl = resolveBaseUrl({
      flag: apiUrl,
      env: io.env,
      envVar: `${identity.envPrefix}_URL`,
      profile,
      cloudUrl: identity.cloudUrl
    });
    // A profile's own key is sent only to the instance the profile names
    // (verifier round 1, F5): `--profile a --api-url <b>` must never hand
    // a's key to b, exactly as the connect cache below never does.
    const sameProfileInstance = sameInstance(profileUrl(profile), baseUrl);
    let apiKey = resolveApiKey({
      flag: opts.apiKey ?? stdinApiKeys.get(io),
      env: io.env,
      envVar: `${identity.envPrefix}_API_KEY`,
      profile: sameProfileInstance ? profile : undefined
    });
    let credentialSource: CredentialSource =
      opts.apiKey !== undefined || stdinApiKeys.get(io) !== undefined
        ? 'flag'
        : io.env[`${identity.envPrefix}_API_KEY`]
          ? 'env'
          : apiKey
            ? 'profile'
            : 'none';
    if (!apiKey && sameProfileInstance) {
      // No direct key: the connect cache's slot is the ACTIVE hub profile
      // (what `antasphere login` stored) — org-independent by design.
      const hub = activeHubProfile(io.env);
      if (hub.name) apiKey = lookupConnectKey(profile, hub.name);
      if (apiKey) credentialSource = 'hub-cache';
    }
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    const ctx: CliContext<TClient> = {
      client: createClient({ baseUrl, ...(apiKey ? { apiKey } : {}), fetch: fetchImpl }),
      baseUrl,
      apiKey,
      credentialSource,
      json: Boolean(opts.json),
      io,
      profileName,
      profileSource: selected.source,
      profileCreated: selected.created,
      config,
      workspaceSelection: pickWorkspaceSelection({
        workspaceFlag: opts.workspace,
        orgFlag: opts.org,
        env: io.env
      }),
      workspaceId: undefined
    };
    if (credentialSource === 'hub-cache' && apiKey) {
      // A cached key may have been revoked at the hub since it was minted
      // (a swept membership, a logout elsewhere): the client's fetch recovers
      // once, below, instead of stranding the person on a 401.
      ctx.client = createClient({ baseUrl, apiKey, fetch: recoveringFetch(ctx, fetchImpl) });
    }
    return ctx;
  }

  const NO_KEY_MESSAGE =
    `An API key is required. Sign in (\`${identity.bin} login\`), pass --api-key, or set ` +
    `${identity.envPrefix}_API_KEY.`;

  /** The tool's own copy for the cli-core seam: the one-command login is the remedy. */
  const MISSING_HUB_LOGIN_MESSAGE =
    `This ${identity.displayName} instance signs in through Antasphere. Run \`${identity.bin} login\` once ` +
    `(or \`antasphere login\`), then retry — or pass --api-key <${identity.keyPrefix}_…> / set ` +
    `${identity.envPrefix}_API_KEY.`;

  function connectOptions(ctx: CliContext<TClient>): ConnectOnDemandOptions {
    const { io } = ctx;
    return {
      tool: identity.tool,
      toolBaseUrl: ctx.baseUrl,
      // A profile with no baseUrl of its own is at the cloud URL (cli-core 0.5.0).
      cloudUrl: identity.cloudUrl,
      profileName: ctx.profileName ?? CLOUD_PROFILE,
      env: io.env,
      // Thread the injected fetch so the probe + exchange stay on the test
      // harness wire (and any proxying the runner set up).
      ...(io.fetch ? { fetch: io.fetch } : {}),
      notify: (line) => io.err.write(line),
      messages: { missingHubLogin: MISSING_HUB_LOGIN_MESSAGE }
    };
  }

  /**
   * The stranded-key recovery (PRDCT-2947): a fetch that, on the FIRST 401
   * answered to a key served from the connect cache, evicts that key, runs
   * the hub exchange again (cli-core `refreshConnectKey`) and replays the
   * request once with the new key. A second 401 stands. A hub refusal on the
   * way (a restricted tool, a swept account) is the hub's own sentence, exit
   * 3, through the runner. An instance that is no longer cloud recovers
   * nothing and the 401 stands as it is.
   */
  function recoveringFetch(ctx: CliContext<TClient>, base: typeof globalThis.fetch): typeof globalThis.fetch {
    let recovered = false;
    return async (input, init) => {
      const res = await base(input, init);
      if (res.status !== 401 || recovered || ctx.credentialSource !== 'hub-cache') return res;
      recovered = true;
      // A 401 under a workspace selection may be the SELECTION's refusal:
      // the server answers a workspace the person does not belong to exactly
      // like an unknown key (no oracle). Ask `/me` once without it; when the
      // key answers there, it is alive and nothing is evicted, exchanged or
      // replayed (verifier round 1, F2: a refused --org leaked a live key per
      // command). The runner then explains the refusal.
      if (ctx.workspaceId !== undefined && ctx.apiKey) {
        const probe = await base(`${ctx.baseUrl}/api/v1/me`, {
          headers: { authorization: `Bearer ${ctx.apiKey}` }
        }).catch(() => null);
        // Only a probe that ANSWERS 401 proves the key dead (verifier round 2,
        // F10): a probe with no answer, or any other status, keeps the key and
        // lets the 401 stand.
        if (!probe || probe.status !== 401) return res;
      }
      const outcome = await refreshConnectKey(connectOptions(ctx));
      if (outcome.outcome === 'not_cloud') return res;
      ctx.apiKey = outcome.key;
      ctx.credentialSource = 'hub-exchange';
      ctx.io.err.write('The cached key was refused; signed in again through Antasphere.\n');
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${outcome.key}`);
      return base(input, { ...init, headers });
    };
  }

  /**
   * Requires an API key; throws a friendly message the runner turns into exit 1.
   *
   * When nothing resolved, this is the connect-on-demand seam (binding
   * patterns §7, gcloud model), owned by @antasphere/cli-core since 0.3.0:
   * if — and only if — discovery says the instance is an Antasphere-cloud
   * one, the stored `antasphere login` credential is exchanged (hub → tool)
   * for a USER-scoped tool-local API key, which is cached on the selected
   * profile under the hub profile's name and used for this invocation — and
   * served from that cache on every subsequent run (no re-exchange, no fresh
   * mint). Self-hosted instances never take this branch: they get the
   * classic error unchanged.
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
   * applied and no command names it. An id is sent as it is (a workspace id
   * or a hub organization id: the server maps the latter and fails closed on
   * one that is not the person's, and `explainWorkspaceRefusal` says so); a
   * name costs one `/me` to find its id. `workspaces` and `workspace default`
   * pass `workspace: false`: they are how a person repairs a selection that
   * no longer works, so they must answer when it does not.
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
   * The hint for a 404 under a selection: a resource id (a linked folder's, a
   * pasted one) lives in ONE workspace, and the same id asked of another is
   * "not found" — true, and useless without the workspace that was asked.
   */
  function workspaceNotFoundHint(io: CliIo): string {
    const ctx = appliedContexts.get(io);
    if (!ctx?.workspaceSelection || ctx.workspaceId === undefined) return '';
    const { workspaceSelection: selection } = ctx;
    const noun = selection.kind === 'org' ? 'organization' : 'workspace';
    return ` (looked in the ${noun} "${selection.value}", selected by ${describeSelection(selection)})`;
  }

  async function connectForKey(ctx: CliContext<TClient>): Promise<string> {
    const { io } = ctx;
    const outcome = await connectOnDemand(connectOptions(ctx));
    if (outcome.outcome === 'not_cloud') {
      // Self-hosted / unreachable: the classic error, byte-identical.
      throw new CliUsageError(NO_KEY_MESSAGE);
    }

    // The minted key becomes this invocation's credential.
    ctx.apiKey = outcome.key;
    ctx.credentialSource = outcome.cached ? 'hub-cache' : 'hub-exchange';
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    ctx.client = createClient({
      baseUrl: ctx.baseUrl,
      apiKey: outcome.key,
      fetch: outcome.cached ? recoveringFetch(ctx, fetchImpl) : fetchImpl
    });
    return outcome.key;
  }

  return {
    resolveProfile,
    resolveContext,
    requireApiKey,
    workspaceSource,
    explainWorkspaceRefusal,
    workspaceNotFoundHint,
    profileUrl,
    connectOptions
  };
}

/**
 * `--all` for a cursor-paginated list: the first page, then every next page
 * while the server hands a cursor, the rows in order. The one loop behind
 * every `--all`; a server that repeats a cursor is stopped here, once.
 */
export async function drainPages<T>(
  first: { rows: T[]; nextCursor: string | null },
  fetchPage: (cursor: string) => Promise<{ rows: T[]; nextCursor: string | null }>
): Promise<T[]> {
  const rows = [...first.rows];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const page = await fetchPage(cursor);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  }
  return rows;
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
