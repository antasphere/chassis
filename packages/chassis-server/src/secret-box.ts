import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * A box for secrets the instance must read back (a signing secret it hands to
 * a receiver, a refresh token it presents later): AES-256-GCM under a key
 * derived from the instance's auth secret by HKDF-SHA256 with a caller-given
 * `info`, so the database never holds them in the clear and a copy of the
 * database alone opens nothing. A one-way secret (a password, an API key the
 * instance only compares) never goes in here: it is hashed, not sealed.
 *
 * `info` separates the boxes: two boxes of one instance with different infos
 * derive different keys, so a value sealed for one purpose never opens under
 * another. Name it `<area>:<purpose>` and never change it once values are
 * stored under it (they would no longer open).
 *
 * A sealed value reads `v1.<iv>.<tag>.<ciphertext>`, each part base64url: a
 * fresh 12-byte IV per seal (two seals of one value differ), the 16-byte GCM
 * tag, which `open` checks before it answers anything (a changed byte
 * anywhere is refused, never decrypted to garbage). The version prefix lets a
 * later key or cipher change read the old rows. Every refusal, a malformed
 * string included, is a `SecretBoxError` and nothing else.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

/** `info` separates the boxes: two boxes of one instance with different infos never open each other's values. */
export function createSecretBox(authSecret: string, info: string): SecretBox {
  if (typeof authSecret !== 'string' || authSecret.length === 0) {
    throw new SecretBoxError('the secret box needs the auth secret');
  }
  if (typeof info !== 'string' || info.length === 0) {
    throw new SecretBoxError('the secret box needs an info string that names its purpose');
  }
  const key = Buffer.from(hkdfSync('sha256', authSecret, Buffer.alloc(0), info, KEY_BYTES));

  return {
    seal(plain: string): string {
      if (typeof plain !== 'string') throw new SecretBoxError('the secret box seals strings only');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url')
      ].join('.');
    },

    open(sealed: string): string {
      if (typeof sealed !== 'string') throw new SecretBoxError('not a sealed value');
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new SecretBoxError('not a sealed value of this version');
      }
      const [, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
      // Buffer.from skips characters outside the alphabet silently: refuse them
      // here, so only the one spelling of a sealed value opens.
      if (!BASE64URL.test(ivPart) || !BASE64URL.test(tagPart) || !BASE64URL.test(ciphertextPart)) {
        throw new SecretBoxError('a sealed value with a part that is not base64url');
      }
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      const ciphertext = Buffer.from(ciphertextPart, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretBoxError('a sealed value with a malformed iv or tag');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('the sealed value does not open under this key');
      }
    }
  };
}
