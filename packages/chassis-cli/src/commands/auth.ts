import type { Command } from 'commander';
import { CliAuthClient, CliAuthError } from '@antasphere/cli-core';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import { redactKey, type CliConfig } from '../config.js';
import { CliUsageError, printJson, stdinApiKey, table, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';
import { readSecretFromStdin } from '../stdin.js';

/**
 * Identity + profile commands: the OTP sign-in pair (login-request /
 * login-complete), key paste (login), whoami/verify, and profile management
 * (use / profiles / logout / config show / config clear).
 */

const DEFAULT_PROFILE = 'default';

interface AuthGlobals {
  apiUrl?: string;
  url?: string;
  profile?: string;
  json?: boolean;
}

/** URL for the pre-auth commands: flags → env only (no profile requirement). */
function resolveAuthUrl<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  cmd: Command,
  io: CliIo
): string {
  const { identity, loadConfig } = kit;
  const opts = cmd.optsWithGlobals() as AuthGlobals;
  const config = loadConfig(io.env);
  const profileName = opts.profile ?? config.activeProfile;
  const profile = profileName ? config.profiles[profileName] : undefined;
  const raw = opts.apiUrl ?? opts.url ?? io.env[`${identity.envPrefix}_URL`] ?? profile?.baseUrl;
  if (!raw) {
    throw new CliUsageError(
      `No instance to talk to — pass --api-url <url> (or set ${identity.envPrefix}_URL).`
    );
  }
  return raw.replace(/\/+$/, '');
}

function saveProfileKey<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  io: CliIo,
  profileName: string,
  baseUrl: string,
  apiKey: string
): { config: CliConfig; path: string } {
  const { loadConfig, saveConfig } = kit;
  const config = loadConfig(io.env);
  const previous = config.profiles[profileName];
  config.profiles[profileName] = { ...previous, apiKey, baseUrl };
  // A saved workspace selection is an id of ONE instance: a login that
  // moves the profile to another instance must not carry it along.
  if (previous?.baseUrl !== undefined && previous.baseUrl.replace(/\/+$/, '') !== baseUrl) {
    delete config.profiles[profileName]!.activeWorkspaceId;
  }
  config.activeProfile = profileName;
  const path = saveConfig(io.env, config);
  return { config, path };
}

/**
 * Cloud instances are hub-only (D1): the tool's own OTP entrances refuse
 * there (403 cli_otp_disabled), so ask discovery FIRST — the same
 * unauthenticated GET /instance probe (and the same cloud test) as the
 * connect-on-demand seam in context.ts — and steer to `antasphere login`
 * instead of mailing a dead code or printing the server's raw refusal.
 * Discovery failing (unreachable host, older instance) falls through: the
 * classic flow then reports its own, real error. Self-host instances are
 * untouched beyond the probe.
 */
async function refuseOtpLoginOnCloud<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  baseUrl: string,
  io: CliIo
): Promise<void> {
  const { identity, createClient } = kit;
  let cloud = false;
  try {
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    const info = await createClient({ baseUrl, fetch: fetchImpl }).instance();
    cloud = info.auth.methods.includes('antasphere') || info.edition === 'cloud';
  } catch {
    return; // discovery is advisory — never block the classic flow on it
  }
  if (cloud) {
    throw new CliUsageError(
      `${baseUrl} is an Antasphere-cloud instance — it signs in at the hub, not with its own ` +
        `email codes. Run \`antasphere login\` once; \`${identity.bin}\` then connects automatically ` +
        `(or pass --api-key <${identity.keyPrefix}_…> / set ${identity.envPrefix}_API_KEY).`
    );
  }
}

