import { describe, expect, it } from 'vitest';
import { describeHubClockSkew, hubClockSkewMs } from '../../src/entitlements/clock-skew.js';

/**
 * The hub clock probe (PRDCT-2644): one GET of the discovery document, the
 * `Date` header read against the local clock; null on anything unreadable,
 * never a throw; a sentence only past the hub's five-minute forward window.
 */

const ISSUER = 'https://hub.test/';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const MIN = 60_000;

function answering(headers: Record<string, string>) {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response('{}', { status: 200, headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('hubClockSkewMs', () => {
  it('a hub seven minutes behind reads as +7 minutes, and the sentence says ahead', async () => {
    const f = answering({ date: new Date(NOW - 7 * MIN).toUTCString() });
    const skew = await hubClockSkewMs(ISSUER, { fetchImpl: f.fetchImpl, now: () => NOW });
    expect(skew).toBe(7 * MIN);
    expect(f.calls).toEqual([{ url: 'https://hub.test/.well-known/openid-configuration', method: 'GET' }]);
    const sentence = describeHubClockSkew(skew!);
    expect(sentence).toBe(
      "this instance's clock is 7 minutes ahead of the hub's; usage events it stamps would be refused by the hub's window"
    );
  });

  it('a hub seven minutes ahead reads as −7 minutes, and the sentence says behind', async () => {
    const f = answering({ date: new Date(NOW + 7 * MIN).toUTCString() });
    const skew = await hubClockSkewMs(ISSUER, { fetchImpl: f.fetchImpl, now: () => NOW });
    expect(skew).toBe(-7 * MIN);
    expect(describeHubClockSkew(skew!)).toMatch(/7 minutes behind the hub's/);
  });

  it('within five minutes either way there is no sentence (the bound is inclusive)', async () => {
    const f = answering({ date: new Date(NOW - 3 * MIN).toUTCString() });
    const skew = await hubClockSkewMs(ISSUER, { fetchImpl: f.fetchImpl, now: () => NOW });
    expect(skew).toBe(3 * MIN);
    expect(describeHubClockSkew(skew!)).toBeNull();
    expect(describeHubClockSkew(5 * MIN)).toBeNull();
    expect(describeHubClockSkew(-5 * MIN)).toBeNull();
    expect(describeHubClockSkew(5 * MIN + 1)).not.toBeNull();
  });

  it('no Date header reads as null', async () => {
    const f = answering({});
    expect(await hubClockSkewMs(ISSUER, { fetchImpl: f.fetchImpl, now: () => NOW })).toBeNull();
  });

  it('an unparseable Date header reads as null', async () => {
    const f = answering({ date: 'not a date' });
    expect(await hubClockSkewMs(ISSUER, { fetchImpl: f.fetchImpl, now: () => NOW })).toBeNull();
  });

  it('a fetch that throws reads as null, never a throw', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(hubClockSkewMs(ISSUER, { fetchImpl, now: () => NOW })).resolves.toBeNull();
  });
});
