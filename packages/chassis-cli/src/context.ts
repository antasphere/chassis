import { PlatformApiError, type ChassisClient, type ClientOptions } from '@antasphere/chassis-sdk';
import type { Command } from 'commander';
import {
  CLOUD_PROFILE,
  CliAuthClient,
  CliAuthError,
  CliUsageError,
  connectOnDemand,
  firstSet,
  forgetKeys,
  keysOfProfile,
  normalizeUrl,
  printJson as corePrintJson,
  refreshConnectKey,
  resolveBaseUrl,
  sameInstance,
  selectProfile,
  type CliIo as CoreCliIo,
  type ConnectOnDemandOptions,
  type ConnectOnDemandOutcome,
  type ProfileSource
} from '@antasphere/cli-core';
import type { CliConfig, CliConfigStore, CliProfile } from './config.js';
import { DEFAULT_HUB_URL, type CliIdentity } from './identity.js';
import { planFor } from './listing.js';
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
  /**
   * The machine's name, as `profiles` says which machine answers. The bin
   * leaves it unset and the default is `os.hostname()`; tests pin it.
   */
  hostname?: () => string;
  /**
   * The limit of each request `profiles --check` and `profiles add` send (the
   * discovery read, `--check`'s `/me`), in milliseconds: past it the request
   * is aborted, and counts as no answer. The bin leaves it unset and the
   * default is 10 000; tests shorten it. Nothing else in the kit reads it.
   */
  requestTimeoutMs?: number;
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

// ── What one run met on the wire ─────────────────────────────────────────────

/**
 * What the runner learns of one invocation, for the two sentences only it
 * can say (program.ts): the context the command resolved, whether a request
 * carrying the profile's OWN key was answered 401, and the requests that
 * could not connect at all (the error each threw, and the origin it was sent
 * to). Keyed by the run's io: `beginRun` makes it, `resolveContext` fills it.
 */
interface RunState {
  ctx: CliContext | undefined;
  ownKeyRefused: boolean;
  failures: WeakMap<object, string>;
  lastFailure: { error: object; origin: string } | undefined;
}

const runs = new WeakMap<CliIo, RunState>();

/** The settle of a profile that serves its own key, made once per run before its first request (`ownKeyFetch`). */
const ownKeySettles = new WeakMap<CliIo, Promise<void>>();

/** The origin of a URL, or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A system error's `code` (`ECONNREFUSED`, …), when it carries one. */
function codeOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether a fetch rejection means nothing answered: the fetch's TypeError, or a refused or unknown host. */
function cannotConnect(e: unknown): e is object {
  if (e instanceof TypeError) return true;
  const code = codeOf(e) ?? codeOf((e as { cause?: unknown } | null)?.cause);
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND';
}

/**
 * The io one invocation runs on (the runner calls it once): every human sink
 * sanitized (`ttySafeIo`), and a fetch that remembers each request that could
 * not connect, so the runner can name the profile whose site does not answer
 * (PRDCT-3060) instead of printing the bare network error.
 */
export function beginRun(rawIo: CliIo): CliIo {
  const state: RunState = {
    ctx: undefined,
    ownKeyRefused: false,
    failures: new WeakMap(),
    lastFailure: undefined
  };
  const base = rawIo.fetch ?? globalThis.fetch.bind(globalThis);
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await base(input, init);
    } catch (e) {
      if (cannotConnect(e)) {
        const origin = originOf(input instanceof Request ? input.url : input.toString()) ?? '';
        state.failures.set(e, origin);
        state.lastFailure = { error: e, origin };
      }
      throw e;
    }
  }) as typeof globalThis.fetch;
  const io = ttySafeIo({ ...rawIo, fetch: recording });
  runs.set(io, state);
  return io;
}

/** Whether a site is at a loopback or private address (where a leftover profile is a dead dev server). */
export function isLocalSite(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip) return false;
  const [a, b, c, d] = ip.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ── A key another profile holds ──────────────────────────────────────────────

/**
 * The keys every OTHER profile on disk holds (verifier round 3, F4): cli-core's
 * `keysOfProfile` over the file's other profiles, trimmed, each with the first
 * profile that holds it; a key matches only exactly. Every revoke of a tool
 * key on a site in the kit asks it first: a key in it is never revoked, it is
 * forgotten on this profile only (`sayKept` says so), so following a twin's
 * `remove_profile` never kills the key of the profile that stays.
 */
