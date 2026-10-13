import { describe, expect, it } from 'vitest';
import { createSecretBox, SecretBoxError } from '../../src/secret-box.js';

/**
 * The readable-secret box: AES-256-GCM under an HKDF key per (auth secret,
 * info). Every refusal is a SecretBoxError, a malformed string included, and
 * nothing that was changed ever opens to garbage.
 */

const AUTH_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';
const INFO = 'webhooks:signing-secret';
const PLAIN = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const box = createSecretBox(AUTH_SECRET, INFO);

/** Flip one bit of the decoded bytes of part `index` (1 = iv, 2 = tag, 3 = ciphertext). */
function flipByte(sealed: string, index: 1 | 2 | 3): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[index]!, 'base64url');
  bytes[0] = bytes[0]! ^ 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

function expectRefused(open: () => string): void {
  let thrown: unknown;
  try {
    open();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SecretBoxError);
}

describe('createSecretBox', () => {
  it('round-trips a value', () => {
    expect(box.open(box.seal(PLAIN))).toBe(PLAIN);
  });

  it('round-trips the empty string', () => {
    expect(box.open(box.seal(''))).toBe('');
  });

  it('spells v1.<iv>.<tag>.<ciphertext> in base64url without the plaintext', () => {
    const sealed = box.seal(PLAIN);
    const parts = sealed.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(16);
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('MfKQ9r8');
  });

  it('seals one value twice to two different strings, both of which open', () => {
    const first = box.seal(PLAIN);
    const second = box.seal(PLAIN);
    expect(first).not.toBe(second);
    expect(first.split('.')[1]).not.toBe(second.split('.')[1]);
    expect(box.open(first)).toBe(PLAIN);
    expect(box.open(second)).toBe(PLAIN);
  });

  it.each([
    ['the iv', 1],
    ['the tag', 2],
    ['the ciphertext', 3]
  ] as const)('refuses a flipped byte in %s', (_name, index) => {
    const sealed = box.seal(PLAIN);
    expectRefused(() => box.open(flipByte(sealed, index)));
  });

  it('refuses a value sealed under another info', () => {
    const other = createSecretBox(AUTH_SECRET, 'webhooks:other-purpose');
    expectRefused(() => other.open(box.seal(PLAIN)));
    expectRefused(() => box.open(other.seal(PLAIN)));
  });

  it('refuses a value sealed under another auth secret', () => {
    const other = createSecretBox('another-auth-secret-0123456789abcdef0123456789', INFO);
    expectRefused(() => other.open(box.seal(PLAIN)));
  });

  it('opens a value sealed by another box of the same auth secret and info', () => {
    const twin = createSecretBox(AUTH_SECRET, INFO);
    expect(twin.open(box.seal(PLAIN))).toBe(PLAIN);
  });

  it('keeps unicode plaintext intact', () => {
    const unicode = 'clé secrète: 🔐 — 秘密 — Ωμέγα\u0000end';
    expect(box.open(box.seal(unicode))).toBe(unicode);
  });

  describe('a malformed string is a SecretBoxError and nothing else', () => {
    const sealed = box.seal(PLAIN);
    const [, iv, tag, ciphertext] = sealed.split('.') as [string, string, string, string];
    const cases: Array<[string, unknown]> = [
      ['the empty string', ''],
      ['no separators', 'garbage'],
      ['three parts', `v1.${iv}.${tag}`],
      ['five parts', `${sealed}.extra`],
      ['an unknown version', `v2.${iv}.${tag}.${ciphertext}`],
      ['an empty version', `.${iv}.${tag}.${ciphertext}`],
      ['a short iv', `v1.${iv.slice(0, 8)}.${tag}.${ciphertext}`],
      ['a long iv', `v1.${iv}AAAA.${tag}.${ciphertext}`],
      ['an empty iv', `v1..${tag}.${ciphertext}`],
      ['a short tag', `v1.${iv}.${tag.slice(0, 10)}.${ciphertext}`],
      ['an empty tag', `v1.${iv}..${ciphertext}`],
      ['an empty ciphertext', `v1.${iv}.${tag}.`],
      ['a character outside base64url', `v1.${iv}.${tag}.${ciphertext}*`],
      ['standard base64 characters', `v1.${iv}.${tag}.+/${ciphertext}`],
      ['a non-string', null],
      ['a number', 42]
    ];
    it.each(cases)('refuses %s', (_name, input) => {
      expectRefused(() => box.open(input as string));
    });
  });

  it('refuses an empty auth secret or an empty info', () => {
    expect(() => createSecretBox('', INFO)).toThrow(SecretBoxError);
    expect(() => createSecretBox(AUTH_SECRET, '')).toThrow(SecretBoxError);
  });
});
