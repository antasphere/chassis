import { hostname } from 'node:os';
import type { Command } from 'commander';
import {
  CliAuthClient,
  CliAuthError,
  firstSet,
  forgetKeys,
  freshProfileName,
  keysOfProfile,
  normalizeUrl,
  probeToolInstance,
  rememberSite,
  selectProfile,
  type CliConfig,
  type CliProfile
} from '@antasphere/cli-core';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import {
  CliUsageError,
  isLocalSite,
  keysHeldElsewhere,
  limitedFetchOf,
  printJson,
  sayKept,
  type CliIo
} from '../context.js';
import type { CliKit } from '../kit.js';
import {
  describeProfiles,
  factsOfProbe,
  planFor,
  profileRows,
  renderProfiles,
  servedKey,
  undecidedLoginsOf,
  type ProfileCheck,
  type ProfileEntry,
  type ProfileRow,
  type ProfilesListing
} from '../listing.js';

/**
 * The profiles of this machine (R3, R4; PRDCT-5190, PRDCT-3060): `profiles`
 * lists them and says the truth about each (`listing.ts`, the contract),
 * `--check` asks each site, and `add`, `rename` and `remove` manage them, one
 * profile per site.
 *
 * None of these commands resolves a command's context: an exported key, URL
 * or hub variable is an effect the listing shows, never a refusal of these
 * commands. Every write is one locked `updateConfig`, never held across the
 * network; a key is revoked only on its profile's own site.
 */

/** A profile's name: what `add --name` and `rename` accept. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** What a site answered to the self-revoke of one key: dead now (or already), refused, or no answer. */
type Revoked = 'revoked' | 'refused' | 'silent';

/** `n key` / `n keys`. */
const keys = (n: number): string => `${n} key${n === 1 ? '' : 's'}`;

