import {
  CliConfigError,
  firstSet,
  freshProfileName,
  HUB_URL_ENV,
  listLogins,
  normalizeUrl,
  planSignIn,
  sameInstance,
  selectProfile,
  undecidedLogins,
  type CliConfig,
  type CliEnv,
  type CliProfile,
  type CliSiteFacts,
  type SignInPlan,
  type ToolInstanceProbe
} from '@antasphere/cli-core';
import { isLocalSite, table } from './context.js';
import { DEFAULT_HUB_URL, type CliIdentity } from './identity.js';

/**
 * `profiles --json`, the contract a client draws (R4, PRDCT-5190), and the
 * text listing read from it. ONE builder, `describeProfiles`, answers
 * `profiles`, `profiles --json`, `profiles --check` and the JSON of
 * `profiles add` and `profiles rename`; nothing else spells the contract.
 *
 * Every state is decided from the two files alone (the tool's profiles, the
 * hub's logins) by cli-core's `planSignIn`, the environment set aside; what
 * the environment changes is said beside it, per profile. `--check` adds what
 * each site answered just now. No field carries key material, redacted or
 * not: a profile's keys are counted, never shown.
 *
 * Unknown is not gone: a hub file that cannot be read stops the listing with
 * cli-core's sentence and what it means for the kept keys, and a hub entry
 * whose hub cannot be told is no login, said beside the logins in the text.
 */

/** What a hub file that cannot be read means for the kept keys, after cli-core's sentence. */
const UNREAD_HUB_FILE = ' Until it reads again, no kept key is judged signed out and none is revoked.';

/**
 * Run what reads the hub file. One that cannot be read is cli-core's
 * `CliConfigError`, thrown again with what it means: while it does not read,
 * no command judges a kept key signed out, and none is revoked.
 */
function readingHubFile<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof CliConfigError && !e.message.endsWith(UNREAD_HUB_FILE)) {
      throw new CliConfigError(`${e.message}${UNREAD_HUB_FILE}`);
    }
    throw e;
  }
}

/**
 * The hub file's entries that hold a key and whose hub cannot be told (cli-core
 * `undecidedLogins`): no login, and while one is there no kept key is judged
 * signed out. The text listing says each.
 */
export function undecidedLoginsOf(env: CliEnv): string[] {
  return readingHubFile(() => undecidedLogins(env, { hubCloudUrl: DEFAULT_HUB_URL }));
}

/** Where a profile stands with its sign-in (cli-core `planSignIn`). */
export type ProfileSignInState = 'signed_in' | 'will_sign_in' | 'needs_login' | 'unknown';

/**
 * The one way to fix a profile. `paste_key` is a kind of the contract that no
 * rule of this listing produces today (a client may still meet it).
 */
export type ProfileFixKind =
  'hub_login' | 'email_code' | 'paste_key' | 'pick_hub' | 'pick_login' | 'check' | 'remove_profile';

/**
 * A fix as a command line, never a shell string: `argv[0]` is the binary.
 * `pick_hub` ends with `--hub` (append one `logins[].hub`), `pick_login` with
 * `--email` (append an address).
 */
export interface ProfileFix {
  kind: ProfileFixKind;
  argv: string[];
}

/** What `--check` heard from a site. */
export type ProfileCheckVerdict = 'ok' | 'key_refused' | 'unreachable' | 'no_key';

/** Who the key a command would send answers as (`--check`, on `ok`). */
export interface ProfileCheckedPerson {
  name: string | null;
  email: string;
  /** The name of the workspace the key answers in, or null. */
  workspace: string | null;
}

export interface ProfileSignIn {
  state: ProfileSignInState;
  /** `key`: the profile's own key; `login`: a login at a hub; null when nothing signs it in yet. */
  via: 'login' | 'key' | null;
  /** The hub that signs it in (null for its own key, and when no hub is known). */
  hub: string | null;
  /** The login's address; for its own key, the address stored with it. */
  email: string | null;
  /** How many keys the next sign-in on this site revokes there (a count, never a key). */
  staleKeys: number;
  fix: ProfileFix | null;
  /** `--check` only. */
  checked?: ProfileCheckVerdict;
  /** `--check` only: on `ok`, who answered; otherwise null. */
  person?: ProfileCheckedPerson | null;
}

