import { isLoopbackHost } from '../setup-transport.js';

/**
 * The demo pass's pure rules (the demo pass spec, sections 1 to 3): which
 * hosts the switch may be on, which addresses a pass may open, and which
 * paths a pass may land on. No I/O here, so the env schema, the mint route
 * and the redeem endpoint all judge through the same functions.
 *
 * A demo pass is a sign-in-equivalent link an owner hands out for a
 * demonstration. What keeps it from being a takeover tool is the narrowness
 * of these rules: the switch refuses to boot on a public host nobody named,
 * and a pass only ever opens an address on a domain reserved for examples
 * and tests (RFC 2606 / RFC 6761) or one the operator named on purpose.
 */

/**
 * The lifetime bounds are the contract's (the mint body is validated with
 * them, the dashboard's form reads them): one definition, re-exported here
 * beside the other rules.
 */
export { DEMO_PASS_DEFAULT_MINUTES, DEMO_PASS_MAX_MINUTES } from '@antasphere/chassis-contract';
/** The longest target path a pass may carry. */
export const DEMO_PASS_MAX_PATH_LENGTH = 2048;

/** The second-level domains reserved for documentation (RFC 2606 §3); their subdomains too. */
const RESERVED_EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;
/** The top-level names reserved for testing and examples (RFC 2606 §2, RFC 6761). */
const RESERVED_TOP_LABELS = new Set(['test', 'example', 'invalid', 'localhost']);

/** One DNS label as the lists accept it: letters, digits and hyphens, lowercased. */
const LABEL_RE = /^[a-z0-9-]+$/;

/**
 * Why one list entry is not a bare hostname, or null when it is. Checked in
 * the order an operator's typo most likely takes: a pasted URL, a port, a
 * wildcard. A refusal names the entry so the boot table says which one.
 */
function entryProblem(entry: string): string | null {
  if (/\s/.test(entry)) return 'contains a space';
  if (entry.includes('://')) return 'carries a scheme (list the bare hostname)';
  if (entry.includes('/')) return 'carries a path (list the bare hostname)';
  if (entry.includes(':')) return 'carries a port (list the bare hostname)';
  if (entry.includes('*')) return 'is a wildcard (list each hostname exactly)';
  const labels = entry.split('.');
  if (labels.some((label) => label.length === 0)) return 'has an empty label';
  if (labels.some((label) => !LABEL_RE.test(label))) return 'is not a hostname';
  return null;
}

/**
 * Parse one comma-separated list of hostnames into a lowercased set. Unset
 * or blank is the empty set; a list that is only separators, or any entry
 * that is not a bare hostname, THROWS, so the env schema refuses the boot:
 * a typo must never silently widen (or silently empty) the list.
 */
function parseHostList(variable: string, raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (raw === undefined || raw.trim() === '') return set;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error(`${variable} must list at least one hostname`);
  for (const entry of entries) {
    const lowered = entry.toLowerCase();
    const problem = entryProblem(lowered);
    if (problem) throw new Error(`${variable} entry "${entry}" ${problem}`);
    set.add(lowered);
  }
  return set;
}

/** `DEMO_SIGN_IN_HOSTS`: the public hosts the switch may be on, beside loopback. Exact match. */
export function parseDemoHosts(raw: string | undefined): ReadonlySet<string> {
  return parseHostList('DEMO_SIGN_IN_HOSTS', raw);
}

/** `DEMO_SIGN_IN_EMAIL_DOMAINS`: the domains the operator adds to the reserved ones (subdomains included). */
export function parseDemoEmailDomains(raw: string | undefined): ReadonlySet<string> {
  return parseHostList('DEMO_SIGN_IN_EMAIL_DOMAINS', raw);
}

/**
 * The boot rule: the switch may be on only where the host of PUBLIC_BASE_URL
 * is loopback (the same test the setup wizard uses, never a second copy) or
 * listed, exactly, in `DEMO_SIGN_IN_HOSTS`. An unparseable URL fails closed.
 */
