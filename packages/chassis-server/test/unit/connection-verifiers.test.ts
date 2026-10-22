import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, signWebhook } from '../../src/webhooks/signing.js';
import { standardWebhooksVerifier, stripeVerifier } from '../../src/connections/verifiers.js';
import { buildConnectionCatalog } from '../../src/connections/catalog.js';

/**
 * The door's named verifiers (PRDCT-3773): the standard scheme (what the
 * chassis's own webhooks send) and Stripe's, each on the raw body, within
 * the tolerance, in constant time; and the catalog's refusals at boot.
 */

const NOW = 1_700_000_000;
const headersOf = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('the standard webhooks verifier', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: 'evt_1', type: 'thing.created', data: { x: 1 } });

  function signed(id = 'msg_1', at = NOW, s = secret) {
    const timestamp = String(at);
    const signature = signWebhook([s], id, at, body);
    return headersOf({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature });
  }

  it('accepts a signed delivery and answers the webhook-id header as the delivery id', async () => {
    const verdict = await standardWebhooksVerifier({
      secret,
      header: signed(),
      rawBody: body,
      nowSeconds: NOW
    });
    expect(verdict).toEqual({ ok: true, id: 'msg_1' });
  });

  it('refuses a missing header, a wrong secret, a changed body and a stale timestamp', async () => {
    const ctx = { secret, rawBody: body, nowSeconds: NOW };
    expect(await standardWebhooksVerifier({ ...ctx, header: headersOf({}) })).toEqual({
      ok: false,
      code: 'missing_headers'
    });
    expect(
      await standardWebhooksVerifier({ ...ctx, header: signed('msg_1', NOW, generateWebhookSecret()) })
    ).toEqual({
      ok: false,
      code: 'invalid_signature'
    });
    expect(await standardWebhooksVerifier({ ...ctx, header: signed(), rawBody: `${body} ` })).toEqual({
      ok: false,
      code: 'invalid_signature'
    });
    expect(await standardWebhooksVerifier({ ...ctx, header: signed('msg_1', NOW - 301) })).toEqual({
      ok: false,
      code: 'invalid_signature'
    });
    expect(await standardWebhooksVerifier({ ...ctx, header: signed('msg_1', NOW - 299) })).toMatchObject({
      ok: true
    });
  });

  it('a secret that is not a whsec_ value verifies nothing rather than throwing', async () => {
    expect(
      await standardWebhooksVerifier({
        secret: 'not-a-secret',
        header: signed(),
        rawBody: body,
        nowSeconds: NOW
      })
    ).toEqual({ ok: false, code: 'invalid_signature' });
  });
});

describe("Stripe's verifier", () => {
  const secret = 'whsec_stripe_test_secret_0123456789';
  const body = JSON.stringify({ id: 'evt_42', type: 'payment.succeeded' });
  const sign = (t: number, s = secret) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex');

  it('accepts t=…,v1=… within the tolerance, any v1 entry, and answers no id (the body carries it)', async () => {
    const header = headersOf({ 'stripe-signature': `t=${NOW},v1=deadbeef,v1=${sign(NOW)}` });
    expect(await stripeVerifier({ secret, header, rawBody: body, nowSeconds: NOW })).toEqual({ ok: true });
  });

  it('refuses a missing or malformed header, a wrong secret and a stale timestamp', async () => {
    const ctx = { secret, rawBody: body, nowSeconds: NOW };
    expect(await stripeVerifier({ ...ctx, header: headersOf({}) })).toEqual({
      ok: false,
      code: 'missing_headers'
    });
    expect(await stripeVerifier({ ...ctx, header: headersOf({ 'stripe-signature': 'v1=abc' }) })).toEqual({
      ok: false,
      code: 'missing_headers'
    });
    expect(
      await stripeVerifier({
        ...ctx,
        header: headersOf({ 'stripe-signature': `t=${NOW},v1=${sign(NOW, 'whsec_other')}` })
      })
    ).toEqual({ ok: false, code: 'invalid_signature' });
    expect(
      await stripeVerifier({
        ...ctx,
        header: headersOf({ 'stripe-signature': `t=${NOW - 400},v1=${sign(NOW - 400)}` })
      })
    ).toEqual({ ok: false, code: 'invalid_signature' });
  });
});

describe('the catalog at boot', () => {
  it('refuses a bad key, a duplicate, a verifier or a handler on a key source, a probe on an inbound one', () => {
    const ok = buildConnectionCatalog({ sources: [{ key: 'meet', name: 'Meet', kind: 'inbound' }] });
    expect([...ok.sources.keys()]).toEqual(['meet']);
    expect(() =>
      buildConnectionCatalog({ sources: [{ key: 'Meet', name: 'Meet', kind: 'inbound' }] })
    ).toThrow(/lowercase/);
    expect(() =>
      buildConnectionCatalog({
        sources: [
          { key: 'meet', name: 'Meet', kind: 'inbound' },
          { key: 'meet', name: 'Meet again', kind: 'key' }
        ]
      })
    ).toThrow(/twice/);
    expect(() =>
      buildConnectionCatalog({ sources: [{ key: 'vault', name: 'Vault', kind: 'key', verifier: 'stripe' }] })
    ).toThrow(/key source and declares a verifier/);
    expect(() =>
      buildConnectionCatalog({
        sources: [{ key: 'vault', name: 'Vault', kind: 'key', handler: async () => {} }]
      })
    ).toThrow(/key source and declares a handler/);
    expect(() =>
      buildConnectionCatalog({
        sources: [
          { key: 'meet', name: 'Meet', kind: 'inbound', probe: async () => ({ ok: true, detail: '' }) }
        ]
      })
    ).toThrow(/inbound source and declares a probe/);
    expect(() =>
      buildConnectionCatalog({
        sources: [
          {
            key: 'vault',
            name: 'Vault',
            kind: 'key',
            fields: [
              { key: 'a', label: 'A' },
              { key: 'a', label: 'B' }
            ]
          }
        ]
      })
    ).toThrow(/declared twice/);
    expect(buildConnectionCatalog(undefined).sources.size).toBe(0);
  });
});
