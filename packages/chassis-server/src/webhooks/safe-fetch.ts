import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { addAbortSignal, type Readable } from 'node:stream';

/**
 * The guarded outbound POST the webhook delivery worker uses. A webhook's
 * address is somebody else's choice, so the one rule that is not negotiable:
 * a POST never reaches the instance's own network unless the operator opened
 * it (`allowPrivateNetworks`, a self-hoster's LAN).
 *
 *  - Up front, before any request (`checkWebhookUrl`): `http:`/`https:` only
 *    (`https:` alone under `httpsOnly`), the scheme's default port only, no
 *    userinfo, a hostname, and a literal IP host must be public.
 *  - A name is resolved with ALL its addresses, and the connection is refused
 *    (`WebhookUrlRefusedError`) when ANY of them is not public. The check is
 *    the socket's own `lookup`, so the address connected to IS the one
 *    checked: no gap for a name that answers differently the second time.
 *  - No redirect is ever followed: a 3xx comes back as its status.
 *  - One timeout over the whole call (resolution, connection, the body read).
 *  - The response body is read up to `maxResponseBytes`, then the stream is
 *    destroyed.
 */

export type WebhookUrlRefusal =
  'scheme' | 'port' | 'userinfo' | 'private_address' | 'https_required' | 'unresolvable' | 'malformed';

const REFUSAL_MESSAGES: Record<WebhookUrlRefusal, string> = {
  scheme: 'the webhook URL must use http: or https:',
  port: "the webhook URL must use its scheme's default port",
  userinfo: 'the webhook URL must not carry a user name or a password',
  private_address: 'the webhook URL resolves to an address that is not on the public internet',
  https_required: 'the webhook URL must use https:',
  unresolvable: 'the webhook URL names a host that resolves to no address',
  malformed: 'the webhook URL is not a valid URL'
};

/** A webhook URL the guard refused (a scheme, a port, userinfo, an address). */
export class WebhookUrlRefusedError extends Error {
  readonly code: WebhookUrlRefusal;
  constructor(code: WebhookUrlRefusal, message?: string) {
    super(message ?? REFUSAL_MESSAGES[code]);
    this.name = 'WebhookUrlRefusedError';
    this.code = code;
  }
}

export interface SafeFetchPolicy {
  /** Private, loopback, link-local and other non-public addresses are reachable (a self-hoster's LAN). Default false. */
  allowPrivateNetworks: boolean;
  /** Only https: URLs are accepted (the cloud edition). Default false. */
  httpsOnly: boolean;
  /**
   * The fleet (PRDCT-3772): the origins of the hub's registry tools, read
   * LIVE (the list refreshes hourly, `fleet-origins.ts`). A URL whose origin
   * is one of them names a sibling tool of the same hub: it passes the https
   * rule, the port rule and the address rule at registration and at every
   * delivery, because inside a shared network a sibling's public name
   * resolves to a private address (the team stack's Caddy aliases). Every
   * other URL keeps the public-only rule, whatever the fleet holds. Absent
   * (an oss boot, a test) or empty: no fleet.
   */
  fleetOrigins?: (() => ReadonlySet<string>) | undefined;
}

/**
 * Whether the URL names a sibling of the same hub: its origin (the scheme,
 * the host and the port as `URL.origin` spells them) is one of the fleet's.
 * The origin and nothing looser: a host alone would let `http://crm.example`
 * on another port, or on another scheme, borrow the exemption.
 */
export function isFleetOrigin(url: URL, policy: SafeFetchPolicy): boolean {
  return policy.fleetOrigins?.().has(url.origin) ?? false;
}

export interface LookupAddress {
  address: string;
  family: number;
}
/** Every address a name resolves to (`dns.lookup(host, { all: true })` by default). */
export type SafeLookup = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}
/**
 * One POST, no redirect followed. The default speaks `node:http`/`node:https`
 * with the guarded lookup in the socket; a test hands its own, and the
 * address check then runs before it.
 */
