import type { Command } from 'commander';
import {
  activeHubProfile,
  ask,
  CliAuthClient,
  CliAuthError,
  CliUsageError as CoreUsageError,
  CLOUD_PROFILE,
  connectOnDemand,
  HUB_TOOL,
  loadConfig as loadCoreConfig,
  normalizeUrl,
  probeToolInstance,
  resolveBaseUrl,
  sameInstance,
  selectProfile,
  saveConfig as saveCoreConfig,
  type CliProfile
} from '@antasphere/cli-core';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import { redactKey } from '../config.js';
import {
  CliUsageError,
  printJson,
  stdinApiKey,
  table,
  type CliContext,
  type CliIo,
  type CredentialSource
} from '../context.js';
import type { CliKit } from '../kit.js';
import type { MeResponse } from '../workspace.js';

/**
 * Identity + profile commands (PRDCT-2947, PRDCT-2446): ONE `login` that
 * ends in the tool, `logout` that revokes what it forgets, whoami/verify,
 * and profile management (use / profiles / config show / config clear).
 *
 * A profile is an instance (cli-core 0.5.0): `login` with no URL signs in
 * on the profile the run selects (the active one, else the implicit `cloud`
 * profile at the tool's cloud URL); `--api-url <url>` selects or creates the
 * profile of that instance, named for its host. On an Antasphere-cloud
 * instance the login is the hub's email code (once, stored on the hub
 * profile exactly as `antasphere login` stores it), then the exchange that
 * mints the tool's own key; on a self-hosted instance it is the instance's
 * email code, or a pasted key.
 */

/** The hub a tool CLI signs in against inline: the same variable the hub CLI reads. */
const HUB_URL_ENV = 'ANTASPHERE_URL';
const DEFAULT_HUB_URL = 'https://account.antasphere.com';

interface AuthGlobals {
  apiUrl?: string;
  url?: string;
  profile?: string;
  json?: boolean;
}

interface LoginOpts {
  email?: string;
  keyName?: string;
  expiresInDays?: number;
}