export function keysHeldElsewhere(config: CliConfig, profileName: string): Map<string, string> {
  const held = new Map<string, string>();
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (name === profileName) continue;
    for (const key of keysOfProfile(profile)) if (!held.has(key.apiKey)) held.set(key.apiKey, name);
  }
  return held;
}

/** The lines a run already said of the keys it kept (one sentence per command, whatever the keys). */
const keptLines = new WeakMap<CliIo, Set<string>>();

/** The line of a key not revoked on `site` because profile `other` still holds it, said once per run. */
export function sayKept(io: CliIo, site: string, other: string): void {
  const line = `Kept on ${normalizeUrl(site)}: profile "${other}" still holds that key.\n`;
  const said = keptLines.get(io) ?? new Set<string>();
  if (said.has(line)) return;
  said.add(line);
  keptLines.set(io, said);
  io.err.write(line);
}

// ── The context ──────────────────────────────────────────────────────────────

/**
 * Where this invocation's credential came from, in the order it resolves:
 * the flag (or `--api-key-stdin`), the tool's key variable, the profile's own
 * key (the tool's login), a key the profile keeps from an Antasphere login
 * (served with no exchange), a fresh hub exchange run by this very command,
 * or nothing yet.
 */
export type CredentialSource = 'flag' | 'env' | 'profile' | 'hub-cache' | 'hub-exchange' | 'none';

/** The Antasphere login that signed a command in: its hub, and its account's address. */
export interface CliSignedInLogin {
  hub: string;
  email: string;
}

export interface CliContext<TClient extends ChassisClient<string> = ChassisClient<string>> {
  client: TClient;
  baseUrl: string;
  apiKey: string | undefined;
  /** Where `apiKey` came from (`whoami` says it; the recovery reads it). */
  credentialSource: CredentialSource;
  /**
   * The Antasphere login that signed this command in (`hub-cache` or
   * `hub-exchange`), null otherwise: the login at the hub the SITE names,
   * never the machine's active one (`whoami` names it, PRDCT-3364).
   */
  login: CliSignedInLogin | null;
  json: boolean;
  io: CliIo;
  /**
   * The profile this run selected (cli-core `selectProfile`: --profile, the
   * instance URL, the active profile, the implicit `cloud` profile). Always
   * named on a tool with a cloud URL; `profileCreated` says it is not on
   * disk yet. It is always the profile OF `baseUrl`: a profile and a URL that
   * name two sites are refused before any request.
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

/** What `login --hub` and `login --email` hand the exchange (`connectOptions`). */
export interface CliSignInChoice {
  hubUrl?: string | undefined;
  email?: string | undefined;
}

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
  /**
   * The sentence for a 401 answered to the profile's OWN key (PRDCT-3522):
   * the key is stale, and `login` on that profile is the fix. Null otherwise.
   */
  explainStaleKey(io: CliIo, e: unknown): string | null;
  /**
   * The sentence for a request to the profile's site that could not connect
   * (PRDCT-3060): at a loopback or private address, the profile is named with
   * its fixes (another site, or forgetting it); anywhere else, check and
   * retry. Never the removal for a remote site. Null for any other error.
   */
  explainUnreachable(io: CliIo, e: unknown): string | null;
  /** The instance a profile names: its `baseUrl`, else the tool's cloud URL. */
  profileUrl(profile: CliProfile | undefined): string;
  /**
   * The `connectOnDemand` options of one context (the tool, the site, the
   * profile, the wire, the binary of the sentences), with the hub and the
   * account a command gives (`login --hub`, `login --email`).
   */
  connectOptions(ctx: CliContext<TClient>, given?: CliSignInChoice): ConnectOnDemandOptions;
  /**
   * The sign-in of one context: cli-core `connectOnDemand` with
   * `connectOptions(ctx)` and `overrides`; the login's address the hub
   * replaced is said on stderr.
   */
  connect(
    ctx: CliContext<TClient>,
    overrides?: Partial<ConnectOnDemandOptions>
  ): Promise<ConnectOnDemandOutcome>;
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
  const URL_VAR = `${identity.envPrefix}_URL`;
  const KEY_VAR = `${identity.envPrefix}_API_KEY`;

