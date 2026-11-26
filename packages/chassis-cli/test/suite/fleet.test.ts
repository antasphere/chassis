import { describe, expect, it } from 'vitest';
import { tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { ADA, fleet, HUB_A, HUB_B, SITE_A, SITE_B } from './fleet.js';

/**
 * The fleet's invariants guard tests itself (verifier round 3, F5): for some
 * leaks `violations()` is the only catch in the suite, so a leak planted
 * through the fleet must be reported, by the key's kind and the origin it
 * reached: a hub key sent to an origin that is not its hub's, a tool key sent
 * to another site than its own. A key sent to its own origin is no violation.
 */

describe('the fleet’s invariants guard (F5)', () => {
  it('reports a hub key sent to another origin than its hub, then a tool key sent to another site; a key sent home is nothing', async () => {
    const f = fleet();
    const h = f.harness(await tempConfigEnv());
    const send = (method: string, url: string, key: string, body?: unknown) =>
      h.io.fetch!(url, {
        method,
        headers: { authorization: `Bearer ${key}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    const exchange = { resource: `${SITE_A}/mcp` };
    const hubKey = f.hubKey(HUB_A, ADA);
    const toolKey = f.toolKey(SITE_A, ADA);

    await send('POST', `${HUB_A}/api/v1/sso/tool-token`, hubKey, exchange);
    await send('GET', `${SITE_A}/api/v1/me`, toolKey);
    expect(f.violations()).toEqual([]);

    await send('POST', `${HUB_B}/api/v1/sso/tool-token`, hubKey, exchange);
    expect(f.violations()).toEqual([`hub key of ${HUB_A} sent to ${HUB_B}/api/v1/sso/tool-token`]);

    await send('GET', `${SITE_B}/api/v1/me`, toolKey);
    expect(f.violations()).toEqual([
      `hub key of ${HUB_A} sent to ${HUB_B}/api/v1/sso/tool-token`,
      `tool key of ${SITE_A} sent to ${SITE_B}/api/v1/me`
    ]);
  });
});