/** The site a profile is, and what it last said of itself (every field but `origin` null until reached). */
export interface ProfileSite {
  origin: string;
  name: string | null;
  hub: string | null;
  federated: boolean | null;
  cliVersion: string | null;
  seenAt: string | null;
}

/** What one exported variable does to a profile's commands. */
export interface ProfileEnvironmentEffect {
  variable: string;
  effect: 'replaces' | 'refuses';
}

export interface ProfileEntry {
  name: string;
  /** The profile a command typed by hand runs on. */
  default: boolean;
  /** false: the implicit cloud profile, listed before it is on disk. */
  saved: boolean;
  site: ProfileSite;
  /** Whether this CLI is older than the version its site speaks; null when the site announces none. */
  cliBehind: boolean | null;
  signIn: ProfileSignIn;
  environment: ProfileEnvironmentEffect[];
}

export interface ProfilesLogin {
  hub: string;
  email: string | null;
  /** The login's entry in the hub file. */
  name: string;
}

export interface ProfilesListing {
  /** Which machine answers. */
  machine: string;
  /** This CLI's own version. */
  cliVersion: string;
  /** The site of the default profile. */
  defaultSite: string;
  /** What is exported: the URL variable, whether the key variable is set (never its value), the hub variable. */
  environment: { url: string | null; key: boolean; hubUrl: string | null };
  logins: ProfilesLogin[];
  profiles: ProfileEntry[];
}

/** What `--check` found at one profile's site. */
export interface ProfileCheck {
  /** What the site said of itself just now; null when nothing answered as a site of this tool. */
  facts: CliSiteFacts | null;
  checked: ProfileCheckVerdict;
  person: ProfileCheckedPerson | null;
}

/** The identity fields the listing reads. */
export type ListingIdentity = Pick<CliIdentity, 'bin' | 'tool' | 'envPrefix' | 'cloudUrl'>;

export interface DescribeProfilesInput {
  identity: ListingIdentity;
  /** The tool's file, as read. */
  config: CliConfig;
  /** The environment: the hub file is read from it, and the variables it exports are said. */
  env: CliEnv;
  machine: string;
  cliVersion: string;
  /** What `--check` found, by profile name. */
  checks?: ReadonlyMap<string, ProfileCheck> | undefined;
}

/** One row of the listing: a saved profile, or the implicit cloud one. */
export interface ProfileRow {
  name: string;
  /** The profile as the file holds it; undefined for the implicit cloud row. */
  profile: CliProfile | undefined;
  saved: boolean;
  /** Its site, normalized: its `baseUrl`, else the tool's cloud URL. */
  site: string;
}

/** A value of the file as a trimmed string, or undefined when it is not a non-blank string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? firstSet(value) : undefined;
}

/**
 * The rows: every saved profile in the file's order, and first the implicit
 * cloud profile when no saved profile is at the cloud URL, under the name
 * cli-core's selection gives it (`cloud`, unless that name is taken).
 */
export function profileRows(config: CliConfig, cloudUrl: string): ProfileRow[] {
  const saved: ProfileRow[] = Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    profile,
    saved: true,
    site: normalizeUrl(firstSet(profile.baseUrl) ?? cloudUrl)
  }));
  if (saved.some((row) => sameInstance(row.site, cloudUrl))) return saved;
  const implicit: ProfileRow = {
    name: freshProfileName(config, cloudUrl, cloudUrl),
    profile: undefined,
    saved: false,
    site: normalizeUrl(cloudUrl)
  };
  return [implicit, ...saved];
}

/** What a profile remembers of its site, when it reads as such (cli-core's own check). */
export function rememberedSite(profile: CliProfile | undefined): CliSiteFacts | undefined {
  const s: unknown = profile?.site;
  if (typeof s !== 'object' || s === null) return undefined;
  const f = s as Record<string, unknown>;
  const nullableText = (v: unknown): boolean => v === null || typeof v === 'string';
  if (!nullableText(f.hub) || typeof f.federated !== 'boolean' || !nullableText(f.name)) return undefined;
  if (!nullableText(f.cliVersion) || typeof f.seenAt !== 'string') return undefined;
  return s as CliSiteFacts;
}