export type SafeTransport = (
  url: URL,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
  signal: AbortSignal
) => Promise<SafeFetchResponse>;

export interface SafeFetchOptions {
  lookup?: SafeLookup;
  transport?: SafeTransport;
  /** Over the whole call. Default 10 000. */
  timeoutMs?: number;
  /** The response body is cut there. Default 65 536. */
  maxResponseBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  /** the response body, utf8, cut at maxResponseBytes */
  bodyText: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

// ── The address check ────────────────────────────────────────────────────────

function ipv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function isPublicV4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && c >= 64 && c <= 127) return false; // carrier-grade NAT
  if (a === 169 && c === 254) return false; // link-local, the cloud metadata address
  if (a === 172 && c >= 16 && c <= 31) return false; // private
  if (a === 192 && c === 0 && b[2] === 0) return false; // IETF protocol assignments
  if (a === 192 && c === 0 && b[2] === 2) return false; // documentation
  if (a === 192 && c === 168) return false; // private
  if (a === 198 && (c === 18 || c === 19)) return false; // benchmarking
  if (a === 198 && c === 51 && b[2] === 100) return false; // documentation
  if (a === 203 && c === 0 && b[2] === 113) return false; // documentation
  return a < 224; // multicast, reserved, broadcast
}

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 folded in), or null. */
function ipv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = ipv4(dotted[1]!);
    if (!v4) return null;
    s = `${s.slice(0, -dotted[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * Whether an address is on the public internet: false for loopback, private,
 * link-local (the metadata address), carrier-grade NAT, multicast, reserved,
 * and every IPv6 outside global unicast (`2000::/3`): `::`, `::1`, `fc00::/7`,
 * `fe80::/10`, `ff00::/8`. An IPv4-mapped (`::ffff:a.b.c.d`) or a 6to4
 * (`2002::/16`) address is judged by the IPv4 inside it. Unparseable: false.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const b = ipv4(ip);
    return b !== null && isPublicV4(b);
  }
  const g = ipv6(ip);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!);
  if ((g[0]! & 0xe000) !== 0x2000) return false; // not global unicast
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false; // Teredo, documentation
  return true;
}

/** The URL's host without the brackets of an IPv6 literal. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * The checks that need no lookup: `http:`/`https:` only, no userinfo, a
 * non-empty hostname; then, for every URL but a fleet origin's, `https:`
 * alone under `httpsOnly`, the scheme's default port only (`url.port ===
 * ''`, so an explicit default port, which the URL parser drops, passes), a
 * literal IP public unless `allowPrivateNetworks`. A sibling of the same hub
 * (`isFleetOrigin`) is reached as the hub names it: its scheme, its port,
 * its address, whatever network it is on; the scheme and userinfo rules
 * hold for it too. Throws `WebhookUrlRefusedError`; returns the parsed URL.
 */
export function checkWebhookUrl(url: string, policy: SafeFetchPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookUrlRefusedError('malformed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WebhookUrlRefusedError('scheme');
  if (parsed.username || parsed.password) throw new WebhookUrlRefusedError('userinfo');
  const host = bareHost(parsed.hostname);
  if (host === '') throw new WebhookUrlRefusedError('malformed');
  if (isFleetOrigin(parsed, policy)) return parsed;
  if (policy.httpsOnly && parsed.protocol !== 'https:') throw new WebhookUrlRefusedError('https_required');
  // The scheme's default port only on the public internet; an operator who
  // opened private networks addresses services on their own ports (an n8n on
  // 5678), so the port rule lifts with the address rule.
  if (parsed.port !== '' && !policy.allowPrivateNetworks) throw new WebhookUrlRefusedError('port');
  if (isIP(host) && !policy.allowPrivateNetworks && !isPublicAddress(host)) {
    throw new WebhookUrlRefusedError('private_address');
  }
  return parsed;
}

/**
 * Whether the address rule is lifted for this URL: the operator opened
 * private networks, or the URL names a sibling of the same hub. Computed
 * once per call from the URL the caller checked, so the socket's lookup
 * (which sees a host name alone) judges the same URL the registration did.
 */
function addressRuleLifted(url: URL, policy: SafeFetchPolicy): boolean {
  return policy.allowPrivateNetworks || isFleetOrigin(url, policy);
}

/**
 * The address to connect to, once EVERY address the name resolves to is
 * public (or the address rule is lifted, `addressRuleLifted`); an empty
 * resolution is `unresolvable`. A failing resolver's own error passes through.
 */
async function checkedAddress(hostname: string, lifted: boolean, lookup: SafeLookup): Promise<LookupAddress> {
  const host = bareHost(hostname);
  const family = isIP(host);
  if (family) {
    if (!lifted && !isPublicAddress(host)) {
      throw new WebhookUrlRefusedError('private_address');
    }
    return { address: host, family };
  }
  const all = await lookup(host);
  if (all.length === 0) throw new WebhookUrlRefusedError('unresolvable');
  if (!lifted && !all.every((a) => isPublicAddress(a.address))) {
    throw new WebhookUrlRefusedError('private_address');
  }
  return all[0]!;
}

/** The promise, or the signal's reason once it aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      }
    );
  });
}

/** At most `max` bytes of the body; the rest is never read. */
async function readCapped(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (size + buf.length >= max) {
      chunks.push(buf.subarray(0, max - size));
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return Buffer.concat(chunks);
}

function nodeTransport(lifted: boolean, resolve: SafeLookup): SafeTransport {
  return (url, init, signal) => {
    const lookup: LookupFunction = (hostname, options, callback) => {
      checkedAddress(hostname, lifted, resolve).then(
        (first) => {
          if (options.all) callback(null, [first]);
          else callback(null, first.address, first.family);
        },
        (e: Error) => callback(e as NodeJS.ErrnoException, '', 0)
      );
    };
    const request = url.protocol === 'https:' ? https.request : http.request;
    return new Promise((done, fail) => {
      const req = request(
        url,
        { method: init.method, headers: init.headers, lookup, signal, agent: false },
        (res) => done({ status: res.statusCode ?? 0, headers: res.headers, body: res })
      );
      req.on('error', fail);
      req.end(init.body);
    });
  };
}

/**
 * One POST, no redirect followed (a 3xx comes back as its status), the address
 * check inside the socket's own lookup (ALL resolved addresses must be public
 * unless `allowPrivateNetworks` or the URL names a sibling of the same hub,
 * `isFleetOrigin`; an empty resolution is `unresolvable`),
 * `AbortSignal.timeout(timeoutMs)` over the whole call, the response body read
 * up to `maxResponseBytes` then the stream destroyed. Rejects with
 * `WebhookUrlRefusedError` on a refused address, with the transport's error
 * (ECONNREFUSED, the timeout's AbortError…) otherwise. Sets no `user-agent`:
 * that is the caller's.
 */
export async function safePost(
  url: string,
  headers: Record<string, string>,
  body: string,
  policy: SafeFetchPolicy,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const started = performance.now();
  const target = checkWebhookUrl(url, policy);
  const lifted = addressRuleLifted(target, policy);
  const lookup: SafeLookup = options.lookup ?? ((host) => dns.lookup(host, { all: true }));
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') sent[name] = value;
  }
  sent['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  const init = { method: 'POST' as const, headers: sent, body };

  let transport: SafeTransport;
  if (options.transport) {
    // The test seam: the same check the socket's lookup makes, made first.
    await abortable(checkedAddress(target.hostname, lifted, lookup), signal);
    transport = options.transport;
  } else {
    transport = nodeTransport(lifted, lookup);
  }

  const res = await abortable(transport(target, init, signal), signal);
  try {
    addAbortSignal(signal, res.body);
    const bytes = await readCapped(res.body, maxBytes);
    return {
      status: res.status,
      bodyText: bytes.toString('utf8'),
      durationMs: Math.round(performance.now() - started)
    };
  } finally {
    res.body.destroy();
  }
}
