import type { Command } from 'commander';
import {
  ask,
  chooseHub,
  chooseLogin,
  CliAuthClient,
  CliAuthError,
  CliUsageError as CoreUsageError,
  CLOUD_PROFILE,
  firstSet,
  forgetKeys,
  freshProfileName,
  HUB_TOOL,
  HUB_URL_ENV,
  keysOfProfile,
  listLogins,
  normalizeUrl,
  probeToolInstance,
  rememberSite,
  sameInstance,
  selectProfile,
  updateConfig as updateCoreConfig,
  type CliAuthCompleted,
  type CliConfig,
  type CliLogin,
  type CliProfile,
  type ProfileKey
} from '@antasphere/cli-core';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import { DEFAULT_HUB_URL } from '../identity.js';
import {
  CliUsageError,
  keysHeldElsewhere,
  printJson,
  sayKept,
  stdinApiKey,
  type CliContext,
  type CliIo
} from '../context.js';
import type { CliKit } from '../kit.js';
import type { MeResponse } from '../workspace.js';

/**
 * Identity + profile commands (PRDCT-2947, PRDCT-2446): ONE `login` that
 * ends in the tool, `logout` that revokes what it forgets, whoami/verify,
 * `use`, and `config show` / `config clear`; the listing and the management
 * of the profiles (`profiles`, add, rename, remove) are `profiles.ts`'s.
 *
 * A profile is a site (cli-core 0.5.0), and it signs in the way its site
 * asks (R2, R3): on a site that signs in through an Antasphere hub, with the
 * login AT THE HUB THE SITE NAMES (cli-core `chooseHub`, `chooseLogin`: never
 * the machine's active login), signed in once with the hub's email code when
 * there is none, then the exchange that mints the key the profile keeps; on a
 * site that signs in by itself, with its own email code; or with a pasted
 * key. A login never moves the default profile, nor the hub file's active
 * login, except for the first of a machine; every write is one locked
 * `updateConfig` (R0).
 */

interface AuthGlobals {
  apiUrl?: string;
  url?: string;
  profile?: string;
  json?: boolean;
}

interface LoginOpts {
  email?: string;
  hub?: string;
  keyName?: string;
  expiresInDays?: number;
}

/** Two addresses are one: both present, equal once trimmed and case-folded. */
function sameAddress(a: string | undefined, b: string | undefined): boolean {
  const x = firstSet(a)?.toLowerCase();
  return x !== undefined && x === firstSet(b)?.toLowerCase();
}

/** How a login reads in a sentence: `<email> at <hub>`. */
function loginLabel(login: { email?: string | undefined; hub: string }): string {
  return `${firstSet(login.email) ?? '(no address)'} at ${login.hub}`;
}

/** How a signed-in credential reads in a sentence. */
function describeCredential(ctx: CliContext): string {
  const login = ctx.login ? `the Antasphere login ${loginLabel(ctx.login)}` : 'the Antasphere login';
  switch (ctx.credentialSource) {
    case 'flag':
      return 'the --api-key flag';
    case 'env':
      return 'the API key variable';
    case 'profile':
      return ctx.profileName ? `the key of profile "${ctx.profileName}"` : 'the profile key';
    case 'hub-cache':
      return `${login} (kept key)`;
    case 'hub-exchange':
      return `${login} (fresh sign-in)`;
    case 'none':
      return 'nothing';
  }
}

/** `Signed in as Ada <ada@x.co> in Acme (organization …) on <url>`. */
function signedInLine(me: MeResponse, baseUrl: string): string {
  const who = me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email;
  const active = me.workspace ? me.workspaces.find((w) => w.id === me.workspace!.id) : undefined;
  const org = active && (active as { centralAccountId?: string | null }).centralAccountId;
  const where = me.workspace
    ? ` in ${me.workspace.name}${org ? ` (organization ${org})` : ''}`
    : ' with no workspace yet';
  return `Signed in as ${who}${where} on ${baseUrl}.`;
}

/** The one line listing the other organizations, with the --org hint, or ''. */
function organizationsLine(me: MeResponse): string {
  if (me.workspaces.length < 2) return '';
  const names = me.workspaces.map((w) => w.name).join(', ');
  return `Your workspaces: ${names}. Pass --org <name> (or --workspace <name>) to work in another.\n`;
}

/** What a site answered to the self-revoke of one key. */
type RevokeAnswer = 'revoked' | 'dead' | 'refused';