export function isDemoSignInHost(publicBaseUrl: string, hosts: ReadonlySet<string>): boolean {
  let hostname: string;
  try {
    hostname = new URL(publicBaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHost(hostname) || hosts.has(hostname);
}

/** `domain` equals `parent` or sits under it, on a label boundary. */
function isDomainOrSubdomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Who a pass may open (spec section 2): an address whose domain (the part
 * after the LAST `@`, lowercased) is a reserved example domain or under one,
 * ends in a reserved top-level name, or is an operator-listed domain or under
 * one. Matching is on label boundaries, so `notexample.com` and
 * `example.com.evil.io` are refused. A domain with an empty label is refused
 * outright: it is no mailbox anybody holds.
 */
export function isDemoAddress(email: string, extraDomains: ReadonlySet<string>): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  const labels = domain.split('.');
  if (labels.some((label) => label.length === 0)) return false;
  if (RESERVED_TOP_LABELS.has(labels[labels.length - 1]!)) return true;
  if (RESERVED_EXAMPLE_DOMAINS.some((parent) => isDomainOrSubdomain(domain, parent))) return true;
  for (const parent of extraDomains) {
    if (isDomainOrSubdomain(domain, parent)) return true;
  }
  return false;
}

/**
 * The page a pass lands on (spec section 3): one leading `/` and never `//`
 * or `/\` (both resolve to another origin in a browser, LESSONS.md M8), no
 * control character, space or DEL, no fragment, at most 2048 characters. The
 * server checks it at mint; the dashboard still passes it through `safeNext`.
 */
export function isSafeDemoPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length < 1 || path.length > DEMO_PASS_MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return !path.includes('#');
}

/**
 * Sign-in library paths (relative to /api/v1/auth) a demo pass's session is
 * refused. A pass's session is a visit: what it opens or changes must not
 * outlive the pass, so it changes no address, password, name or second
 * factor, deletes no account, mints no token and ends no other session. On
 * this edition a pass lands in no tool, so it authorizes no OAuth client at
 * all: the whole authorize and consent flow is on the list, and client
 * management with it. A new sign-in-library plugin's endpoints must be
 * reviewed against this list when it is added.
 */
export const DEMO_SESSION_REFUSED_AUTH_PATHS: readonly string[] = [
  '/change-email',
  '/change-password',
  '/delete-user',
  '/update-user',
  '/link-social',
  '/unlink-account',
  '/email-otp/change-email',
  '/email-otp/request-email-change',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
  '/oauth2/authorize',
  '/oauth2/consent',
  '/oauth2/update-consent',
  '/oauth2/continue',
  '/oauth2/create-client',
  // A session's register stores the client under the person (user_id), a
  // credential the pass would leave behind; anonymous registration is another
  // matter, judged by OAUTH_DYNAMIC_CLIENT_REGISTRATION and its own wall.
  '/oauth2/register',
  '/oauth2/update-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/delete-client',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/revoke-session',
  '/token',
  '/get-access-token',
  '/refresh-token'
];

const REFUSED_AUTH_PATHS: ReadonlySet<string> = new Set(DEMO_SESSION_REFUSED_AUTH_PATHS);

/**
 * Whether a demo pass's session is refused this sign-in library path
 * (relative to /api/v1/auth). One trailing `/` is dropped and the comparison
 * is lowercase, so neither spelling walks past the list.
 */
export function demoSessionAuthRefusal(authPath: string): boolean {
  const trimmed = authPath.endsWith('/') ? authPath.slice(0, -1) : authPath;
  return REFUSED_AUTH_PATHS.has(trimmed.toLowerCase());
}

/** One API route a demo pass's session is refused, and what the refusal says it cannot do. */
export interface DemoSessionRefusedApiRoute {
  /** An HTTP method, or `ALL` for every method of the path. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  /** A path relative to /api/v1, in the router's spelling (`:id`, a trailing `*` for a subtree). */
  readonly path: string;
  /** The act, completing "A session opened by a demo link cannot …". */
  readonly does: string;
}

/**
 * API routes (relative to /api/v1) a demo pass's session is refused. A pass's
 * session is a visit: it mints no credential for anyone (a reset link, a
 * change-email link, an invitation, an API key, a demo link) and owns nothing
 * that outlives the pass (a workspace, a default). Mounted once, right after
 * the credential middleware (`api/create-api.ts`); a new route that mints a
 * credential or creates something the person keeps joins this list.
 */
export const DEMO_SESSION_REFUSED_API_ROUTES: readonly DemoSessionRefusedApiRoute[] = [
  { method: 'POST', path: '/members/:id/reset-link', does: 'make a password reset link' },
  { method: 'POST', path: '/members/:id/change-email-link', does: 'make an email change link' },
  { method: 'POST', path: '/invitations', does: 'send an invitation' },
  { method: 'POST', path: '/api-keys', does: 'create an API key' },
  { method: 'ALL', path: '/demo/passes', does: 'manage demo links' },
  { method: 'ALL', path: '/demo/passes/*', does: 'manage demo links' },
  { method: 'POST', path: '/workspaces', does: 'create a workspace' },
  { method: 'PUT', path: '/me/default-workspace', does: 'change your default workspace' }
];

/** The refusal's sentence for one entry of `DEMO_SESSION_REFUSED_API_ROUTES`. */
export function demoSessionApiRefusalMessage(does: string): string {
  return `A session opened by a demo link cannot ${does}: sign in with your password`;
}