/** What a discovery probe says of a site, as a profile keeps it. */
export function factsOfProbe(probe: ToolInstanceProbe, seenAt: string): CliSiteFacts {
  return { hub: probe.hub, federated: probe.cloud, name: probe.name, cliVersion: probe.cliVersion, seenAt };
}

/** The sign-in plan of one profile on its own site, from the two files alone (the environment set aside). */
export function planFor(
  identity: ListingIdentity,
  env: CliEnv,
  name: string,
  profile: CliProfile | undefined,
  site: string
): SignInPlan {
  return planSignIn({
    env,
    tool: identity.tool,
    profileName: name,
    profile,
    siteUrl: site,
    cloudUrl: identity.cloudUrl,
    hubCloudUrl: DEFAULT_HUB_URL
  });
}

/** The key a command on this profile would send (its own, or the kept key the plan serves), or none. */
export function servedKey(plan: SignInPlan, profile: CliProfile | undefined): string | undefined {
  if (plan.state !== 'signed_in') return undefined;
  return plan.via === 'key' ? text(profile?.apiKey) : plan.keptKey?.apiKey;
}

/** A copy of a profile without its own key: how `login` sees it once its site refused that key. */
function withoutOwnKey(profile: CliProfile): CliProfile {
  const copy = structuredClone(profile);
  delete copy.apiKey;
  return copy;
}

