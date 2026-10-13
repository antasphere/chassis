import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  signWebhook,
  SigningError,
  verifyWebhookSignature,
  WEBHOOK_SECRET_PREFIX,
  webhookHeaders,
  webhookSecretKey
} from '../../src/webhooks/signing.js';

/**
 * Standard Webhooks, the symmetric v1 scheme. The vector is the one the
 * reference libraries pin (standard-webhooks/standard-webhooks,
 * libraries/javascript/src/webhook.test.ts and the python twin), so a receiver
 * using any of them verifies what this signs.
 */

const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
};

const NOW = VECTOR.timestamp;

function headersOf(signature: string, id = VECTOR.id, timestamp = String(VECTOR.timestamp)) {
  return { id, timestamp, signature };
}

describe('Standard Webhooks signing', () => {
  it("reproduces the reference libraries' vector", () => {
    expect(signWebhook([VECTOR.secret], VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
    expect(
      verifyWebhookSignature(VECTOR.secret, headersOf(VECTOR.signature), VECTOR.body, { nowSeconds: NOW })
    ).toBe(true);
  });

  it('generates a prefixed secret of 32 base64 characters holding 24 bytes', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(encoded, 'base64')).toHaveLength(24);
    expect(webhookSecretKey(secret)).toHaveLength(24);
    expect(generateWebhookSecret()).not.toBe(secret);
  });

  it('signs with two secrets as two entries, each verifying alone', () => {
    const [a, b] = [generateWebhookSecret(), generateWebhookSecret()];
    const header = signWebhook([a, b], VECTOR.id, NOW, VECTOR.body);
    const entries = header.split(' ');
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    expect(entries[0]).toBe(signWebhook([a], VECTOR.id, NOW, VECTOR.body));
    expect(entries[1]).toBe(signWebhook([b], VECTOR.id, NOW, VECTOR.body));
    for (const secret of [a, b]) {
      expect(verifyWebhookSignature(secret, headersOf(header), VECTOR.body, { nowSeconds: NOW })).toBe(true);
    }
    expect(
      verifyWebhookSignature(generateWebhookSecret(), headersOf(header), VECTOR.body, { nowSeconds: NOW })
    ).toBe(false);
  });

  it('builds the three headers and the content type', () => {
    expect(webhookHeaders([VECTOR.secret], VECTOR.id, VECTOR.timestamp, VECTOR.body)).toEqual({
      'webhook-id': VECTOR.id,
      'webhook-timestamp': '1614265330',
      'webhook-signature': VECTOR.signature,
      'content-type': 'application/json'
    });
  });

  it('fails on a changed body, id or timestamp', () => {
    const verify = (headers: ReturnType<typeof headersOf>, body = VECTOR.body) =>
      verifyWebhookSignature(VECTOR.secret, headers, body, { nowSeconds: NOW });
    expect(verify(headersOf(VECTOR.signature), '{"test": 2432232315}')).toBe(false);
    expect(verify(headersOf(VECTOR.signature), `${VECTOR.body} `)).toBe(false);
    expect(verify(headersOf(VECTOR.signature, 'msg_p5jXN8AQM9LWM0D4loKWxJel'))).toBe(false);
    expect(verify(headersOf(VECTOR.signature, VECTOR.id, String(VECTOR.timestamp + 1)))).toBe(false);
    expect(verify(headersOf('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OA='))).toBe(false);
  });

  it('fails on a timestamp older or newer than the tolerance, passes at its edge', () => {
    const header = headersOf(VECTOR.signature);
    const verifyAt = (nowSeconds: number, toleranceSeconds?: number) =>
      verifyWebhookSignature(VECTOR.secret, header, VECTOR.body, {
        nowSeconds,
        ...(toleranceSeconds === undefined ? {} : { toleranceSeconds })
      });
    expect(verifyAt(NOW + 300)).toBe(true);
    expect(verifyAt(NOW - 300)).toBe(true);
    expect(verifyAt(NOW + 301)).toBe(false);
    expect(verifyAt(NOW - 301)).toBe(false);
    expect(verifyAt(NOW + 60, 30)).toBe(false);
    expect(verifyAt(NOW + 60, 90)).toBe(true);
    // The default clock is now: a 2021 timestamp is long stale.
    expect(verifyWebhookSignature(VECTOR.secret, header, VECTOR.body)).toBe(false);
  });

  it('fails on a timestamp that is not whole unix seconds', () => {
    for (const timestamp of ['', 'abc', '1614265330.0', '-1614265330', ' 1614265330', '1614265330000000']) {
      expect(
        verifyWebhookSignature(
          VECTOR.secret,
          headersOf(VECTOR.signature, VECTOR.id, timestamp),
          VECTOR.body,
          {
            nowSeconds: NOW
          }
        )
      ).toBe(false);
    }
  });

  it('verifies a v1 entry beside a v2 entry, and ignores a lone v2 or a malformed entry', () => {
    const v1 = VECTOR.signature.slice(3);
    const verify = (signature: string) =>
      verifyWebhookSignature(VECTOR.secret, headersOf(signature), VECTOR.body, { nowSeconds: NOW });
    expect(verify(`v2,${v1} ${VECTOR.signature}`)).toBe(true);
    expect(verify(`${VECTOR.signature} v2,AAAA`)).toBe(true);
    expect(verify(`v1a,${v1}`)).toBe(false);
    expect(verify(`v2,${v1}`)).toBe(false);
    expect(verify(v1)).toBe(false);
    expect(verify('')).toBe(false);
  });

  it('throws SigningError malformed_secret on a malformed secret', () => {
    const malformed = [
      'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', // no prefix
      'whsk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', // wrong prefix
      'whsec_', // nothing after the prefix
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS', // a length that is not base64
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLa*w', // a character outside the alphabet
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLa_w', // base64url, not standard
      'whsec_AAAAAAAAAAAAAAAAAAAAAA==', // 16 bytes, under the spec's 24
      `whsec_${Buffer.alloc(65).toString('base64')}` // over the spec's 64
    ];
    for (const secret of malformed) {
      let thrown: unknown;
      try {
        webhookSecretKey(secret);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, secret).toBeInstanceOf(SigningError);
      expect((thrown as SigningError).code).toBe('malformed_secret');
      expect(() => signWebhook([secret], VECTOR.id, NOW, VECTOR.body)).toThrow(SigningError);
      expect(() =>
        verifyWebhookSignature(secret, headersOf(VECTOR.signature), VECTOR.body, { nowSeconds: NOW })
      ).toThrow(SigningError);
    }
  });

  it('refuses to sign with no secret, or with a timestamp that is not whole seconds', () => {
    let thrown: unknown;
    try {
      signWebhook([], VECTOR.id, NOW, VECTOR.body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SigningError);
    expect((thrown as SigningError).code).toBe('no_secret');
    expect(() => signWebhook([VECTOR.secret], VECTOR.id, NOW + 0.5, VECTOR.body)).toThrow(RangeError);
    expect(() => signWebhook([VECTOR.secret], VECTOR.id, -1, VECTOR.body)).toThrow(RangeError);
  });
});