  /** The named (or active) profile, erroring on an explicitly named missing one. */
  function resolveProfile(
    config: CliConfig,
    requested: string | undefined
  ): { name: string | undefined; profile: CliProfile | undefined } {
    const { name, profile } = selectProfile({ config, requested, cloudUrl: identity.cloudUrl, unknownHint });
    return { name, profile };
  }

  /** A profile's site: its `baseUrl` (a blank one is none), else the tool's cloud URL (cli-core's rule). */
  function profileUrl(profile: CliProfile | undefined): string {
    return firstSet(profile?.baseUrl) ?? identity.cloudUrl;
  }

  /** The URL a command was given, and by what: `--api-url`, `--url`, or the tool's URL variable. */
  function givenUrl(opts: GlobalOpts, env: CliIo['env']): { url: string; by: string } | undefined {
    const flag = firstSet(opts.apiUrl);
    if (flag) return { url: flag, by: '--api-url' };
    const alias = firstSet(opts.url);
    if (alias) return { url: alias, by: '--url' };
    const fromEnv = firstSet(env[URL_VAR]);
    return fromEnv ? { url: fromEnv, by: URL_VAR } : undefined;
  }

  /**
   * Backend + credential resolution, in its documented order:
   *
   *   profile:   --profile → the profile of --api-url / <PREFIX>_URL (made in
   *              memory, named for the host, when none is saved) → the active
   *              profile (`<bin> use`) → the implicit `cloud` profile
   *   base URL:  --api-url (or --url) → <PREFIX>_URL → profile baseUrl → the
   *              tool's cloud URL
   *   API key:   --api-key (or --api-key-stdin) → <PREFIX>_API_KEY (paired
   *              with its site) → the profile's own key → nothing: the
   *              sign-in runs in `requireApiKey` (cli-core `connectOnDemand`,
   *              the login at the hub the SITE names)
   *   workspace: --org / --workspace → <PREFIX>_ORG / <PREFIX>_WORKSPACE
   *              → none (the server's default; workspace.ts)
   *
   * Two refusals before any request (R2, R3): `--profile` naming a saved
   * profile at another site than the URL the command was given (PRDCT-3039,
   * PRDCT-3044), and an exported `<PREFIX>_API_KEY` whose site (`<PREFIX>_URL`,
   * else the cloud) is not the command's (PRDCT-5192). A key given on the
   * command line goes where the command goes; a profile's own key only to its
   * own site.
   */
  function resolveContext(cmd: Command, io: CliIo): CliContext<TClient> {
    const opts = cmd.optsWithGlobals() as GlobalOpts;
    const config = loadConfig(io.env);
    const given = givenUrl(opts, io.env);
    const selected = selectProfile({
      config,
      requested: opts.profile,
      apiUrl: given?.url,
      cloudUrl: identity.cloudUrl,
      unknownHint
    });
    const { name: profileName, profile } = selected;

    const baseUrl = resolveBaseUrl({
      flag: given?.url,
      env: io.env,
      envVar: URL_VAR,
      profile,
      cloudUrl: identity.cloudUrl
    });
    const site = normalizeUrl(baseUrl);

    // 1. A profile and a URL that name two sites (PRDCT-3039, PRDCT-3044).
    if (selected.source === 'flag' && given && profile && !sameInstance(profileUrl(profile), given.url)) {
      const back =
        given.by === URL_VAR
          ? `unset ${URL_VAR} to run on "${profileName}".`
          : `drop ${given.by} to run on "${profileName}".`;
      throw new CliUsageError(
        `Profile "${profileName}" is the site ${normalizeUrl(profileUrl(profile))}, and this command targets ${site}. ` +
          `Drop --profile to run on the profile of ${site}, or ${back}`
      );
    }

    // 2. An exported key travels only to the site the environment names (PRDCT-5192).
    const lineKey = firstSet(opts.apiKey, stdinApiKeys.get(io));
    const envKey = lineKey ? undefined : firstSet(io.env[KEY_VAR]);
    if (envKey) {
      const envUrl = firstSet(io.env[URL_VAR]);
      const keySite = envUrl ?? identity.cloudUrl;
      if (!sameInstance(keySite, baseUrl)) {
        const K = normalizeUrl(keySite);
        // With <PREFIX>_URL set, only a URL flag can send the command elsewhere (a --profile at
        // another site is refused above): dropping that flag is the way back to the key's site.
        throw new CliUsageError(
          envUrl
            ? `${KEY_VAR} is a key of ${K} (${URL_VAR} names it), and this command targets ${site}. ` +
                `Drop ${given?.by ?? '--api-url'} to run on ${K}, or unset ${KEY_VAR}.`
            : `${KEY_VAR} is a key of ${K} (${URL_VAR} is not set, so it belongs to the cloud), and this ` +
                `command targets ${site}. Unset ${KEY_VAR} to run on the profile's own sign-in, or set ` +
                `${URL_VAR} to the site the key was issued for.`
        );
      }
    }

    // The direct credentials; nothing else resolves synchronously.
    const ownKey =
      profile && sameInstance(profileUrl(profile), baseUrl) ? firstSet(profile.apiKey) : undefined;
    const apiKey = lineKey ?? envKey ?? ownKey;
    const credentialSource: CredentialSource = lineKey
      ? 'flag'
      : envKey
        ? 'env'
        : ownKey
          ? 'profile'
          : 'none';
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    const ctx: CliContext<TClient> = {
      client: createClient({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        fetch:
          credentialSource === 'profile' && profileName ? ownKeyFetch(io, fetchImpl, profileName) : fetchImpl
      }),
      baseUrl,
      apiKey,
      credentialSource,
      login: null,
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
    const run = runs.get(io);
    if (run) run.ctx = ctx as CliContext;
    return ctx;
  }

  /**
   * The fetch of a client carrying the profile's own key: its first request
   * waits for the run's settle of the profile (`settleOwnKeyProfile`), and a
   * 401 answered to it is remembered for the runner.
   */
  function ownKeyFetch(
    io: CliIo,
    base: typeof globalThis.fetch,
    profileName: string
  ): typeof globalThis.fetch {
    return async (input, init) => {
      let settled = ownKeySettles.get(io);
      if (!settled) {
        settled = settleOwnKeyProfile(io, profileName, base);
        ownKeySettles.set(io, settled);
      }
      await settled;
      const res = await base(input, init);
      const run = runs.get(io);
      if (res.status === 401 && run) run.ownKeyRefused = true;
      return res;
    };
  }

  /**
   * What cli-core does before every sign-in it runs, done for a command that
   * serves the profile's OWN key, which never reaches cli-core (verifier round
   * 3, F2): once per run, before its first request, the stale keys of the
   * profile's plan (cli-core `planSignIn`, through `planFor`, from the two
   * files: the judgment of what is stale is cli-core's, « unknown is not gone »
   * included) are revoked on the profile's own site with the base fetch (never
   * the one that watches the own key's 401), no lock held; the keys the site
   * answered for (revoked, or 401: already dead) are then forgotten,
   * compare-and-remove, and a key it did not answer for stays for the next
   * command. A key another profile on disk still holds is not revoked: it is
   * forgotten on this profile only, and said (`keysHeldElsewhere`). Nothing
   * of it ever fails the command.
   */
  async function settleOwnKeyProfile(
    io: CliIo,
    profileName: string,
    base: typeof globalThis.fetch
  ): Promise<void> {
    try {
      const config = loadConfig(io.env);
      const profile = config.profiles[profileName];
      if (!profile) return;
      const site = normalizeUrl(profileUrl(profile));
      const { stale } = planFor(identity, io.env, profileName, profile, site);
      if (stale.length === 0) return;
      const elsewhere = keysHeldElsewhere(config, profileName);
      const auth = new CliAuthClient({ baseUrl: site, fetch: base });
      const forget: string[] = [];
      for (const key of stale) {
        const other = elsewhere.get(key.apiKey.trim());
        if (other) {
          sayKept(io, site, other);
          forget.push(key.apiKey);
          continue;
        }
        try {
          await auth.revoke(key.apiKey);
          forget.push(key.apiKey);
        } catch (e) {
          if (e instanceof CliAuthError && e.status === 401) forget.push(key.apiKey);
        }
      }
      forgetKeys(io.env, identity.tool, profileName, forget);
    } catch {
      // A settle that cannot be made waits for the next command; this one goes on.
    }
  }

  const NO_KEY_MESSAGE =
    `An API key is required. Sign in (\`${identity.bin} login\`), pass --api-key, or set ` +
    `${identity.envPrefix}_API_KEY.`;

  function connectOptions(ctx: CliContext<TClient>, given: CliSignInChoice = {}): ConnectOnDemandOptions {
    const { io } = ctx;
    const hubUrl = firstSet(given.hubUrl);
    const email = firstSet(given.email);
    return {
      tool: identity.tool,
      toolBaseUrl: ctx.baseUrl,
      // A profile with no baseUrl of its own is at the cloud URL (cli-core 0.5.0).
      cloudUrl: identity.cloudUrl,
      // A login of the hub file with no baseUrl of its own is at the default
      // hub (cli-core `listLogins`); a login's own baseUrl always wins.
      hubCloudUrl: DEFAULT_HUB_URL,
      // The binary cli-core names in its sentences (a hub to pick, a login to pick).
      bin: identity.bin,
      ...(hubUrl ? { hubUrl } : {}),
      ...(email ? { email } : {}),
      profileName: ctx.profileName ?? CLOUD_PROFILE,
      env: io.env,
      // Thread the injected fetch so the probe + exchange stay on the test
      // harness wire (and any proxying the runner set up).
      ...(io.fetch ? { fetch: io.fetch } : {}),
      notify: (line) => io.err.write(line)
    };
  }

  /** The login's address the hub's answer replaced, said on stderr (an absent one is filled in silently). */
  function sayHealed(io: CliIo, outcome: ConnectOnDemandOutcome): void {
    if (outcome.outcome !== 'connected' || !outcome.healed?.from) return;
    io.err.write(
      `The Antasphere login's address is now ${outcome.healed.to}, replaced from ${outcome.healed.from} ` +
        "(the hub's own answer).\n"
    );
  }

  /**
   * The stranded-key recovery (PRDCT-2947): a fetch that, on the FIRST 401
   * answered to a kept key the sign-in served, runs cli-core's
   * `refreshConnectKey` (compare-and-evict, then the kept key another command
   * stored meanwhile, else the exchange again) and replays the request once
   * with the new key. cli-core keeps what the refused key says of its account
   * and its hub before it evicts the key (a site that names no hub signs in
   * again at that hub), so the recovery hands it nothing of its own. A second
   * 401 stands. A hub refusal on the way (a restricted tool, a swept account)
   * is the hub's own sentence, exit 3, through the runner. A site that no
   * longer signs in through a hub recovers nothing and the 401 stands as it is.
   */
  function recoveringFetch(ctx: CliContext<TClient>, base: typeof globalThis.fetch): typeof globalThis.fetch {
    let recovered = false;
    return async (input, init) => {
      const res = await base(input, init);
      const refused = ctx.apiKey;
      if (res.status !== 401 || recovered || ctx.credentialSource !== 'hub-cache' || !refused) return res;
      recovered = true;
      // A 401 under a workspace selection may be the SELECTION's refusal:
      // the server answers a workspace the person does not belong to exactly
      // like an unknown key (no oracle). Ask `/me` once without it; when the
      // key answers there, it is alive and nothing is evicted, exchanged or
      // replayed (verifier round 1, F2: a refused --org leaked a live key per
      // command). The runner then explains the refusal.
      if (ctx.workspaceId !== undefined) {
        const probe = await base(`${ctx.baseUrl}/api/v1/me`, {
          headers: { authorization: `Bearer ${refused}` }
        }).catch(() => null);
        // Only a probe that ANSWERS 401 proves the key dead (verifier round 2,
        // F10): a probe with no answer, or any other status, keeps the key and
        // lets the 401 stand.
        if (!probe || probe.status !== 401) return res;
      }
      const outcome = await refreshConnectKey({ ...connectOptions(ctx), refusedKey: refused });
      if (outcome.outcome === 'not_cloud') return res;
      // The cause before its consequence (verifier round 3, F1): the sign-in
      // is said first, then what the fresh mint healed.
      ctx.io.err.write('The cached key was refused; signed in again through Antasphere.\n');
      sayHealed(ctx.io, outcome);
      ctx.apiKey = outcome.key;
      ctx.credentialSource = outcome.cached ? 'hub-cache' : 'hub-exchange';
      ctx.login = { hub: outcome.login.hub, email: outcome.login.email };
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${outcome.key}`);
      return base(input, { ...init, headers });
    };
  }

  /**
   * Requires an API key; throws a friendly message the runner turns into exit 1.
   *
   * When nothing direct resolved, this is the sign-in (binding patterns §7,
   * gcloud model), owned by @antasphere/cli-core: on a site that signs in
   * through an Antasphere hub, the login AT THE HUB THE SITE NAMES (never the
   * machine's active one) is exchanged (hub → tool) for a USER-scoped key the
   * profile keeps, filed by hub and account; a kept key is served with zero
   * network on every later run (discovery read again once a day). A site
   * that signs in by itself never takes this branch: it gets the classic
   * error unchanged.
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

  /** The name a context's profile goes by in a sentence. */
  function nameOf(ctx: CliContext): string {
    return ctx.profileName ?? CLOUD_PROFILE;
  }

  function explainStaleKey(io: CliIo, e: unknown): string | null {
    const run = runs.get(io);
    const ctx = run?.ctx;
    if (!ctx || !run.ownKeyRefused || ctx.credentialSource !== 'profile') return null;
    if (!(e instanceof PlatformApiError || e instanceof CliAuthError) || e.status !== 401) return null;
    const name = nameOf(ctx);
    return (
      `The key of profile "${name}" was refused by ${normalizeUrl(ctx.baseUrl)} (${e.code}): it is stale. ` +
      `Run ${identity.bin} --profile ${name} login to sign in again.`
    );
  }

  /** The sentence for the profile's site that does not answer (PRDCT-3060). */
  function unreachableSentence(ctx: CliContext): string {
    const url = normalizeUrl(ctx.baseUrl);
    const name = nameOf(ctx);
    // Only a profile ON DISK can be forgotten, and only a local one is offered
    // the removal: a remote site that is down is an outage, not a leftover.
    if (!ctx.profileCreated && isLocalSite(url)) {
      return (
        `Profile "${name}" is ${url}, and nothing answers there. Run on another site with --profile <name> or ` +
        `${identity.bin} use <name>, or forget this one: ${identity.bin} profiles remove ${name}.`
      );
    }
    return `Nothing answers at ${url} (profile "${name}"). Check the address, or try again.`;
  }

  function explainUnreachable(io: CliIo, e: unknown): string | null {
    const run = runs.get(io);
    const ctx = run?.ctx;
    if (!ctx || typeof e !== 'object' || e === null) return null;
    const origin = run.failures.get(e);
    if (origin === undefined || origin !== originOf(ctx.baseUrl)) return null;
    return unreachableSentence(ctx);
  }

  async function connect(
    ctx: CliContext<TClient>,
    overrides: Partial<ConnectOnDemandOptions> = {}
  ): Promise<ConnectOnDemandOutcome> {
    const outcome = await connectOnDemand({ ...connectOptions(ctx, overrides), ...overrides });
    sayHealed(ctx.io, outcome);
    return outcome;
  }

  async function connectForKey(ctx: CliContext<TClient>): Promise<string> {
    const { io } = ctx;
    const run = runs.get(io);
    const before = run?.lastFailure;
    const outcome = await connect(ctx);
    if (outcome.outcome === 'not_cloud') {
      // A site whose discovery could not even connect is not « a site that
      // signs in by itself »: it is a site that does not answer (PRDCT-3060).
      const failed = run?.lastFailure;
      if (failed && failed !== before && failed.origin === originOf(ctx.baseUrl)) {
        throw new CliUsageError(unreachableSentence(ctx as CliContext));
      }
      // Self-hosted: the classic error, byte-identical.
      throw new CliUsageError(NO_KEY_MESSAGE);
    }

    // The key becomes this invocation's credential.
    ctx.apiKey = outcome.key;
    ctx.credentialSource = outcome.cached ? 'hub-cache' : 'hub-exchange';
    ctx.login = { hub: outcome.login.hub, email: outcome.login.email };
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
    explainStaleKey,
    explainUnreachable,
    profileUrl,
    connectOptions,
    connect
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