export function registerProfileCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo,
  version: string
): void {
  const { identity, createClient, loadConfig, updateConfig, profileUrl } = kit;
  const { bin, cloudUrl } = identity;

  const fetchOf = (): typeof globalThis.fetch => io.fetch ?? globalThis.fetch.bind(globalThis);

  /**
   * The fetch of `--check`, `add` and the revokes of `remove` (`limitedFetchOf`
   * over this io's fetch): each request is aborted past the limit
   * (`CliIo.requestTimeoutMs`, else 10 s), as well as by any signal it already
   * carries. A request the limit aborted is no answer: a site that holds the
   * connection open costs these commands the limit, never the system's own
   * connect timeout.
   */
  function limitedFetch(): typeof globalThis.fetch {
    return limitedFetchOf(fetchOf(), io);
  }

  /** The listing of a file as it is, with what `--check` found. */
  function listingOf(config: CliConfig, checks?: ReadonlyMap<string, ProfileCheck>): ProfilesListing {
    return describeProfiles({
      identity,
      config,
      env: io.env,
      machine: io.hostname?.() ?? hostname(),
      cliVersion: version,
      checks
    });
  }

  /** One profile's entry of the contract, as the file holds it now. */
  function entryNamed(name: string): ProfileEntry | null {
    return listingOf(loadConfig(io.env)).profiles.find((p) => p.name === name) ?? null;
  }

  /** A profile's site, normalized. */
  const siteOf = (profile: CliProfile | undefined): string => normalizeUrl(profileUrl(profile));

  /** The default profile and its site: the active one, else the profile at the cloud URL, else the implicit row. */
  function defaultOf(config: CliConfig): { name: string; site: string } {
    const { name } = selectProfile({ config, cloudUrl });
    const row = profileRows(config, cloudUrl).find((r) => r.name === name);
    return { name: name ?? '', site: row?.site ?? normalizeUrl(cloudUrl) };
  }

  const unknown = (name: string): CliUsageError =>
    new CliUsageError(`Unknown profile "${name}" — run \`${bin} profiles\`.`);

  /** A name `add --name` or `rename` may give, or the refusal that says what a name is. */
  function validName(name: string): string {
    if (!NAME_RE.test(name)) {
      throw new CliUsageError(
        `"${name}" is not a profile name: 1 to 64 letters, digits, ".", "_", ":", "@" or "-", starting with ` +
          'a letter or a digit.'
      );
    }
    return name;
  }

  /** The site a URL names, `http:` or `https:` only, normalized. */
  function siteAddress(url: string): string {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url.trim());
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
      throw new CliUsageError(`"${url}" is not the address of a site: give its http:// or https:// URL.`);
    }
    return normalizeUrl(parsed.href);
  }

  /** One profile per site, and a name nothing has: the refusals of `add`. */
  function refuseTaken(config: CliConfig, site: string, wanted: string | undefined): void {
    const at = selectProfile({ config, apiUrl: site, cloudUrl });
    if (!at.created && at.name) {
      throw new CliUsageError(
        `Profile "${at.name}" is already ${site}. One profile per site: ${bin} profiles rename ${at.name} ` +
          `${wanted ?? '<name>'} names it differently.`
      );
    }
    const taken = wanted === undefined ? undefined : config.profiles[wanted];
    if (taken) throw new CliUsageError(`Profile "${wanted}" already exists (${siteOf(taken)}).`);
  }

  // ── --check ────────────────────────────────────────────────────────────────

  /**
   * Ask one profile's site: its discovery (remembered on a saved profile,
   * under the lock), then `/me` with the key a command would send (its own
   * key, or the kept key the plan serves, an old slot read by name included).
   * Never an exchange, never a revoke, never a move of the old slots: the
   * site's facts are the one thing written. A site that does not answer as a
   * site of this tool is never sent a key. Each request has its limit: one
   * that outlasts it is no answer.
   */
  async function checkOne(row: ProfileRow): Promise<ProfileCheck> {
    const fetchLimited = limitedFetch();
    const probe = await probeToolInstance(row.site, fetchLimited);
    if (!probe) return { facts: null, checked: 'unreachable', person: null };
    const facts = factsOfProbe(probe, new Date().toISOString());
    if (row.saved) rememberSite(io.env, identity.tool, row.name, probe, { cloudUrl, force: true });
    const profile = row.saved ? loadConfig(io.env).profiles[row.name] : { baseUrl: row.site, site: facts };
    const key = servedKey(planFor(identity, io.env, row.name, profile, row.site), profile);
    if (!key) return { facts, checked: 'no_key', person: null };
    try {
      const me = await createClient({ baseUrl: row.site, apiKey: key, fetch: fetchLimited }).me();
      return {
        facts,
        checked: 'ok',
        person: {
          name: firstSet(me.user.name) ?? null,
          email: me.user.email,
          workspace: me.workspace?.name ?? null
        }
      };
    } catch (e) {
      const refused = e instanceof PlatformApiError && e.status === 401;
      return { facts, checked: refused ? 'key_refused' : 'unreachable', person: null };
    }
  }

  /** Every row's site, asked at once. */
  async function checkAll(config: CliConfig): Promise<Map<string, ProfileCheck>> {
    const rows = profileRows(config, cloudUrl);
    return new Map(await Promise.all(rows.map(async (row) => [row.name, await checkOne(row)] as const)));
  }

  // ── profiles ───────────────────────────────────────────────────────────────

  const profiles = program
    .command('profiles')
    .description(
      'List the profiles, one per site: who signs each in and through what, the CLI version its site speaks, ' +
        'what the environment changes, and the one way to fix each (never any part of a key)'
    )
    .option(
      '--check',
      'ask each site: its discovery, then /me with the key a command would send (never mints, never revokes)',
      false
    )
    .action(async (opts: { check: boolean }, cmd: Command) => {
      if (cmd.args.length > 0) {
        throw new CliUsageError(
          `Unknown command "profiles ${cmd.args[0]}" — run \`${bin} profiles --help\`.`
        );
      }
      const globals = cmd.optsWithGlobals() as { json?: boolean };
      let config = loadConfig(io.env);
      // The hub file before any request: one that cannot be read stops the listing, and says what it means.
      const undecided = undecidedLoginsOf(io.env);
      let checks: Map<string, ProfileCheck> | undefined;
      if (opts.check) {
        checks = await checkAll(config);
        // What the sites said is on the profiles now.
        config = loadConfig(io.env);
      }
      const listing = listingOf(config, checks);
      if (globals.json) return printJson(io, listing);
      io.out.write(renderProfiles(listing, identity, { undecidedLogins: undecided }));
    });

  // ── profiles add ───────────────────────────────────────────────────────────

  profiles
    .command('add <url>')
    .description(
      "Add a site's profile (one per site): its discovery is read once and kept with it; no sign-in, no key"
    )
    .option('--name <name>', "the profile's name (default: the site's host, or cloud for the cloud)")
    .action(async (url: string, opts: { name?: string }, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as { json?: boolean };
      const site = siteAddress(url);
      const wanted = opts.name === undefined ? undefined : validName(opts.name);
      refuseTaken(loadConfig(io.env), site, wanted);
      // Discovery once, with no lock held and within its limit; the profile keeps what the site says of itself.
      const probe = await probeToolInstance(site, limitedFetch());
      let name = '';
      let first = false;
      updateConfig(io.env, (config) => {
        refuseTaken(config, site, wanted);
        first = Object.keys(config.profiles).length === 0;
        name = wanted ?? freshProfileName(config, site, cloudUrl);
        config.profiles[name] = {
          baseUrl: site,
          ...(probe ? { site: factsOfProbe(probe, new Date().toISOString()) } : {})
        };
        // The first profile of a machine is its default; nothing else moves it.
        if (first) config.activeProfile = name;
      });
      if (!probe) {
        io.err.write(
          `Nothing answered at ${site} as a site of ${identity.displayName}: profile "${name}" is added all the ` +
            'same, and what its site says of itself is read at its first command.\n'
        );
      }
      if (globals.json) printJson(io, entryNamed(name));
      else io.out.write(`Profile "${name}" added: ${site}.\n`);
      const current = defaultOf(loadConfig(io.env));
      if (!first && current.name !== name) {
        io.err.write(
          `The default profile stays "${current.name}" (${bin} use ${name} makes "${name}" the default).\n`
        );
      }
    });

  // ── profiles rename ────────────────────────────────────────────────────────

  profiles
    .command('rename <old> <new>')
    .description('Rename a profile: its keys go with it, and so does being the default')
    .action(async (from: string, to: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as { json?: boolean };
      const target = validName(to);
      let site = '';
      updateConfig(io.env, (config) => {
        if (!config.profiles[from]) {
          // The implicit cloud profile is written first, then renamed like any other.
          const implicit = profileRows(config, cloudUrl).find((r) => !r.saved);
          if (!implicit || implicit.name !== from) throw unknown(from);
          config.profiles[from] = { baseUrl: implicit.site };
        }
        const taken = config.profiles[target];
        if (taken) throw new CliUsageError(`Profile "${target}" already exists (${siteOf(taken)}).`);
        site = siteOf(config.profiles[from]);
        // The profile moves whole, in its place in the file.
        config.profiles = Object.fromEntries(
          Object.entries(config.profiles).map(([n, p]) => [n === from ? target : n, p])
        );
        if (config.activeProfile === from) config.activeProfile = target;
      });
      if (globals.json) return printJson(io, { renamed: { from, to: target }, profile: entryNamed(target) });
      io.out.write(`Profile "${from}" is now "${target}" (${site}).\n`);
    });

  // ── profiles remove ────────────────────────────────────────────────────────

  /**
   * Revoke one key on a site (the profile's own, never another origin), held to the io's limit
   * (`limitedFetch`): a revoke the limit aborted is no answer, like a site that does not answer.
   */
  async function revokeAt(site: string, key: string): Promise<Revoked> {
    try {
      await new CliAuthClient({ baseUrl: site, fetch: limitedFetch() }).revoke(key);
      return 'revoked';
    } catch (e) {
      // A 401: the key is already dead there. Any other answer: the site did not revoke it.
      if (e instanceof CliAuthError) return e.status === 401 ? 'revoked' : 'refused';
      return 'silent';
    }
  }

  profiles
    .command('remove <name>')
    .description(
      'Remove a profile: every key it holds is revoked on its own site, then it is forgotten (the default ' +
        'falls back, and says where)'
    )
    .action(async (name: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as { json?: boolean };
      const before = loadConfig(io.env);
      const profile = before.profiles[name];
      if (!profile) throw unknown(name);
      const site = siteOf(profile);
      const wasDefault = defaultOf(before).name === name;
      // Revoked on the profile's own site, with no lock held; once the site gives no answer the rest is
      // not tried. A key another profile on disk still holds is not revoked: it goes with this profile
      // only, and that is said. The profile is forgotten whatever the site said.
      const held = keysOfProfile(profile);
      const elsewhere = keysHeldElsewhere(before, name, cloudUrl);
      let revoked = 0;
      let refused = 0;
      let silent = 0;
      for (const key of held) {
        const other = elsewhere.get(key.apiKey);
        if (other) {
          sayKept(io, site, other);
          continue;
        }
        const answer = silent > 0 ? 'silent' : await revokeAt(site, key.apiKey);
        if (answer === 'revoked') revoked += 1;
        else if (answer === 'refused') refused += 1;
        else silent += 1;
      }
      // Forgotten compare-and-remove: a key another command gave the profile meanwhile is never lost.
      const tried = new Set(held.map((k) => k.apiKey));
      let added = 0;
      const { config: after } = updateConfig(io.env, (draft) => {
        const now = draft.profiles[name];
        if (!now) return;
        added = keysOfProfile(now).filter((k) => !tried.has(k.apiKey)).length;
        if (added > 0) return;
        delete draft.profiles[name];
        if (draft.activeProfile === name) delete draft.activeProfile;
      });
      if (added > 0) {
        forgetKeys(io.env, identity.tool, name, [...tried]);
        throw new CliUsageError(
          `Profile "${name}" took ${keys(added)} while it was being removed (another command signed in on it), ` +
            `so it stays, with ${added === 1 ? 'that one' : 'those'}: run ${bin} profiles remove ${name} again.`
        );
      }
      const stay = (n: number) => (n === 1 ? 'it stays' : 'they stay');
      if (silent > 0) {
        io.err.write(
          isLocalSite(site)
            ? `Nothing answers at ${site}; its keys die with it.\n`
            : `Could not reach ${site} to revoke ${keys(silent)}: ${stay(silent)} valid there until revoked ` +
                'from its dashboard.\n'
        );
      }
      if (refused > 0) {
        io.err.write(
          `${site} did not revoke ${keys(refused)}: ${stay(refused)} valid there until revoked from its ` +
            'dashboard.\n'
        );
      }
      const fallback = defaultOf(after);
      if (globals.json) {
        return printJson(io, {
          removed: name,
          site,
          revoked,
          unrevoked: refused + silent,
          defaultSite: fallback.site
        });
      }
      io.out.write(
        `Profile "${name}" removed (${site}): ${held.length === 0 ? 'it held no key' : `${keys(revoked)} revoked there`}.\n` +
          (wasDefault ? `The default is now "${fallback.name}" (${fallback.site}).\n` : '')
      );
    });
}