export function registerAuthCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const {
    identity,
    createClient,
    configPath,
    connect,
    loadConfig,
    profileUrl,
    requireApiKey,
    resolveContext,
    updateConfig,
    workspaceSource
  } = kit;
  const { describeSource } = kit.workspace;
  const { bin } = identity;

  const fetchOf = (): typeof globalThis.fetch => io.fetch ?? globalThis.fetch.bind(globalThis);
  const authAt = (baseUrl: string): CliAuthClient => new CliAuthClient({ baseUrl, fetch: fetchOf() });
  const loginsNow = (): CliLogin[] => listLogins(io.env, { hubCloudUrl: DEFAULT_HUB_URL });

  /** The default profile: what a command typed by hand runs on (the active one, else the cloud's). */
  function defaultOf(config: CliConfig): string | undefined {
    return selectProfile({ config, cloudUrl: identity.cloudUrl }).name;
  }

  /**
   * Save the tool's own key on a profile, in one `updateConfig`; the profile
   * becomes the default only on a machine whose tool file held no profile.
   * Answers the own key the write replaced, as the file held it under the
   * lock (a re-login, a pasted key): `retireReplaced` revokes it.
   */
  function saveOwnKey(
    profileName: string,
    baseUrl: string,
    apiKey: string,
    email: string | undefined
  ): { path: string; madeDefault: boolean; replaced: string | undefined } {
    let madeDefault = false;
    let replaced: string | undefined;
    const { path } = updateConfig(io.env, (config) => {
      const first = Object.keys(config.profiles).length === 0;
      const before = config.profiles[profileName];
      const old = before && sameInstance(profileUrl(before), baseUrl) ? firstSet(before.apiKey) : undefined;
      replaced = old !== undefined && old !== firstSet(apiKey) ? old : undefined;
      config.profiles[profileName] = {
        ...config.profiles[profileName],
        apiKey,
        baseUrl: normalizeUrl(baseUrl),
        ...(email ? { email } : {})
      };
      if (first) {
        config.activeProfile = profileName;
        madeDefault = true;
      }
    });
    return { path, madeDefault, replaced };
  }

  /**
   * The own key a new one replaced (a self-hosted re-login, a pasted key),
   * revoked on the profile's own site once the new key is saved, with no lock
   * held: nothing is left live behind it. A site that refuses the revoke, or
   * does not answer, is said; the key stays valid there. A key another
   * profile on disk still holds is not revoked (the save already took it off
   * this one), and that is said.
   */
  async function retireReplaced(
    profileName: string,
    site: string,
    replaced: string | undefined
  ): Promise<void> {
    if (!replaced) return;
    const other = keysHeldElsewhere(loadConfig(io.env), profileName, identity.cloudUrl).get(replaced.trim());
    if (other) {
      sayKept(io, site, other);
      return;
    }
    try {
      await revokeOnSite(site, replaced, 'the replaced key', true);
    } catch (e) {
      io.err.write(
        e instanceof CliAuthError
          ? `${site} did not revoke the replaced key (${e.code}): it stays valid there until revoked from ` +
              'its dashboard.\n'
          : `Could not reach ${site} to revoke the replaced key: it stays valid there until revoked from its ` +
              'dashboard.\n'
      );
    }
  }

  /** The one line a login says when its profile is not the default (R3: nothing moves the default). */
  function sayDefault(profileName: string, madeDefault: boolean): void {
    if (madeDefault) return;
    const current = defaultOf(loadConfig(io.env));
    if (current === undefined || current === profileName) return;
    io.err.write(
      `Signed in on profile "${profileName}". The default profile stays "${current}" ` +
        `(${bin} use ${profileName} makes "${profileName}" the default).\n`
    );
  }

  /** The hub's email-code sign-in at one hub: the wire `antasphere login` speaks. */
  async function hubEmailCode(
    hub: string,
    email: string | undefined,
    opts: LoginOpts
  ): Promise<CliAuthCompleted> {
    const auth = authAt(hub);
    const address = email ?? (await ask(io, 'Antasphere email: '));
    await auth.request({ email: address });
    io.err.write(`A sign-in code was sent to ${address} (if that Antasphere account can receive mail).\n`);
    const otp = await ask(io, 'Code: ');
    return auth.complete({
      email: address,
      otp,
      ...(opts.keyName ? { keyName: opts.keyName } : {}),
      ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {})
    });
  }

  /**
   * The entry of the hub file a new login at `hub` is written on: one that
   * is at that hub and holds no key (the account CLI's own profile there,
   * signed out), the active one first; else a new one named the way the hub
   * CLI names it (`freshProfileName`: `cloud` for the default hub, else the
   * host).
   */
  function entryFor(hubConfig: CliConfig, hub: string): string {
    const keyless = Object.entries(hubConfig.profiles).filter(
      ([, p]) => !firstSet(p.apiKey) && sameInstance(firstSet(p.baseUrl) ?? DEFAULT_HUB_URL, hub)
    );
    const pick =
      keyless.find(([name]) => name === hubConfig.activeProfile) ??
      keyless.find(([name]) => name === CLOUD_PROFILE) ??
      keyless[0];
    return pick ? pick[0] : freshProfileName(hubConfig, hub, DEFAULT_HUB_URL);
  }

  /**
   * Write a login on the hub file, in one `updateConfig`: the key's own
   * fields on the named entry (a replacement, a re-sign-in), or on the entry
   * `entryFor` picks (a new login); whatever else the entry holds stays. The
   * hub is the caller's, the one its email code ran at: never read from the
   * entry as it stands at the write, which another command may have removed
   * meanwhile (a key of one hub is never filed under another). The hub file's
   * active login is set only when it held no profile at all. Answers the
   * entry's name.
   */
  function writeLogin(
    target: { name: string; hub: string } | { hub: string },
    completed: CliAuthCompleted
  ): string {
    let written = '';
    updateCoreConfig(io.env, HUB_TOOL, (hubConfig) => {
      const first = Object.keys(hubConfig.profiles).length === 0;
      const hub = target.hub;
      const name = 'name' in target ? target.name : entryFor(hubConfig, hub);
      const entry = hubConfig.profiles[name];
      hubConfig.profiles[name] = {
        ...entry,
        apiKey: completed.key,
        baseUrl: hub,
        email: completed.user.email,
        workspaceId: completed.workspaceId
      };
      if (first) hubConfig.activeProfile = name;
      written = name;
    });
    return written;
  }

  /**
   * `login --email <address>` at a hub that holds two logins (or more), neither of them that address,
   * and that the profile never used: the address cannot replace one of them unasked. The sentence names
   * each account once (one address is one account) and the profile the way the kit's other sentences
   * do: `--profile <name>` when it is on disk at the site, else `--api-url <site>`.
   */
  function notAmong(
    wanted: string,
    hub: string,
    candidates: CliLogin[],
    onDisk: string | undefined,
    site: string
  ): string {
    const accounts: CliLogin[] = [];
    for (const l of candidates) {
      if (!accounts.some((a) => a === l || sameAddress(a.email, l.email))) accounts.push(l);
    }
    const n = accounts.length;
    const flag = onDisk ? `--profile ${onDisk}` : `--api-url ${normalizeUrl(site)}`;
    return (
      `${wanted} is not signed in at ${hub}, which holds ${n === 2 ? 'two' : n} logins ` +
      `(${accounts.map((l) => firstSet(l.email) ?? '(no address)').join(', ')}). Run ${bin} ${flag} login ` +
      `--email with one of them, or sign one of them out first so that ${wanted} replaces it.`
    );
  }

  /** The login of one entry, as the hub file holds it now. */
  function loginNamed(name: string): CliLogin {
    const login = loginsNow().find((l) => l.name === name);
    if (!login) {
      throw new CliUsageError(
        `The Antasphere login "${name}" left the hub file while this command ran; try again.`
      );
    }
    return login;
  }

  /**
   * The login at `hub` that signs this profile in (R2's rule 3, ruling 3):
   * `--email` naming a login there, that one; naming another account than
   * the login there, that login REPLACED by the email code of the named
   * account (the line, the replaced hub key revoked at its own hub); no login
   * there, the email code and a new login. Two logins there that this
   * profile never used: cli-core's « pick one », or, with `--email` naming
   * neither of them, the kit's own sentence (`notAmong`). Never a guess.
   */
  async function loginAt(
    hub: string,
    site: string,
    here: CliProfile | undefined,
    profileName: string,
    opts: LoginOpts
  ): Promise<{ login: CliLogin; replaced: CliLogin | undefined }> {
    const logins = loginsNow();
    const wanted = firstSet(opts.email);
    const base = { hub, siteUrl: site, profile: here, logins, profileName, bin };
    const pick = chooseLogin({ ...base, ...(wanted ? { email: wanted } : {}) });
    if (pick.kind === 'login') return { login: pick.login, replaced: undefined };
    if (pick.kind === 'pick_login') throw new CliUsageError(pick.sentence);
    if (wanted) {
      const current = chooseLogin(base);
      if (current.kind === 'pick_login') {
        throw new CliUsageError(
          notAmong(wanted, hub, current.candidates, here ? profileName : undefined, site)
        );
      }
      if (current.kind === 'login') {
        const old = current.login;
        const had = firstSet(old.email);
        io.err.write(
          had
            ? `Replacing the Antasphere login ${had} with ${wanted}.\n`
            : `Signing in as ${wanted}: the stored Antasphere login carries no address.\n`
        );
        const completed = await hubEmailCode(hub, wanted, opts);
        writeLogin({ name: old.name, hub }, completed);
        // The replaced account's hub key dies at its own hub (best effort:
        // a dead one answers 401), so nothing is left live for it.
        const oldKey = firstSet(old.profile.apiKey);
        if (oldKey && oldKey !== completed.key)
          await authAt(old.hub)
            .revoke(oldKey)
            .catch(() => undefined);
        return { login: loginNamed(old.name), replaced: old };
      }
    }
    const completed = await hubEmailCode(hub, wanted, opts);
    return { login: loginNamed(writeLogin({ hub }, completed)), replaced: undefined };
  }

  /**
   * Revoke one key on a site (the profile's own, never another origin): what
   * the site answered; a 403 (the site refused the self-revoke: the key stays
   * valid) is said on stderr, and so is a 401 unless `quiet`. Anything else
   * throws.
   */
  async function revokeOnSite(site: string, key: string, what: string, quiet = false): Promise<RevokeAnswer> {
    try {
      await authAt(site).revoke(key);
      return 'revoked';
    } catch (e) {
      if (e instanceof CliAuthError && e.status === 401) {
        if (!quiet) io.err.write(`${what} was already unusable; forgetting it.\n`);
        return 'dead';
      }
      if (e instanceof CliAuthError && e.status === 403) {
        // The key WORKS but the site refused the self-revoke (an older site
        // whose machine allowlist predates DELETE /cli/auth/key). Never
        // report that as gone.
        io.err.write(
          `The instance refused to revoke ${what} (${e.code}): it STAYS VALID server-side; revoke it from ` +
            'the dashboard. Forgetting the local copy.\n'
        );
        return 'refused';
      }
      throw e;
    }
  }

  /** How a key of a profile reads in a sentence (never any part of the key). */
  function describeKey(key: ProfileKey): string {
    if (key.kind === 'own') return 'the profile key';
    if (key.kind === 'kept')
      return `the key kept for ${loginLabel({ email: key.email, hub: key.hub ?? '' })}`;
    return `the key kept for ${firstSet(key.email) ?? 'an unknown account'}`;
  }

  /** A profile's informational `email` goes with its own key. */
  function dropOwnEmail(profileName: string): void {
    updateConfig(io.env, (config) => {
      const profile = config.profiles[profileName];
      if (profile && !firstSet(profile.apiKey) && profile.email !== undefined) delete profile.email;
    });
  }

  /**
   * Before the exchange of a hub login: the profile's kept key for the
   * login's slot (a login is an explicit re-sign-in; cli-core would still
   * serve it) and the replaced account's are revoked on the profile's own
   * site with no lock held, then forgotten (compare-and-remove). A key the
   * site did not answer for stays; one another profile on disk still holds is
   * not revoked, only forgotten here, and said. The profile's own key is NOT
   * among them: it goes only once the exchange succeeded (`retireOwnKey`).
   */
  async function retireBeforeExchange(
    profileName: string,
    site: string,
    hub: string,
    login: CliLogin,
    replaced: CliLogin | undefined
  ): Promise<void> {
    const config = loadConfig(io.env);
    const profile = config.profiles[profileName];
    if (!profile || !sameInstance(profileUrl(profile), site)) return;
    const accounts = [login.email, replaced?.email];
    const slots = new Set([login.name, replaced?.name].filter((n): n is string => n !== undefined));
    const oldOfLogin = new Set(
      Object.entries(profile.connectKeys ?? {})
        .filter(([slot]) => slots.has(slot))
        .map(([, entry]) => firstSet(entry?.apiKey))
        .filter((k): k is string => k !== undefined)
    );
    const doomed = keysOfProfile(profile).filter(
      (k) =>
        (k.kind === 'kept' &&
          sameInstance(k.hub ?? '', hub) &&
          accounts.some((email) => sameAddress(k.email, email))) ||
        (k.kind === 'old' && oldOfLogin.has(k.apiKey))
    );
    if (doomed.length === 0) return;
    const elsewhere = keysHeldElsewhere(config, profileName, identity.cloudUrl);
    const forget: string[] = [];
    for (const key of doomed) {
      const other = elsewhere.get(key.apiKey);
      if (other) {
        sayKept(io, profileUrl(profile), other);
        forget.push(key.apiKey);
        continue;
      }
      try {
        await revokeOnSite(profileUrl(profile), key.apiKey, describeKey(key), true);
        forget.push(key.apiKey);
      } catch {
        // The site did not answer: the key stays for the next command.
      }
    }
    forgetKeys(io.env, identity.tool, profileName, forget);
    dropOwnEmail(profileName);
  }

  /** The profile's own key, when the profile is on disk at `site`. */
  function ownKeyAt(profileName: string, site: string): string | undefined {
    const profile = loadConfig(io.env).profiles[profileName];
    return profile && sameInstance(profileUrl(profile), site) ? firstSet(profile.apiKey) : undefined;
  }

  /**
   * Once the exchange of a hub login SUCCEEDED, and never before: the own key
   * the profile held when the exchange began (a sign-in through the hub
   * replaces it, PRDCT-3522) is revoked on the profile's own site with no
   * lock held, then forgotten compare-and-remove, with the address stored
   * beside it. An exchange that fails leaves it on the profile, alive; a key
   * the site did not answer for stays. A key another profile on disk still
   * holds is not revoked: it is forgotten here only, and said.
   */
  async function retireOwnKey(profileName: string, site: string, own: string | undefined): Promise<void> {
    if (!own) return;
    const other = keysHeldElsewhere(loadConfig(io.env), profileName, identity.cloudUrl).get(own.trim());
    if (other) {
      sayKept(io, site, other);
    } else {
      try {
        await revokeOnSite(site, own, 'the profile key', true);
      } catch {
        return;
      }
    }
    forgetKeys(io.env, identity.tool, profileName, [own]);
    dropOwnEmail(profileName);
  }

  /** The instance's own email-code sign-in (self-hosted): both legs in one command. */
  async function instanceLogin(
    baseUrl: string,
    opts: LoginOpts
  ): Promise<{ key: string; keyName: string; email: string }> {
    const auth = authAt(baseUrl);
    const email = opts.email ?? (await ask(io, 'Email: '));
    await auth.request({ email });
    io.err.write(`A sign-in code was sent to ${email} (if that account exists on ${baseUrl}).\n`);
    const otp = await ask(io, 'Code: ');
    const completed = await auth.complete({
      email,
      otp,
      ...(opts.keyName ? { keyName: opts.keyName } : {}),
      ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {})
    });
    return { key: completed.key, keyName: completed.apiKey.name, email: completed.user.email };
  }

  program
    .command('login')
    .description(
      'Sign in on a profile the way its site asks: through the Antasphere login at the hub the site names, ' +
        `with the site's own email code, or with a pasted ${identity.keyPrefix}_ key; the default profile ` +
        'moves only on a machine that has none'
    )
    .option('--email <email>', 'the account email (prompted when omitted)')
    .option('--hub <url>', 'the Antasphere hub to sign in at, for a site that names none')
    .option('--key-name <name>', 'display name for the key the sign-in mints')
    .option('--expires-in-days <n>', 'TTL in days of that key (default: never expires)', (v: string) =>
      parseInt(v, 10)
    )
    .action(async (opts: LoginOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals & { apiKey?: string };
      // A profile and a URL that name two sites, and an exported key of
      // another site, are refused here, before any request (resolveContext).
      const ctx = resolveContext(cmd, io);
      const profileName = ctx.profileName ?? CLOUD_PROFILE;
      const { baseUrl } = ctx;
      const site = normalizeUrl(baseUrl);
      const firstProfile = Object.keys(ctx.config.profiles).length === 0;

      // A pasted key: `--api-key`, `--api-key-stdin` (already spent in
      // index.ts; reuse that read). Verified before it is stored. A profile
      // key is NOT a paste: `login` on a profile that already holds one
      // re-runs the sign-in the person asked for. A paste is an act, never
      // the key variable a shell or a CI job happens to carry (verifier
      // round 1, F8).
      const pasted = globals.apiKey ?? stdinApiKey(io);
      if (pasted !== undefined) {
        if (!pasted.startsWith(`${identity.keyPrefix}_`)) {
          throw new CliUsageError(
            `That is not a ${identity.displayName} key: it should start with ${identity.keyPrefix}_.`
          );
        }
        const me = await createClient({ baseUrl, apiKey: pasted, fetch: fetchOf() }).me();
        const { path, madeDefault, replaced } = saveOwnKey(profileName, baseUrl, pasted, me.user.email);
        await retireReplaced(profileName, site, replaced);
        if (globals.json) {
          printJson(io, {
            profile: profileName,
            site,
            via: 'key',
            login: null,
            user: me.user,
            workspace: me.workspace,
            madeDefault,
            configPath: path
          });
        } else {
          io.out.write(
            `${signedInLine(me, baseUrl)}\nKey saved to profile "${profileName}" (${path}).\n${organizationsLine(me)}`
          );
        }
        sayDefault(profileName, madeDefault);
        return;
      }

      // How does the site sign in? Its discovery says, and the profile
      // remembers it (when it is on disk).
      const probe = await probeToolInstance(baseUrl, fetchOf());
      if (probe) rememberSite(io.env, identity.tool, profileName, probe, { cloudUrl: identity.cloudUrl });
      if (probe?.cloud) {
        // The hub: the one the site names, else --hub, ANTASPHERE_URL, the
        // hub of the profile's newest kept key; never a guess (cli-core).
        const onDisk = loadConfig(io.env).profiles[profileName];
        const here = onDisk && sameInstance(profileUrl(onDisk), site) ? onDisk : undefined;
        const chosen = chooseHub({
          siteUrl: site,
          siteHub: probe.hub,
          profile: here,
          logins: loginsNow(),
          hubUrl: firstSet(opts.hub),
          envHub: firstSet(io.env[HUB_URL_ENV]),
          profileName,
          bin
        });
        if (chosen.kind !== 'hub') throw new CliUsageError(chosen.sentence);
        const { hub } = chosen;
        const signedIn = await loginAt(hub, site, here, profileName, opts);
        let { login } = signedIn;
        await retireBeforeExchange(profileName, site, hub, login, signedIn.replaced);
        // The profile's own key as the exchange begins: it stays until the exchange succeeded.
        const ownKey = ownKeyAt(profileName, site);

        // The exchange, at that login's own hub, then the tool's own answer.
        // A stored hub key the hub no longer accepts is replaced by a fresh
        // sign-in at that hub, once.
        const exchange = () =>
          connect(ctx, { profileName, cached: false, hubUrl: hub, email: firstSet(login.email) });
        let outcome;
        try {
          outcome = await exchange();
        } catch (e) {
          if (!(e instanceof CoreUsageError) || !/rejected/.test(e.message)) throw e;
          io.err.write('The stored Antasphere login was rejected: signing in again.\n');
          const completed = await hubEmailCode(hub, firstSet(opts.email), opts);
          login = loginNamed(writeLogin({ name: login.name, hub }, completed));
          outcome = await exchange();
        }
        if (outcome.outcome === 'not_cloud') {
          throw new CliUsageError(`${baseUrl} stopped answering as an Antasphere-cloud instance; try again.`);
        }
        await retireOwnKey(profileName, site, ownKey);
        const me = await createClient({ baseUrl, apiKey: outcome.key, fetch: fetchOf() }).me();
        const madeDefault = firstProfile && loadConfig(io.env).activeProfile === profileName;
        if (globals.json) {
          printJson(io, {
            profile: profileName,
            site,
            via: 'login',
            login: { hub: outcome.login.hub, email: outcome.login.email },
            user: me.user,
            workspace: me.workspace,
            workspaces: me.workspaces,
            madeDefault,
            configPath: configPath(io.env)
          });
        } else {
          io.out.write(`${signedInLine(me, baseUrl)}\n${organizationsLine(me)}`);
        }
        sayDefault(profileName, madeDefault);
        return;
      }

      // A site that signs in by itself: its own email code, then its key on
      // the profile, named by the name the site gave it (never any part of it).
      const minted = await instanceLogin(baseUrl, opts);
      const me = await createClient({ baseUrl, apiKey: minted.key, fetch: fetchOf() }).me();
      const { path, madeDefault, replaced } = saveOwnKey(profileName, baseUrl, minted.key, minted.email);
      await retireReplaced(profileName, site, replaced);
      if (globals.json) {
        printJson(io, {
          profile: profileName,
          site,
          via: 'otp',
          login: null,
          user: me.user,
          workspace: me.workspace,
          keyName: minted.keyName,
          madeDefault,
          configPath: path
        });
      } else {
        io.out.write(
          `${signedInLine(me, baseUrl)}\nAPI key "${minted.keyName}" saved to profile "${profileName}" ` +
            `(${path}).\n${organizationsLine(me)}`
        );
      }
      sayDefault(profileName, madeDefault);
    });

  /**
   * The logins a profile's kept keys came from: each login in place at a
   * kept key's hub with its address, and the login an old slot is filed
   * under when it carries the slot's address. Each once.
   */
  function loginsBehind(profile: CliProfile, logins: CliLogin[]): CliLogin[] {
    const found: CliLogin[] = [];
    const add = (login: CliLogin): void => {
      if (!found.some((l) => l.name === login.name)) found.push(login);
    };
    for (const key of keysOfProfile(profile)) {
      if (key.kind !== 'kept') continue;
      for (const l of logins)
        if (sameInstance(l.hub, key.hub ?? '') && sameAddress(l.email, key.email)) add(l);
    }
    for (const [slot, entry] of Object.entries(profile.connectKeys ?? {})) {
      const l = logins.find((x) => x.name === slot);
      if (l && sameAddress(l.email, entry?.email)) add(l);
    }
    return found;
  }

  /**
   * `logout --all`: each login ended, its hub key revoked at its OWN hub,
   * then its entry deleted from the hub file (only while it still holds that
   * key), and the hub file's active login removed when it was that entry.
   */
  async function endLogins(
    logins: CliLogin[]
  ): Promise<Array<{ hub: string; email: string | null; revoked: boolean }>> {
    const ended: Array<{ hub: string; email: string | null; revoked: boolean }> = [];
    const gone: CliLogin[] = [];
    try {
      for (const login of logins) {
        const hubKey = firstSet(login.profile.apiKey) ?? '';
        let revoked = false;
        try {
          await authAt(login.hub).revoke(hubKey);
          revoked = true;
        } catch (e) {
          if (!(e instanceof CliAuthError && (e.status === 401 || e.status === 403))) throw e;
          io.err.write(`The Antasphere login ${loginLabel(login)} was already unusable; forgetting it.\n`);
        }
        gone.push(login);
        ended.push({ hub: login.hub, email: firstSet(login.email) ?? null, revoked });
      }
    } finally {
      if (gone.length > 0) {
        updateCoreConfig(io.env, HUB_TOOL, (hubConfig) => {
          for (const login of gone) {
            const entry = hubConfig.profiles[login.name];
            if (!entry || entry.apiKey !== login.profile.apiKey) continue;
            delete hubConfig.profiles[login.name];
            if (hubConfig.activeProfile === login.name) delete hubConfig.activeProfile;
          }
        });
      }
    }
    return ended;
  }

  program
    .command('logout')
    .description(
      'Sign out of the default (or named) profile: revokes every key it holds on its own site, then forgets ' +
        'them; with --all, also ends the Antasphere logins its kept keys came from'
    )
    .option(
      '--all',
      'also end the Antasphere logins this profile signed in with (revoked at their hubs)',
      false
    )
    .action(async (opts: { all: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const ctx = resolveContext(cmd, io);
      const profileName = ctx.profileName;
      const profile = profileName ? ctx.config.profiles[profileName] : undefined;
      if (!profileName || !profile) {
        // Nothing of this tool's on the machine. The Antasphere logins, when
        // there are some, are the family's, and none came from a profile of
        // this tool: they are named with the command that ends them.
        const logins = loginsNow();
        if (logins.length > 0) {
          const stay =
            logins.length === 1
              ? `The Antasphere login ${loginLabel(logins[0]!)} stays for the whole tool family: ` +
                '`antasphere logout` ends it.'
              : `The Antasphere logins ${logins.map(loginLabel).join(', ')} stay for the whole tool family: ` +
                '`antasphere logout` ends them.';
          throw new CliUsageError(
            `Nothing of ${identity.displayName}'s to sign out of on this machine. ${stay}`
          );
        }
        throw new CliUsageError('No profile to log out of.');
      }
      // Every key is revoked on the site the PROFILE is, never on a flag/env
      // URL: a key must not travel to a different site, not even to die (a
      // foreign host would see the key AND the real one would survive while
      // we report it gone). The lock is never held across the network: the
      // keys are read, revoked, then forgotten compare-and-remove. A key
      // another profile on disk still holds is not revoked: it is forgotten
      // on this profile only, and said.
      const baseUrl = profileUrl(profile);
      const keys = keysOfProfile(profile);
      const elsewhere = keysHeldElsewhere(ctx.config, profileName, identity.cloudUrl);
      const behind = loginsBehind(profile, loginsNow());
      let revoked = 0;
      let refused = 0;
      const done: string[] = [];
      try {
        for (const key of keys) {
          const other = elsewhere.get(key.apiKey);
          if (other) {
            sayKept(io, baseUrl, other);
          } else {
            const answer = await revokeOnSite(baseUrl, key.apiKey, describeKey(key));
            if (answer === 'revoked') revoked += 1;
            if (answer === 'refused') refused += 1;
          }
          done.push(key.apiKey);
        }
      } finally {
        forgetKeys(io.env, identity.tool, profileName, done);
        dropOwnEmail(profileName);
      }
      const ended = opts.all ? await endLogins(behind) : null;
      if (globals.json) {
        return printJson(io, {
          profile: profileName,
          baseUrl,
          revoked,
          refused,
          forgotten: true,
          ...(ended ? { logins: ended } : {})
        });
      }
      const hubLine = ended
        ? ended.length > 0
          ? ended
              .map(
                (l) =>
                  ` The Antasphere login ${loginLabel({ email: l.email ?? undefined, hub: l.hub })} is ` +
                  `${l.revoked ? 'revoked and ' : ''}forgotten.`
              )
              .join('')
          : ' No Antasphere login to end.'
        : behind.length === 1
          ? ` The Antasphere login ${loginLabel(behind[0]!)} stays for the whole tool family.`
          : behind.length > 1
            ? ` The Antasphere logins ${behind.map(loginLabel).join(', ')} stay for the whole tool family.`
            : '';
      if (keys.length === 0) {
        io.out.write(`Profile "${profileName}" held no key.${hubLine}\n`);
        return;
      }
      io.out.write(
        `Logged out of profile "${profileName}" on ${baseUrl}` +
          (revoked > 0 ? ` (${revoked} key${revoked === 1 ? '' : 's'} revoked server-side)` : '') +
          (refused > 0
            ? ` — ${refused} key${refused === 1 ? '' : 's'} could NOT be revoked and stay valid`
            : '') +
          `.${hubLine}\n`
      );
    });

  program
    .command('whoami')
    .description('Show the identity behind the resolved credential, and where it came from')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const me = await ctx.client.me();
      // `me` is the answer WITH the selection applied, so its workspace is
      // the one this command (and any other, same flags) really ran in.
      const source = workspaceSource(ctx);
      if (ctx.json) {
        return printJson(io, {
          ...me,
          workspaceSource: source,
          credentialSource: ctx.credentialSource,
          profile: ctx.profileName ?? null,
          login: ctx.login
        });
      }
      const active = me.workspace ? me.workspaces.find((w) => w.id === me.workspace!.id) : undefined;
      const org = active && (active as { centralAccountId?: string | null }).centralAccountId;
      io.out.write(
        `${me.user.name} <${me.user.email}>\n` +
          `  instance:  ${ctx.baseUrl} (profile "${ctx.profileName ?? '-'}")\n` +
          // A key is a USER credential: with zero memberships /me can carry
          // no active workspace (the CLI only ever sees this for sessions,
          // but the wire shape is honest about it).
          `  workspace: ${me.workspace ? `${me.workspace.name} (${me.workspace.id})` : '(none)'}\n` +
          (org ? `  organization: ${org}\n` : '') +
          `  chosen by: ${describeSource(source, ctx.workspaceSelection?.kind)}\n` +
          `  signed in with: ${describeCredential(ctx)}\n` +
          `  role:      ${me.role ?? '(none)'} (via ${me.via})\n` +
          `  scopes:    ${me.scopes ? me.scopes.join(', ') : 'full (session)'}\n` +
          (me.via === 'api_key' ? `  key expires: ${me.apiKeyExpiresAt ?? 'never'}\n` : '')
      );
    });

  program
    .command('verify')
    .description('Check that the resolved instance + key work (exit 0 = ok)')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const me = await ctx.client.me();
      if (ctx.json) return printJson(io, { ok: true, baseUrl: ctx.baseUrl, user: me.user });
      io.out.write(`ok — ${me.user.email} (${me.role}) @ ${ctx.baseUrl}\n`);
    });

  program
    .command('use <profile>')
    .description('Switch the default profile (the site the commands run against)')
    .action(async (name: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      let chosen = name;
      const { config } = updateConfig(io.env, (draft) => {
        if (!draft.profiles[name]) {
          // One profile per site (R3): `use cloud` selects the profile already
          // at the cloud site, whatever its name. With none there, the
          // implicit cloud profile exists before anything is written (`cloud`,
          // or its host when that name is taken elsewhere): it is made a row
          // so it can be the active one.
          const atCloud = selectProfile({
            config: draft,
            apiUrl: identity.cloudUrl,
            cloudUrl: identity.cloudUrl
          });
          if (name === CLOUD_PROFILE && !atCloud.created && atCloud.name) {
            chosen = atCloud.name;
          } else if (atCloud.created && atCloud.name === name) {
            draft.profiles[name] = { baseUrl: normalizeUrl(identity.cloudUrl) };
          } else {
            throw new CliUsageError(`Unknown profile "${name}" — run \`${bin} profiles\`.`);
          }
        }
        draft.activeProfile = chosen;
      });
      if (globals.json) return printJson(io, { activeProfile: chosen });
      io.out.write(`Active profile: ${chosen} (${profileUrl(config.profiles[chosen])})\n`);
    });
}