/** How a signed-in credential reads in a sentence. */
function describeCredential(source: CredentialSource, profileName: string | undefined): string {
  switch (source) {
    case 'flag':
      return 'the --api-key flag';
    case 'env':
      return 'the API key variable';
    case 'profile':
      return profileName ? `the key of profile "${profileName}"` : 'the profile key';
    case 'hub-cache':
      return 'the Antasphere login (cached key)';
    case 'hub-exchange':
      return 'the Antasphere login (fresh exchange)';
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

export function registerAuthCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const {
    identity,
    createClient,
    clearConfig,
    configPath,
    connectOptions,
    loadConfig,
    profileUrl,
    removeConnectKey,
    requireApiKey,
    resolveContext,
    saveConfig,
    workspaceSource
  } = kit;
  const { describeSource } = kit.workspace;

  /** Save the tool's own key on a profile and make that profile the active one. */
  function saveProfileKey(
    profileName: string,
    baseUrl: string,
    apiKey: string,
    email: string | undefined
  ): string {
    const config = loadConfig(io.env);
    const previous = config.profiles[profileName];
    config.profiles[profileName] = {
      ...previous,
      apiKey,
      baseUrl: normalizeUrl(baseUrl),
      ...(email ? { email } : {})
    };
    config.activeProfile = profileName;
    return saveConfig(io.env, config);
  }

  /** `login` makes its profile the active one: a login is the choice of where the next command runs. */
  function activate(profileName: string, baseUrl: string): string {
    const config = loadConfig(io.env);
    config.profiles[profileName] = { ...config.profiles[profileName], baseUrl: normalizeUrl(baseUrl) };
    config.activeProfile = profileName;
    return saveConfig(io.env, config);
  }

  /**
   * The hub's email-code sign-in, inline: the wire `antasphere login` speaks
   * (cli-core's instance auth client against the hub), the key written on the
   * hub profile exactly as that CLI writes it, so the two logins are one.
   */
  async function hubLogin(opts: LoginOpts): Promise<{ email: string; profile: string }> {
    // The hub profile the hub CLI would use, resolved its way (verifier
    // round 1, F4): ANTASPHERE_URL selects the profile of that hub, else the
    // active one, else the implicit `cloud` at account.antasphere.com; the
    // URL is the variable, else that profile's own, else the default. A
    // stored hub URL is never repointed at the production hub.
    const hubConfig = loadCoreConfig(io.env, HUB_TOOL);
    const selected = selectProfile({
      config: hubConfig,
      apiUrl: io.env[HUB_URL_ENV],
      cloudUrl: DEFAULT_HUB_URL
    });
    const profile = selected.name ?? CLOUD_PROFILE;
    const hubUrl = resolveBaseUrl({
      env: io.env,
      envVar: HUB_URL_ENV,
      profile: selected.profile,
      cloudUrl: DEFAULT_HUB_URL
    });
    const auth = new CliAuthClient({ baseUrl: hubUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
    const email = opts.email ?? (await ask(io, 'Antasphere email: '));
    await auth.request({ email });
    io.err.write(`A sign-in code was sent to ${email} (if that Antasphere account can receive mail).\n`);
    const otp = await ask(io, 'Code: ');
    const completed = await auth.complete({
      email,
      otp,
      ...(opts.keyName ? { keyName: opts.keyName } : {}),
      ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {})
    });
    // Only the key's own fields move, exactly as `antasphere login` writes
    // them; whatever else the profile holds stays.
    const fresh = loadCoreConfig(io.env, HUB_TOOL);
    fresh.profiles[profile] = {
      ...fresh.profiles[profile],
      apiKey: completed.key,
      baseUrl: hubUrl,
      email: completed.user.email,
      workspaceId: completed.workspaceId
    };
    fresh.activeProfile = profile;
    saveCoreConfig(io.env, HUB_TOOL, fresh);
    return { email: completed.user.email, profile };
  }

  /** The instance's own email-code sign-in (self-hosted): both legs in one command. */
  async function instanceLogin(
    baseUrl: string,
    opts: LoginOpts
  ): Promise<{ key: string; keyName: string; email: string }> {
    const auth = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
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
      `Sign in: on the cloud through your Antasphere account, on a self-hosted instance with an email code ` +
        `or a pasted ${identity.keyPrefix}_ key; saves the profile and makes it the active one`
    )
    .option('--email <email>', 'the account email (prompted when omitted)')
    .option('--key-name <name>', 'display name for the key the sign-in mints')
    .option('--expires-in-days <n>', 'TTL in days of that key (default: never expires)', (v: string) =>
      parseInt(v, 10)
    )
    .action(async (opts: LoginOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals & { apiKey?: string };
      const ctx = resolveContext(cmd, io);
      const profileName = ctx.profileName ?? CLOUD_PROFILE;
      const { baseUrl } = ctx;
      // A profile is an instance, and a login never repoints one (verifier
      // round 2, F9): a saved profile named with --profile while --api-url
      // (or the URL variable) names another instance is refused before any
      // request, so no key of that profile ever travels to the other origin.
      const saved = ctx.config.profiles[profileName];
      if (saved && !sameInstance(profileUrl(saved), baseUrl)) {
        throw new CliUsageError(
          `Profile "${profileName}" is the instance ${profileUrl(saved)}, and this login targets ${baseUrl}. ` +
            `Drop --profile to sign in on the profile of ${baseUrl}, or drop --api-url to sign in on "${profileName}".`
        );
      }

      // A pasted key: `--api-key`, `--api-key-stdin` (already spent in
      // index.ts; reuse that read), or the key variable. Verified before it
      // is stored. A profile key is NOT a paste: `login` on a profile that
      // already holds one re-runs the sign-in the person asked for.
      // A paste is an act: `--api-key` or `--api-key-stdin`, never the key
      // variable a shell or a CI job happens to carry (verifier round 1, F8).
      const pasted = globals.apiKey ?? stdinApiKey(io);
      if (pasted !== undefined) {
        if (!pasted.startsWith(`${identity.keyPrefix}_`)) {
          throw new CliUsageError(
            `That is not a ${identity.displayName} key: it should start with ${identity.keyPrefix}_.`
          );
        }
        const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
        const me = await createClient({ baseUrl, apiKey: pasted, fetch: fetchImpl }).me();
        const path = saveProfileKey(profileName, baseUrl, pasted, me.user.email);
        if (globals.json) {
          return printJson(io, {
            profile: profileName,
            baseUrl,
            via: 'key',
            user: me.user,
            workspace: me.workspace,
            configPath: path
          });
        }
        io.out.write(
          `${signedInLine(me, baseUrl)}\nKey saved to profile "${profileName}" (${path}).\n${organizationsLine(me)}`
        );
        return;
      }

      // Cloud or self-hosted? Discovery says (the same probe as connect-on-demand).
      const probe = await probeToolInstance(baseUrl, io.fetch);
      if (probe?.cloud) {
        // The hub login, once: stored on the hub profile as `antasphere login`
        // stores it, so every other tool CLI is signed in too.
        let hub = activeHubProfile(io.env);
        if (!hub.profile?.apiKey) await hubLogin(opts);
        // A login is an explicit re-sign-in (verifier round 1, F3): the key
        // cached on this profile is revoked on its instance (best effort: a
        // dead one answers 401) and forgotten, and the exchange runs afresh,
        // so a stale cached key never survives a login.
        hub = activeHubProfile(io.env);
        const stale = hub.name
          ? loadConfig(io.env).profiles[profileName]?.connectKeys?.[hub.name]
          : undefined;
        if (stale && hub.name) {
          // Revoked on the instance the key was minted for, the profile's own
          // (the same rule as logout), never on a flag URL.
          const auth = new CliAuthClient({
            baseUrl: profileUrl(loadConfig(io.env).profiles[profileName]),
            ...(io.fetch ? { fetch: io.fetch } : {})
          });
          await auth.revoke(stale.apiKey).catch(() => undefined);
          removeConnectKey(io.env, profileName, hub.name);
        }
        // The exchange, then the tool's own answer. A stored hub key the hub
        // no longer accepts is replaced by a fresh sign-in, once.
        let outcome;
        try {
          outcome = await connectOnDemand({ ...connectOptions(ctx), profileName, cached: false });
        } catch (e) {
          if (!(e instanceof CoreUsageError) || !/rejected/.test(e.message)) throw e;
          io.err.write('The stored Antasphere login was rejected: signing in again.\n');
          await hubLogin(opts);
          hub = activeHubProfile(io.env);
          outcome = await connectOnDemand({ ...connectOptions(ctx), profileName, cached: false });
        }
        if (outcome.outcome === 'not_cloud') {
          throw new CliUsageError(`${baseUrl} stopped answering as an Antasphere-cloud instance; try again.`);
        }
        const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
        const me = await createClient({ baseUrl, apiKey: outcome.key, fetch: fetchImpl }).me();
        const path = activate(profileName, baseUrl);
        if (globals.json) {
          return printJson(io, {
            profile: profileName,
            baseUrl,
            via: 'antasphere',
            hubProfile: hub.name ?? CLOUD_PROFILE,
            user: me.user,
            workspace: me.workspace,
            workspaces: me.workspaces,
            configPath: path
          });
        }
        io.out.write(`${signedInLine(me, baseUrl)}\n${organizationsLine(me)}`);
        return;
      }

      // Self-hosted: the instance's own email code, then its key on the profile.
      const minted = await instanceLogin(baseUrl, opts);
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const me = await createClient({ baseUrl, apiKey: minted.key, fetch: fetchImpl }).me();
      const path = saveProfileKey(profileName, baseUrl, minted.key, minted.email);
      if (globals.json) {
        // The full key is deliberately NOT echoed — it is already stored.
        return printJson(io, {
          profile: profileName,
          baseUrl,
          via: 'otp',
          user: me.user,
          workspace: me.workspace,
          keyName: minted.keyName,
          configPath: path
        });
      }
      io.out.write(
        `${signedInLine(me, baseUrl)}\nAPI key "${minted.keyName}" (${redactKey(minted.key)}) saved to profile ` +
          `"${profileName}" (${path}).\n${organizationsLine(me)}`
      );
    });

  program
    .command('logout')
    .description(
      'Sign out of the active (or named) profile: revokes every key it holds on the instance, then forgets them'
    )
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const ctx = resolveContext(cmd, io);
      const profileName = ctx.profileName;
      const profile = profileName ? ctx.config.profiles[profileName] : undefined;
      if (!profileName || !profile) {
        throw new CliUsageError('No profile to log out of.');
      }
      // Every key is revoked on the instance the PROFILE names, never on a
      // flag/env URL: a key must not travel to a different instance, not
      // even to die (a foreign host would see the key AND the real one would
      // survive while we report it gone).
      const baseUrl = profileUrl(profile);
      const auth = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
      let revoked = 0;
      let refused = 0;
      const revoke = async (key: string, what: string): Promise<void> => {
        try {
          await auth.revoke(key);
          revoked += 1;
        } catch (e) {
          if (e instanceof CliAuthError && e.status === 401) {
            io.err.write(`${what} was already unusable; forgetting it.\n`);
          } else if (e instanceof CliAuthError && e.status === 403) {
            // The key WORKS but the instance refused the self-revoke (an
            // older instance whose machine allowlist predates DELETE
            // /cli/auth/key). Never report that as gone.
            refused += 1;
            io.err.write(
              `The instance refused to revoke ${what} (${e.code}): it STAYS VALID server-side; revoke it from ` +
                'the dashboard. Forgetting the local copy.\n'
            );
          } else {
            throw e;
          }
        }
      };
      const slots = Object.entries(profile.connectKeys ?? {});
      for (const [slot, entry] of slots) {
        await revoke(entry.apiKey, `the key of the Antasphere login "${slot}"`);
        removeConnectKey(io.env, profileName, slot);
      }
      if (profile.apiKey) await revoke(profile.apiKey, 'the profile key');
      const config = loadConfig(io.env);
      const current = config.profiles[profileName];
      if (current) {
        delete current.apiKey;
        delete current.email;
        saveConfig(io.env, config);
      }
      if (globals.json) {
        return printJson(io, {
          profile: profileName,
          baseUrl,
          revoked,
          refused,
          hubProfiles: slots.map(([slot]) => slot),
          forgotten: true
        });
      }
      if (revoked === 0 && slots.length === 0 && !profile.apiKey) {
        io.out.write(`Profile "${profileName}" held no key.\n`);
        return;
      }
      io.out.write(
        `Logged out of profile "${profileName}" on ${baseUrl}` +
          (revoked > 0 ? ` (${revoked} key${revoked === 1 ? '' : 's'} revoked server-side)` : '') +
          (refused > 0
            ? ` — ${refused} key${refused === 1 ? '' : 's'} could NOT be revoked and stay valid`
            : '') +
          '.\n'
      );
    });

  program
    .command('whoami')
    .description('Show the identity behind the resolved API key, and where it came from')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const me = await ctx.client.me();
      // `me` is the answer WITH the selection applied, so its workspace is
      // the one this command (and any other, same flags) really ran in.
      const source = workspaceSource(ctx);
      const hub = activeHubProfile(io.env);
      const hubLine = hubLoginLine(ctx, hub.profile);
      if (ctx.json) {
        return printJson(io, {
          ...me,
          workspaceSource: source,
          credentialSource: ctx.credentialSource,
          profile: ctx.profileName ?? null,
          hubLogin: hub.profile?.apiKey ? { profile: hub.name, email: hub.profile.email ?? null } : null
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
          `  signed in with: ${describeCredential(ctx.credentialSource, ctx.profileName)}\n` +
          (hubLine ? `  Antasphere login: ${hubLine}\n` : '') +
          `  role:      ${me.role ?? '(none)'} (via ${me.via})\n` +
          `  scopes:    ${me.scopes ? me.scopes.join(', ') : 'full (session)'}\n` +
          (me.via === 'api_key' ? `  key expires: ${me.apiKeyExpiresAt ?? 'never'}\n` : '')
      );
    });

  /**
   * `whoami`'s line about the hub login: which one served, or why the stored
   * one was NOT used (a direct key won, the profile names another instance),
   * or that none exists where one would serve (the cloud profile).
   */
  function hubLoginLine(ctx: CliContext<TClient>, hub: CliProfile | undefined): string | null {
    const stored = hub?.apiKey ? (hub.email ?? 'stored') : null;
    if (ctx.credentialSource === 'hub-cache' || ctx.credentialSource === 'hub-exchange') {
      return stored ?? 'used';
    }
    if (stored) {
      const reason =
        ctx.credentialSource === 'flag' ||
        ctx.credentialSource === 'env' ||
        ctx.credentialSource === 'profile'
          ? `not used: ${describeCredential(ctx.credentialSource, ctx.profileName)} wins`
          : 'not used';
      return `${stored} (${reason})`;
    }
    const onCloud = ctx.profileName === CLOUD_PROFILE || ctx.baseUrl === normalizeUrl(identity.cloudUrl);
    return onCloud ? `not connected (run \`${identity.bin} login\`)` : null;
  }

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
    .description('Switch the active profile (the instance the commands run against)')
    .action(async (name: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      if (!config.profiles[name]) {
        if (name !== CLOUD_PROFILE) {
          throw new CliUsageError(`Unknown profile "${name}" — run \`${identity.bin} profiles\`.`);
        }
        // The implicit cloud profile exists before anything is written: `use
        // cloud` makes it a row so it can be the active one.
        config.profiles[name] = { baseUrl: normalizeUrl(identity.cloudUrl) };
      }
      config.activeProfile = name;
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { activeProfile: name });
      io.out.write(`Active profile: ${name} (${profileUrl(config.profiles[name])})\n`);
    });

  program
    .command('profiles')
    .description('List the profiles (one per instance) and how each signs in')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      const hub = activeHubProfile(io.env);
      // The implicit cloud profile is listed even before it is on disk: it is
      // where a clean machine runs, and where `login` with no URL signs in.
      const rows: Array<[string, CliProfile]> = Object.entries(config.profiles);
      if (!config.profiles[CLOUD_PROFILE])
        rows.unshift([CLOUD_PROFILE, { baseUrl: normalizeUrl(identity.cloudUrl) }]);
      const activeName = config.activeProfile ?? CLOUD_PROFILE;
      const credentialOf = (p: CliProfile): { kind: 'key' | 'hub' | 'none'; text: string } => {
        if (p.apiKey) return { kind: 'key', text: redactKey(p.apiKey) };
        const entry = hub.name ? p.connectKeys?.[hub.name] : undefined;
        if (entry) return { kind: 'hub', text: `via Antasphere${entry.email ? ` (${entry.email})` : ''}` };
        const others = Object.keys(p.connectKeys ?? {});
        if (others.length > 0)
          return { kind: 'hub', text: `via Antasphere (login "${others.join('", "')}", not the active one)` };
        return { kind: 'none', text: '(not signed in)' };
      };
      if (globals.json) {
        return printJson(io, {
          activeProfile: activeName,
          hubProfile: hub.name ?? null,
          profiles: Object.fromEntries(
            rows.map(([n, p]) => {
              const cred = credentialOf(p);
              return [
                n,
                {
                  baseUrl: profileUrl(p),
                  saved: Boolean(config.profiles[n]),
                  credential: cred.kind,
                  apiKey: p.apiKey ? redactKey(p.apiKey) : null,
                  email: p.email ?? (hub.name ? (p.connectKeys?.[hub.name]?.email ?? null) : null),
                  hubProfiles: Object.keys(p.connectKeys ?? {})
                }
              ];
            })
          )
        });
      }
      io.out.write(
        table(rows.map(([n, p]) => [activeName === n ? '*' : ' ', n, profileUrl(p), credentialOf(p).text]))
      );
    });

  const config = program.command('config').description('Inspect or reset the CLI config file');

  config
    .command('show')
    .description('Show the config path, active profile, and redacted keys')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const cfg = loadConfig(io.env);
      const path = configPath(io.env);
      const redacted = {
        path,
        activeProfile: cfg.activeProfile ?? null,
        profiles: Object.fromEntries(
          Object.entries(cfg.profiles).map(([n, p]) => [
            n,
            {
              baseUrl: profileUrl(p),
              apiKey: p.apiKey ? redactKey(p.apiKey) : null,
              email: p.email ?? null,
              // Hub-connected keys (one per hub profile), redacted like the rest.
              connectKeys: Object.fromEntries(
                Object.entries(p.connectKeys ?? {}).map(([slot, entry]) => [slot, redactKey(entry.apiKey)])
              )
            }
          ])
        )
      };
      if (globals.json) return printJson(io, redacted);
      io.out.write(`config: ${path ?? '(no HOME/XDG_CONFIG_HOME — config disabled)'}\n`);
      io.out.write(`${JSON.stringify(redacted, null, 2)}\n`);
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
