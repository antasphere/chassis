import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyWebhookSignature } from '../webhooks/signing.js';
import type { ConnectionVerifier, ConnectionVerifierName } from './catalog.js';

/**
 * The verifiers the door knows by name (PRDCT-3773). Each one judges a
 * delivery on its RAW body with the opened secret, in constant time, with a
 * timestamp tolerance, and answers the sender's delivery id when the scheme
 * carries one in a header. A refusal writes nothing at the door.
 */

/** The tolerance either way between the sender's timestamp and this clock. */
export const CONNECTION_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Standard Webhooks (the symmetric `v1` scheme, what the chassis's own
 * outbound webhooks send): `webhook-id`, `webhook-timestamp`,
 * `webhook-signature` with any `v1,` entry equal to the HMAC-SHA256 of
 * `id.timestamp.body` under the `whsec_` secret's bytes. The id is the
 * `webhook-id` header.
 */
export const standardWebhooksVerifier: ConnectionVerifier = ({ secret, header, rawBody, nowSeconds }) => {
  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signature = header('webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, code: 'missing_headers' };
  let ok: boolean;
  try {
    ok = verifyWebhookSignature(secret, { id, timestamp, signature }, rawBody, {
      nowSeconds,
      toleranceSeconds: CONNECTION_TIMESTAMP_TOLERANCE_SECONDS
    });
  } catch {
    // A secret that is not a `whsec_` value (the signing helper refuses it): nothing verifies.
    ok = false;
  }
  return ok ? { ok: true, id: id.slice(0, 200) } : { ok: false, code: 'invalid_signature' };
};

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Stripe's scheme (ADR 023's door, as the hub verifies it): one header,
 * `stripe-signature: t=<seconds>,v1=<hex>[,v1=<hex>]`, each `v1` the
 * HMAC-SHA256 of `t.body` under the signing secret's text (`whsec_…` as
 * Stripe spells it, the whole string the key). The delivery id is the
 * body's `id`, read by the door after the parse.
 */
export const stripeVerifier: ConnectionVerifier = ({ secret, header, rawBody, nowSeconds }) => {
  const raw = header('stripe-signature');
  if (!raw) return { ok: false, code: 'missing_headers' };
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (t === null || v1.length === 0 || !/^\d{1,15}$/.test(t)) return { ok: false, code: 'missing_headers' };
  if (Math.abs(nowSeconds - Number(t)) > CONNECTION_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, code: 'invalid_signature' };
  }
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  let verified = false;
  for (const given of v1) if (constantTimeEquals(given, expected)) verified = true;
  return verified ? { ok: true } : { ok: false, code: 'invalid_signature' };
};

export const NAMED_VERIFIERS: Record<ConnectionVerifierName, ConnectionVerifier> = {
  'standard-webhooks': standardWebhooksVerifier,
  stripe: stripeVerifier
};
