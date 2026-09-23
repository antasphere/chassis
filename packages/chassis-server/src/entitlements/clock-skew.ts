import { USAGE_EVENT_MAX_FUTURE_MS } from '@antasphere/chassis-contract';

/**
 * How far this instance's clock sits from the hub's (PRDCT-2644). The hub
 * judges every usage event's `occurredAt` against ITS clock, the poster
 * against this instance's: a clock ahead of the hub's by more than the
 * forward window (five minutes) stamps events the hub would refuse as from
 * the future, and the poster, reading its own clock, cannot see it. So boot
 * asks once: one GET of the discovery document the cloud boot already
 * trusts (a HEAD may be refused by a proxy), and the `Date` header of its
 * answer is the hub's clock at that moment.
 *
 * Positive = this instance is AHEAD of the hub. `null` when the hub is
 * unreachable, answers no `Date` header, or one that does not parse: this is
 * a diagnostic, it never throws and never refuses a boot. The header has a
 * one-second resolution and the request's latency sits inside the reading,
 * both far below the five-minute window it is compared with.
 */
export async function hubClockSkewMs(
  issuerUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {}
): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const url = issuerUrl.replace(/\/+$/, '') + '/.well-known/openid-configuration';
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000)
    });
    const localNow = now();
    // The body is not read: only the header matters; cancel it so the
    // connection is released.
    await res.body?.cancel().catch(() => {});
    const header = res.headers.get('date');
    if (!header) return null;
    const hubNow = Date.parse(header);
    if (Number.isNaN(hubNow)) return null;
    return localNow - hubNow;
  } catch {
    return null;
  }
}

/**
 * The sentence boot logs when the skew exceeds the hub's forward window, or
 * null when it does not (`|skewMs| <= USAGE_EVENT_MAX_FUTURE_MS`).
 */
export function describeHubClockSkew(skewMs: number): string | null {
  if (Math.abs(skewMs) <= USAGE_EVENT_MAX_FUTURE_MS) return null;
  const minutes = Math.round(Math.abs(skewMs) / 60_000);
  const unit = minutes === 1 ? 'minute' : 'minutes';
  if (skewMs > 0) {
    return `this instance's clock is ${minutes} ${unit} ahead of the hub's; usage events it stamps would be refused by the hub's window`;
  }
  return `this instance's clock is ${minutes} ${unit} behind the hub's; usage events it stamps would read older than they are at the hub, and the poster's own window check would not match the hub's`;
}
