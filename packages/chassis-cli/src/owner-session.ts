import { ChassisClient, DEFAULT_TIMEOUT_MS } from '@antasphere/chassis-sdk';
import { CliApiRefusal, CliUsageError, type CliContext } from './context.js';
import type { CliIdentity } from './identity.js';
import { readSecretFromStdin } from './stdin.js';
import { isWorkspaceId, matchWorkspace } from './workspace.js';

/**
 * A command that acts as a SIGNED-IN OWNER, never with an API key.
 *
 * Some owner acts are refused to every machine credential by design (the
 * demo pass routes: nothing in the scope allowlist opens them, and the
 * handler checks `via === 'session'` again). The CLI reaches them the way a
 * browser does: one password sign-in, the session cookie held in memory for
 * the length of the command, a sign-out when it ends, success or failure.
 *
 * The address comes from `--owner-email` or `<PREFIX>_OWNER_EMAIL`, the
 * password from `<PREFIX>_OWNER_PASSWORD` or, with `--owner-password-stdin`,
 * the first line of stdin. There is no password flag: a value on the command
 * line is visible in `ps` and lands in the shell history. None of the three
 * (address, password, cookie) is ever written to the profile, a file, a log
 * or the terminal: they live in this function's locals and in the one
 * client's header map, and die with the command.
 */

export interface OwnerSessionOptions {
  /** The tool's identity: `<PREFIX>_OWNER_EMAIL` / `<PREFIX>_OWNER_PASSWORD` are built from it. */
  identity: Pick<CliIdentity, 'envPrefix'>;
  /** `--owner-email`. */
  ownerEmail?: string;
  /** `--owner-password-stdin`. */
  ownerPasswordStdin?: boolean;
}

/**
 * The sign-in library allows three sign-ins per ten seconds per address, and
 * a script that makes links for several people signs in once per command:
 * the fourth command in a row meets the wall. It is a wall of seconds, so the
 * command waits it out, three times at most, and says so on stderr.
 */
const SIGN_IN_WAITS_MS = [4_000, 8_000, 12_000] as const;

/** The session cookie the sign-in library sets, whatever prefix the instance gives it. */
const SESSION_COOKIE = /session_token$/;

/** `name=value` of the session cookie among the answer's `set-cookie` lines, or null. */
function sessionCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0]!.trim();
    const eq = pair.indexOf('=');
    if (eq > 0 && SESSION_COOKIE.test(pair.slice(0, eq))) return pair;
  }
  return null;
}

/** The sign-in library's own refusals are `{ code, message }`; the API's are `{ error: {…} }`. */
async function refusalMessage(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as {
    message?: unknown;
    error?: { message?: unknown };
  } | null;
  const message = body?.error?.message ?? body?.message;
  return typeof message === 'string' && message ? message : null;
}

async function ownerCredentials(
  ctx: CliContext,
  options: OwnerSessionOptions
): Promise<{ email: string; password: string }> {
  const { envPrefix } = options.identity;
  const emailVar = `${envPrefix}_OWNER_EMAIL`;
  const passwordVar = `${envPrefix}_OWNER_PASSWORD`;
  const email = (options.ownerEmail ?? ctx.io.env[emailVar] ?? '').trim();
  const password = options.ownerPasswordStdin
    ? await readSecretFromStdin(ctx.io, 'owner password')
    : (ctx.io.env[passwordVar] ?? '');
  if (!email || !password) {
    throw new CliUsageError(
      `This command signs in as an owner of the workspace, never with an API key. Set ${emailVar} ` +
        `(or pass --owner-email) and ${passwordVar} (or pipe it with --owner-password-stdin).`
    );
  }
  return { email, password };
}

/**
 * Sign in as the owner, run `run` with a client that carries the session
 * cookie and the origin (and no authorization header), then sign out.
 */
export async function withOwnerSession<T>(
  ctx: CliContext,
  options: OwnerSessionOptions,
  run: (client: ChassisClient<string>) => Promise<T>
): Promise<T> {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const fetchImpl = ctx.io.fetch ?? globalThis.fetch.bind(globalThis);
  const { email, password } = await ownerCredentials(ctx, options);

  // The server refuses a sign-in that carries no Origin (the cross-site guard).
  const signIn = () =>
    fetchImpl(`${base}/api/v1/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let res = await signIn();
  for (const wait of SIGN_IN_WAITS_MS) {
    if (res.status !== 429) break;
    ctx.io.err.write(`The instance limits sign-ins: waiting ${wait / 1000} seconds.\n`);
    await sleep(wait);
    res = await signIn();
  }
  if (res.status === 429) {
    throw new CliApiRefusal('Too many sign-in attempts for now: wait a few minutes, then try again.', 429);
  }
  if (!res.ok) {
    const message = (await refusalMessage(res)) ?? `The sign-in failed (HTTP ${res.status}).`;
    throw new CliApiRefusal(message, res.status);
  }
  const answer = (await res.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null;
  if (answer?.twoFactorRedirect === true) {
    throw new CliUsageError('This owner has a second factor: mint demo links from the dashboard.');
  }
  const cookie = sessionCookie(res);
  if (!cookie) throw new CliUsageError('The instance answered the sign-in without a session.');

  const headers = { cookie, origin };
  const client = new ChassisClient<string>({ baseUrl: base, fetch: fetchImpl, headers });
  try {
    // The workspace selection applies here as it does to every command
    // (context.ts `applyWorkspace`): an id as it is, a name through `/me`.
    const selection = ctx.workspaceSelection;
    if (selection) {
      client.setWorkspace(
        isWorkspaceId(selection.value)
          ? selection.value
          : matchWorkspace((await client.me()).workspaces, selection.value).id
      );
    }
    return await run(client);
  } finally {
    // The session ends with the command; its outcome changes nothing.
    await fetchImpl(`${base}/api/v1/auth/sign-out`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    }).catch(() => undefined);
  }
}