// ── Versions ─────────────────────────────────────────────────────────────────

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Version {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(value: string | null | undefined): Version | undefined {
  const m = typeof value === 'string' ? VERSION_RE.exec(value.trim()) : null;
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver order: `x.y.z` numerically, a pre-release older than its release, its identifiers in order. */
function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether this CLI is older than the version a site speaks; null when either is not a version. */
export function cliBehindOf(cliVersion: string, siteVersion: string | null): boolean | null {
  const site = parseVersion(siteVersion);
  const cli = parseVersion(cliVersion);
  if (!site || !cli) return null;
  return compareVersions(cli, site) < 0;
}

// ── Fixes ────────────────────────────────────────────────────────────────────

/**
 * The `login` of a row: `--profile <name>` for a saved profile; the implicit
 * cloud row is not on disk, so `--profile` would not find it, and its site
 * selects it instead.
 */
function loginArgv(row: ProfileRow, bin: string, ...more: string[]): string[] {
  return row.saved
    ? [bin, '--profile', row.name, 'login', ...more]
    : [bin, '--api-url', row.site, 'login', ...more];
}

const checkFix = (bin: string): ProfileFix => ({ kind: 'check', argv: [bin, 'profiles', '--check'] });

const removeFix = (row: ProfileRow, bin: string): ProfileFix => ({
  kind: 'remove_profile',
  argv: [bin, 'profiles', 'remove', row.name]
});

/** The fix of a plan: none when it signs in, `check` when nothing is known, else the sign-in it needs. */
function fixOfPlan(plan: SignInPlan, row: ProfileRow, bin: string): ProfileFix | null {
  if (plan.state === 'signed_in' || plan.state === 'will_sign_in') return null;
  if (plan.state === 'unknown') return checkFix(bin);
  switch (plan.reason) {
    case 'no_login_at_hub':
      return { kind: 'hub_login', argv: loginArgv(row, bin) };
    case 'own_sign_in':
      return { kind: 'email_code', argv: loginArgv(row, bin) };
    case 'pick_hub':
      return { kind: 'pick_hub', argv: loginArgv(row, bin, '--hub') };
    case 'pick_login':
      return { kind: 'pick_login', argv: loginArgv(row, bin, '--email') };
    default:
      // A refusal needs the environment, which the listing sets aside.
      return checkFix(bin);
  }
}

/** The login a site asks for once its key was refused: the plan with that key set aside. */
function loginFixOf(plan: SignInPlan, row: ProfileRow, bin: string): ProfileFix {
  switch (plan.reason) {
    case 'own_sign_in':
      return { kind: 'email_code', argv: loginArgv(row, bin) };
    case 'pick_hub':
      return { kind: 'pick_hub', argv: loginArgv(row, bin, '--hub') };
    case 'pick_login':
      return { kind: 'pick_login', argv: loginArgv(row, bin, '--email') };
    default:
      return { kind: 'hub_login', argv: loginArgv(row, bin) };
  }
}

// ── The environment ──────────────────────────────────────────────────────────

/**
 * What the exported variables do to a profile's commands (no `--api-key` on
 * a listing): `<PREFIX>_API_KEY` replaces the credential on the profile at
 * its site (`<PREFIX>_URL`, else the cloud URL) and refuses every other;
 * `ANTASPHERE_URL` refuses a profile whose site names another hub, replaces
 * the hub of one whose site names none or was never reached, and does nothing
 * where its site names that very hub. A profile with its own key never
 * reaches the hub choice, and a self-hosted site signs in by itself:
 * `ANTASPHERE_URL` does nothing to either.
 */
function effectsOf(
  identity: ListingIdentity,
  env: CliEnv,
  row: ProfileRow,
  facts: CliSiteFacts | undefined
): ProfileEnvironmentEffect[] {
  const effects: ProfileEnvironmentEffect[] = [];
  const keyVar = `${identity.envPrefix}_API_KEY`;
  if (firstSet(env[keyVar])) {
    const keySite = firstSet(env[`${identity.envPrefix}_URL`]) ?? identity.cloudUrl;
    effects.push({ variable: keyVar, effect: sameInstance(row.site, keySite) ? 'replaces' : 'refuses' });
  }
  const hub = firstSet(env[HUB_URL_ENV]);
  if (hub && !text(row.profile?.apiKey) && facts?.federated !== false) {
    const named = text(facts?.hub);
    if (!named) effects.push({ variable: HUB_URL_ENV, effect: 'replaces' });
    else if (!sameInstance(named, hub)) effects.push({ variable: HUB_URL_ENV, effect: 'refuses' });
  }
  return effects;
}

// ── The builder ──────────────────────────────────────────────────────────────

function entryOf(input: DescribeProfilesInput, row: ProfileRow, isDefault: boolean): ProfileEntry {
  const { identity, env, config } = input;
  const { bin } = identity;
  const check = input.checks?.get(row.name);
  // What the site said: a saved profile remembers it (`--check` wrote it there just now); the implicit
  // row holds only what `--check` heard.
  const facts = row.saved ? rememberedSite(row.profile) : (check?.facts ?? undefined);
  const planned = row.saved ? row.profile : facts ? { baseUrl: row.site, site: facts } : undefined;
  const plan = planFor(identity, env, row.name, planned, row.site);

  let state: ProfileSignInState = plan.state;
  let fix = fixOfPlan(plan, row, bin);
  if (check?.checked === 'key_refused') {
    // The site refused the key a command would send: the login its site asks for. A refused own key
    // is planned without it (what `login` reads). A refused kept key still tells `login` which hub
    // and which login signed the profile in, so `login` alone signs it in again.
    state = 'needs_login';
    fix =
      plan.via === 'key' && planned
        ? loginFixOf(planFor(identity, env, row.name, withoutOwnKey(planned), row.site), row, bin)
        : { kind: 'hub_login', argv: loginArgv(row, bin) };
  } else if (check?.checked === 'unreachable') {
    // A leftover at a loopback or private address may be forgotten; a remote site that is down is an
    // outage, and only an attempt again is offered (PRDCT-3060).
    fix = row.saved && isLocalSite(row.site) ? removeFix(row, bin) : checkFix(bin);
  }
  // A second profile at a site that has one (a file from before one profile per site): the one the
  // selection never picks is forgotten, whatever its state.
  if (
    row.saved &&
    selectProfile({ config, apiUrl: row.site, cloudUrl: identity.cloudUrl }).name !== row.name
  ) {
    fix = removeFix(row, bin);
  }

  const signIn: ProfileSignIn = {
    state,
    via: plan.via,
    hub: plan.via === 'key' ? null : plan.hub,
    email: plan.via === 'key' ? (text(row.profile?.email) ?? null) : (text(plan.login?.email) ?? null),
    staleKeys: plan.stale.length,
    fix,
    ...(check ? { checked: check.checked, person: check.checked === 'ok' ? check.person : null } : {})
  };
  const hub = text(facts?.hub);
  return {
    name: row.name,
    default: isDefault,
    saved: row.saved,
    site: {
      origin: row.site,
      name: facts?.name ?? null,
      hub: hub ? normalizeUrl(hub) : null,
      federated: facts?.federated ?? null,
      cliVersion: facts?.cliVersion ?? null,
      seenAt: facts?.seenAt ?? null
    },
    cliBehind: cliBehindOf(input.cliVersion, facts?.cliVersion ?? null),
    signIn,
    environment: effectsOf(identity, env, row, facts)
  };
}

/**
 * The listing: the machine, this CLI's version, the default profile's site,
 * what the environment exports, the machine's logins, and one entry per
 * profile (the implicit cloud row first when no saved profile is at the
 * cloud URL). Pure but for the hub file it reads: one that cannot be read is
 * cli-core's `CliConfigError`, with what it means for the kept keys.
 */
export function describeProfiles(input: DescribeProfilesInput): ProfilesListing {
  const { identity, config, env } = input;
  const rows = profileRows(config, identity.cloudUrl);
  const defaultName = selectProfile({ config, cloudUrl: identity.cloudUrl }).name;
  const url = firstSet(env[`${identity.envPrefix}_URL`]);
  const hubUrl = firstSet(env[HUB_URL_ENV]);
  return readingHubFile(() => ({
    machine: input.machine,
    cliVersion: input.cliVersion,
    defaultSite: rows.find((row) => row.name === defaultName)?.site ?? normalizeUrl(identity.cloudUrl),
    environment: {
      url: url ? normalizeUrl(url) : null,
      key: firstSet(env[`${identity.envPrefix}_API_KEY`]) !== undefined,
      hubUrl: hubUrl ? normalizeUrl(hubUrl) : null
    },
    logins: listLogins(env, { hubCloudUrl: DEFAULT_HUB_URL }).map((login) => ({
      hub: login.hub,
      email: login.email ?? null,
      name: login.name
    })),
    profiles: rows.map((row) => entryOf(input, row, row.name === defaultName))
  }));
}

// ── The text listing ─────────────────────────────────────────────────────────

const LOGIN_FIXES = new Set<ProfileFixKind>([
  'hub_login',
  'email_code',
  'paste_key',
  'pick_hub',
  'pick_login'
]);

/** A fix as a person types it: its argv, quoted where a shell needs it, and what to append. */
export function commandLine(fix: ProfileFix): string {
  const words = fix.argv.map((a) => (/^[A-Za-z0-9._:@/=+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`));
  if (fix.kind === 'pick_hub') words.push('<hub>');
  if (fix.kind === 'pick_login') words.push('<address>');
  return words.join(' ');
}

function checkedWords(signIn: ProfileSignIn): string | undefined {
  switch (signIn.checked) {
    case 'ok': {
      const person = signIn.person;
      const where = person?.workspace ? ` in ${person.workspace}` : '';
      return person ? `checked: answers as ${person.email}${where}` : 'checked: answers';
    }
    case 'key_refused':
      return 'checked: the site refused its key';
    case 'unreachable':
      return 'checked: no answer';
    case 'no_key':
      return 'checked: the site answers, no key to try';
    default:
      return undefined;
  }
}

/** The SIGN-IN cell: the state in plain words, what `--check` heard, and a fix the words do not carry. */
function signInWords(entry: ProfileEntry, all: ProfileEntry[]): string {
  const s = entry.signIn;
  const who = `${s.email ?? '(no address)'} at ${s.hub ?? '(no hub)'}`;
  const fix = s.fix;
  const loginFix = fix !== null && LOGIN_FIXES.has(fix.kind);
  const unknownFix = fix?.kind === 'check' && s.checked === undefined;
  const parts: string[] = [];
  switch (s.state) {
    case 'signed_in':
      parts.push(s.via === 'key' ? 'signed in with its own key' : `signed in: ${who}`);
      break;
    case 'will_sign_in':
      parts.push(`signs in at the next command: ${who}`);
      break;
    case 'needs_login':
      parts.push(loginFix && fix ? `needs a sign-in: ${commandLine(fix)}` : 'needs a sign-in');
      break;
    case 'unknown':
      parts.push(unknownFix && fix ? `not reached yet: ${commandLine(fix)}` : 'not reached yet');
      break;
  }
  const heard = checkedWords(s);
  if (heard) parts.push(heard);
  const carried = (s.state === 'needs_login' && loginFix) || (s.state === 'unknown' && unknownFix);
  if (fix && !carried) {
    const twin = all.some((e) => e !== entry && e.saved && sameInstance(e.site.origin, entry.site.origin));
    const lead =
      fix.kind === 'remove_profile'
        ? twin
          ? 'a second profile at this site, forget it'
          : 'forget it'
        : fix.kind === 'check'
          ? 'try again'
          : 'fix it';
    parts.push(`${lead}: ${commandLine(fix)}`);
  }
  return parts.join('; ');
}

/** The lines of the variables that change something, in the tool's own prefix. */
function environmentLines(listing: ProfilesListing, identity: ListingIdentity): string[] {
  const { envPrefix: P } = identity;
  const lines: string[] = [];
  const { url, key, hubUrl } = listing.environment;
  if (url) {
    lines.push(
      `${P}_URL is exported: commands that name no site run on ${url}, and --profile naming another site refuses.`
    );
  }
  if (key) {
    const site = url ?? normalizeUrl(identity.cloudUrl);
    lines.push(`${P}_API_KEY is exported: commands on ${site} use it; commands on other sites refuse.`);
  }
  if (hubUrl) {
    const of = (effect: string) =>
      listing.profiles.some((p) =>
        p.environment.some((e) => e.variable === HUB_URL_ENV && e.effect === effect)
      );
    const clauses = [
      ...(of('replaces') ? [`profiles whose site names no hub sign in at ${hubUrl}`] : []),
      ...(of('refuses') ? ['commands on sites that name another hub refuse'] : [])
    ];
    if (clauses.length > 0) lines.push(`${HUB_URL_ENV} is exported: ${clauses.join('; ')}.`);
  }
  return lines;
}

/** What the text listing says beside the contract (the JSON carries none of it). */
export interface RenderProfilesExtra {
  /** The hub entries whose hub cannot be told (`undecidedLoginsOf`): one line each. */
  undecidedLogins?: readonly string[] | undefined;
}

/**
 * The text of `profiles`: one row per profile (`*` the default, the name, the
 * site, the sign-in in plain words with the account and the hub, the CLI
 * version the site speaks), then this CLI and the machine, a line per
 * exported variable that changes something, the machine's logins, and a line
 * per hub entry whose hub cannot be told.
 */
export function renderProfiles(
  listing: ProfilesListing,
  identity: ListingIdentity,
  extra: RenderProfilesExtra = {}
): string {
  const rows = [
    ['', 'PROFILE', 'SITE', 'SIGN-IN', 'SITE CLI'],
    ...listing.profiles.map((entry) => [
      entry.default ? '*' : '',
      entry.name,
      entry.site.origin,
      signInWords(entry, listing.profiles),
      entry.site.cliVersion
        ? `${entry.site.cliVersion}${entry.cliBehind ? ' (newer than this CLI)' : ''}`
        : '-'
    ])
  ];
  const logins =
    listing.logins.length > 0
      ? `Antasphere logins: ${listing.logins
          .map((l) => `${l.email ?? '(no address)'} at ${l.hub} (${l.name})`)
          .join(', ')}.`
      : 'No Antasphere login on this machine.';
  // Unknown is not gone: an entry whose hub cannot be told is no login, and while it is there no kept key
  // is judged gone for want of one.
  const undecided = (extra.undecidedLogins ?? []).map(
    (name) =>
      `The Antasphere login "${name}" names no hub this CLI can read: no kept key is judged signed out ` +
      'while it is there.'
  );
  return [
    table(rows).trimEnd(),
    '',
    `This CLI ${listing.cliVersion} on ${listing.machine}.`,
    ...environmentLines(listing, identity),
    logins,
    ...undecided,
    ''
  ].join('\n');
}