/** Logout's last step on the hub-connect path: the saved selection goes with the identity. */
function forgetWorkspaceSelection<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  io: CliIo,
  profileName: string
): void {
  const { loadConfig, saveConfig } = kit;
  const config = loadConfig(io.env);
  const profile = config.profiles[profileName];
  if (!profile || profile.activeWorkspaceId === undefined) return;
  delete profile.activeWorkspaceId;
  saveConfig(io.env, config);
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
    loadConfig,
    removeConnectKey,
    requireApiKey,
    resolveContext,
    saveConfig,
    workspaceSource
  } = kit;
  const { describeSource } = kit.workspace;

  const auth = program.command('auth').description('Sign in over email OTP (mints an API key)');

  auth
    .command('login-request')
    .description('Email a 6-digit sign-in code (existing accounts only — sign-up stays closed)')
    .requiredOption('--email <email>', 'account email on the instance')
    .action(async (opts: { email: string }, cmd: Command) => {
      const baseUrl = resolveAuthUrl(kit, cmd, io);
      await refuseOtpLoginOnCloud(kit, baseUrl, io);
      // The OTP pair rides cli-core's instance auth client — the same
      // plumbing every Antasphere tool CLI signs in with.
      const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
      const result = await client.request({ email: opts.email });
      const json = Boolean((cmd.optsWithGlobals() as AuthGlobals).json);
      if (json) return printJson(io, { ...result, email: opts.email, baseUrl });
      io.out.write(
        `If ${opts.email} has an account on ${baseUrl}, a sign-in code is on its way.\n` +
          `Complete with: ${identity.bin} auth login-complete --email ${opts.email} --code <code>\n`
      );
    });

  auth
    .command('login-complete')
    .description('Verify the emailed code; stores the minted API key as a profile')
    .requiredOption('--email <email>', 'the email the code was sent to')
    .requiredOption('--code <code>', 'the 6-digit code from the email')
    .option('--key-name <name>', 'display name for the minted API key')
    .option('--expires-in-days <n>', 'key TTL in days (default: never expires)', (v: string) =>
      parseInt(v, 10)
    )
    .action(
      async (
        opts: { email: string; code: string; keyName?: string; expiresInDays?: number },
        cmd: Command
      ) => {
        const globals = cmd.optsWithGlobals() as AuthGlobals;
        const baseUrl = resolveAuthUrl(kit, cmd, io);
        await refuseOtpLoginOnCloud(kit, baseUrl, io);
        const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
        const result = await client.complete({
          email: opts.email,
          otp: opts.code,
          ...(opts.keyName ? { keyName: opts.keyName } : {}),
          ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {})
        });
        const profileName = globals.profile ?? DEFAULT_PROFILE;
        const { path } = saveProfileKey(kit, io, profileName, baseUrl, result.key);
        if (globals.json) {
          // The full key is deliberately NOT echoed — it is already stored.
          return printJson(io, {
            profile: profileName,
            baseUrl,
            user: result.user,
            apiKey: result.apiKey,
            configPath: path
          });
        }
        io.out.write(
          `Signed in as ${result.user.email} on ${baseUrl}.\n` +
            `API key "${result.apiKey.name}" (${redactKey(result.key)}) saved to profile ` +
            `"${profileName}" (${path}).\n`
        );
      }
    );

  program
    .command('login')
    .description(
      `Save an existing ${identity.keyPrefix}_ API key as a profile (pass --api-key or pipe it on stdin)`
    )
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals & { apiKey?: string };
      const baseUrl = resolveAuthUrl(kit, cmd, io);
      // `--api-key-stdin` may already have spent stdin (index.ts); reuse
      // that read rather than blocking on an exhausted stream.
      let key = globals.apiKey ?? stdinApiKey(io) ?? io.env[`${identity.envPrefix}_API_KEY`];
      if (!key) {
        key = await readSecretFromStdin(io, 'API key').catch(() => '');
      }
      if (!key || !key.startsWith(`${identity.keyPrefix}_`)) {
        throw new CliUsageError(
          `No API key provided — pass --api-key ${identity.keyPrefix}_… or pipe the key on stdin.`
        );
      }
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const client = createClient({ baseUrl, apiKey: key, fetch: fetchImpl });
      const me = await client.me(); // verify before storing
      const profileName = globals.profile ?? DEFAULT_PROFILE;
      const { path } = saveProfileKey(kit, io, profileName, baseUrl, key);
      if (globals.json) {
        return printJson(io, { profile: profileName, baseUrl, user: me.user, configPath: path });
      }
      io.out.write(
        `Key verified for ${me.user.email} on ${baseUrl} — saved to profile "${profileName}" (${path}).\n`
      );
    });

  program
    .command('logout')
    .description(
      'Forget the stored API key of the active (or named) profile; a hub-connected profile ' +
        'disconnects from Antasphere (revokes + evicts the cached user-scoped key)'
    )
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      const profileName = globals.profile ?? config.activeProfile;
      const profile = profileName ? config.profiles[profileName] : undefined;
      if (!profileName || !profile) {
        throw new CliUsageError('No profile to log out of.');
      }
      // Hub-connect logout (the cross-tool connect counterpart): revoke the
      // exchange-minted USER-scoped slk_ key(s) server-side, then evict them
      // from the cache. The key is one per hub profile and serves every org
      // (there is no per-org key to pick). Taken when the profile holds ONLY
      // hub-connected keys; a classic single-key profile keeps today's path.
      const connectKeys = profile.connectKeys ?? {};
      const slots = Object.entries(connectKeys);
      if (!profile.apiKey && slots.length > 0) {
        // The revoke targets the instance the key was minted on — the
        // profile's baseUrl, which scopes the cache. Never a flag/env URL:
        // a cached key must not travel to a different instance, not even
        // to die (a foreign host would see the key AND the real one would
        // survive while we report it gone).
        const rawUrl = profile.baseUrl;
        let revoked = true;
        for (const [slot, entry] of slots) {
          if (rawUrl) {
            const baseUrl = rawUrl.replace(/\/+$/, '');
            try {
              const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
              await client.revoke(entry.apiKey);
            } catch (e) {
              revoked = false;
              // A dead/expired key cannot revoke itself (401) — still evict
              // it. A 403 is different: the key WORKS but the instance
              // refuses the self-revoke (an OLDER instance whose fail-closed
              // machine allowlist predates DELETE /cli/auth/key — current
              // instances open it). Never report that as "already unusable"
              // — the key stays valid server-side and only the dashboard can
              // kill it.
              if (e instanceof CliAuthError && e.status === 401) {
                io.err.write('The cached key was already unusable — evicting it anyway.\n');
              } else if (e instanceof CliAuthError && e.status === 403) {
                io.err.write(
                  `This instance refused the self-revoke (${e.code}) — the key STAYS VALID server-side; ` +
                    'revoke it from the dashboard. Evicting the cached copy.\n'
                );
              } else {
                throw e;
              }
            }
          } else {
            revoked = false;
            io.err.write('No instance URL known for this profile — evicting the cached key locally only.\n');
          }
          removeConnectKey(io.env, profileName, slot);
        }
        forgetWorkspaceSelection(kit, io, profileName);
        if (globals.json) {
          return printJson(io, {
            profile: profileName,
            hubProfiles: slots.map(([slot]) => slot),
            revoked,
            evicted: true
          });
        }
        io.out.write(
          `Disconnected from Antasphere on profile "${profileName}"${revoked ? ' (key revoked server-side)' : ''}.\n`
        );
        return;
      }
      delete profile.apiKey;
      // The selection goes with the identity: the next sign-in may be
      // someone whose workspaces are not these.
      delete profile.activeWorkspaceId;
      if (!profile.baseUrl) delete config.profiles[profileName];
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { loggedOut: profileName });
      io.out.write(
        `Logged out of profile "${profileName}" (key forgotten; revoke it in the dashboard to kill it server-side).\n`
      );
    });

  program
    .command('whoami')
    .description('Show the identity behind the resolved API key')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const me = await ctx.client.me();
      // `me` is the answer WITH the selection applied, so its workspace is
      // the one this command (and any other, same flags) really ran in.
      const source = workspaceSource(ctx);
      if (ctx.json) return printJson(io, { ...me, workspaceSource: source });
      io.out.write(
        `${me.user.name} <${me.user.email}>\n` +
          `  instance:  ${ctx.baseUrl}\n` +
          // A key is a USER credential: with zero memberships /me can carry
          // no active workspace (the CLI only ever sees this for sessions,
          // but the wire shape is honest about it).
          `  workspace: ${me.workspace ? `${me.workspace.name} (${me.workspace.id})` : '(none)'}\n` +
          `  chosen by: ${describeSource(source, ctx.workspaceSelection?.profileName)}\n` +
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
    .description('Switch the active profile')
    .action(async (name: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      if (!config.profiles[name]) {
        throw new CliUsageError(`Unknown profile "${name}" — run \`${identity.bin} profiles\`.`);
      }
      config.activeProfile = name;
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { activeProfile: name });
      io.out.write(`Active profile: ${name}\n`);
    });

  program
    .command('profiles')
    .description('List saved profiles')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      const names = Object.keys(config.profiles);
      if (globals.json) {
        return printJson(io, {
          activeProfile: config.activeProfile ?? null,
          profiles: Object.fromEntries(
            names.map((n) => {
              const p = config.profiles[n]!;
              return [
                n,
                {
                  baseUrl: p.baseUrl ?? null,
                  apiKey: p.apiKey ? redactKey(p.apiKey) : null,
                  // Hub profiles this tool profile is connected through
                  // (one user-scoped key each, valid for every org).
                  hubProfiles: Object.keys(p.connectKeys ?? {})
                }
              ];
            })
          )
        });
      }
      if (names.length === 0) {
        io.out.write(
          `No profiles. Sign in with \`${identity.bin} auth login-request --api-url <url> --email <you>\`.\n`
        );
        return;
      }
      io.out.write(
        table(
          names.map((n) => {
            const p = config.profiles[n]!;
            const hubProfiles = Object.keys(p.connectKeys ?? {});
            return [
              config.activeProfile === n ? '*' : ' ',
              n,
              p.baseUrl ?? '(no url)',
              p.apiKey
                ? redactKey(p.apiKey)
                : hubProfiles.length > 0
                  ? `(hub: ${hubProfiles.join(', ')})`
                  : '(no key)'
            ];
          })
        )
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
              baseUrl: p.baseUrl ?? null,
              apiKey: p.apiKey ? redactKey(p.apiKey) : null,
              // The workspace `workspace use` saved (null = the server default).
              activeWorkspaceId: p.activeWorkspaceId ?? null,
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