/**
 * `config show` and `config clear`, registered after `profiles`
 * (`commands/profiles.ts`) so the top-level commands keep their order.
 */
export function registerConfigCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { clearConfig, configPath, identity, loadConfig, profileUrl } = kit;

  const config = program.command('config').description('Inspect or reset the CLI config file');

  config
    .command('show')
    .description('Show the config path, the default profile, and what each profile holds (never a key)')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const cfg = loadConfig(io.env);
      const path = configPath(io.env);
      // No key material, redacted or not (decision 4): what each profile is
      // (its site) and what it holds, by kind. The default is the listing's
      // (the active profile, else the one at the cloud URL, else the implicit
      // cloud row), so the two never disagree.
      const shown = {
        path,
        defaultProfile: selectProfile({ config: cfg, cloudUrl: identity.cloudUrl }).name ?? null,
        profiles: Object.fromEntries(
          Object.entries(cfg.profiles).map(([n, p]) => {
            const keys = keysOfProfile(p);
            return [
              n,
              {
                site: normalizeUrl(profileUrl(p)),
                ownKey: keys.some((k) => k.kind === 'own'),
                keptKeys: keys
                  .filter((k) => k.kind === 'kept')
                  .map((k) => ({ hub: k.hub ?? null, email: k.email ?? null })),
                oldSlots: keys.filter((k) => k.kind === 'old').length
              }
            ];
          })
        )
      };
      if (globals.json) return printJson(io, shown);
      io.out.write(`config: ${path ?? '(no HOME/XDG_CONFIG_HOME — config disabled)'}\n`);
      io.out.write(`${JSON.stringify(shown, null, 2)}\n`);
    });

  config
    .command('clear')
    .description('Delete the config file (all profiles and stored keys)')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      clearConfig(io.env);
      if (globals.json) return printJson(io, { cleared: true });
      io.out.write('Config cleared.\n');
    });
}
