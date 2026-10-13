import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../constant-time.js';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com/, the symmetric
 * `v1` scheme): the signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256
 * keyed with the secret's raw bytes (the standard base64 after the `whsec_`
 * prefix), the timestamp in unix SECONDS. A delivery carries three headers:
 * `webhook-id`, `webhook-timestamp`, and `webhook-signature`, a space-separated
 * list of `v1,<standard base64>` entries (one per live secret, so a receiver
 * holding either the old or the new secret verifies during a rotation).
 *
 * The body is signed exactly as it is sent: the caller serialises once and
 * passes the same string here and to the request.
 */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** The spec's bounds on a secret's raw length. */
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const GENERATED_SECRET_BYTES = 24;
const DEFAULT_TOLERANCE_SECONDS = 300;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class SigningError extends Error {
  readonly code: 'malformed_secret' | 'no_secret';
  constructor(code: 'malformed_secret' | 'no_secret', message: string) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

/** A new secret: the prefix + 24 random bytes, standard base64. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(GENERATED_SECRET_BYTES).toString('base64');
}

/** The raw key bytes of a secret; throws SigningError('malformed_secret') when the prefix or the base64 is wrong. */
export function webhookSecretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new SigningError('malformed_secret', `a webhook secret starts with ${WEBHOOK_SECRET_PREFIX}`);
  }
  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
  if (encoded.length % 4 !== 0 || !STANDARD_BASE64.test(encoded)) {
    throw new SigningError('malformed_secret', 'a webhook secret is standard base64 after its prefix');
  }
  const key = Buffer.from(encoded, 'base64');
  // Buffer.from tolerates non-canonical padding bits: only the one spelling passes.
  if (key.toString('base64') !== encoded) {
    throw new SigningError('malformed_secret', 'a webhook secret is canonical standard base64');
  }
  if (key.length < MIN_SECRET_BYTES || key.length > MAX_SECRET_BYTES) {
    throw new SigningError(
      'malformed_secret',
      `a webhook secret holds ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes`
    );
  }
  return key;
}

function signature(key: Buffer, id: string, timestamp: number | string, body: string): string {
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
}

function assertTimestamp(timestampSeconds: number): void {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new RangeError('a webhook timestamp is a whole number of unix seconds');
  }
}

/** The `webhook-signature` header value: one `v1,<b64>` entry per secret, space-separated (two during a rotation overlap). */
export function signWebhook(
  secrets: readonly string[],
  id: string,
  timestampSeconds: number,
  body: string
): string {
  if (secrets.length === 0) {
    throw new SigningError('no_secret', 'a webhook is signed with at least one secret');
  }
  assertTimestamp(timestampSeconds);
  return secrets
    .map((secret) => `v1,${signature(webhookSecretKey(secret), id, timestampSeconds, body)}`)
    .join(' ');
}

/** The three Standard Webhooks headers plus content-type: { 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'content-type': 'application/json' }. */
export function webhookHeaders(
  secrets: readonly string[],
  id: string,
  timestampSeconds: number,
  body: string
): Record<string, string> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': signWebhook(secrets, id, timestampSeconds, body),
    'content-type': 'application/json'
  };
}

/**
 * A receiver's check, used by the tests and quoted in the docs: any `v1,` entry of the header verifies
 * under this secret (constant-time compare), and the timestamp is within `toleranceSeconds` (default 300)
 * of `now` (default Date.now()/1000). A malformed secret throws (a configuration error); anything wrong
 * with the headers or the body answers false.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {}
): boolean {
  const key = webhookSecretKey(secret);
  if (!/^\d{1,15}$/.test(headers.timestamp)) return false;
  const timestamp = Number(headers.timestamp);
  const now = opts.nowSeconds ?? Date.now() / 1000;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!(Math.abs(now - timestamp) <= tolerance)) return false;

  // The receiver signs the header's own text, as the sender did.
  const expected = signature(key, headers.id, headers.timestamp, body);
  let verified = false;
  for (const entry of headers.signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== 'v1') continue;
    // Every entry is compared, so the answer's timing does not tell which one matched.
    if (constantTimeEquals(entry.slice(comma + 1), expected)) verified = true;
  }
  return verified;
}
