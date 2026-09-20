import { desc, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { jwks, type Db } from '@antasphere/chassis-db';

/**
 * OAuth signing-key durability across AUTH_SECRET rotation (ADR 023).
 *
 * The jwt plugin stores its RS256 private key in the `jwks` table encrypted
 * under the auth secret (bare xchacha20 ciphertext — createAuth passes a
 * plain string `secret`, so no versioned envelope). Signing decrypts the
 * NEWEST row on every mint; with no `rotationInterval` the row never
 * expires, so a rotated AUTH_SECRET turns every token mint into a 500 —
 * forever. The three exports here close that:
 *
 *  - `preflightSigningKey` mirrors the plugin's signing path (newest
 *    non-expired row → decrypt) at boot and reports failure BEFORE the
 *    instance serves an authorize endpoint it cannot follow with a token.
 *  - `rotateSigningKey` mints a fresh RS256 key under the CURRENT secret —
 *    the same row shape the plugin's own createJwk writes, so the plugin
 *    signs with it immediately (newest createdAt wins). Retired rows stay in
 *    the table, and /jwks publishes every row without an expiresAt, so
 *    already-issued tokens keep verifying for as long as the old row stays —
 *    the publish-overlap window.
 *  - `retireSigningKey` deletes ONE named retired row after the overlap
 *    window; the newest (active signer) is refused.
 *
 * Everything here mirrors the pinned better-auth 1.6.15 jwt plugin
 * (plugins/jwt/{sign,utils,adapter}.mjs) — re-verify the row shape, the
 * newest-key selection, and the /jwks publish filter on ANY bump.
 */

/** The alg the chassis pins in `jwks.keyPairConfig` (identity/better-auth.ts). */
const SIGNING_ALG = 'RS256';

export type SigningKeyPreflight =
  { ok: true; kid: string | null } | { ok: false; kid: string; reason: string };

/**
 * The operator-facing diagnostic — names the cause and BOTH safe remedies.
 * Kept in one place so boot's fatal log and the tests pin the same message.
 */
export function signingKeyPreflightMessage(kid: string): string {
  return (
    `OAuth signing-key preflight failed: the stored JWKS private key (kid ${kid}) ` +
    'cannot be decrypted with the current AUTH_SECRET. This happens when AUTH_SECRET ' +
    'was rotated without re-keying token signing; booting anyway would serve an ' +
    'authorize endpoint whose every token mint (POST /oauth2/token) answers 500. ' +
    'Remedies: restore the previous AUTH_SECRET, or mint a fresh signing key under ' +
    'the current secret with `node dist/index.js rotate-signing-key` — the retired ' +
    'key stays published on /jwks so already-issued tokens keep verifying ' +
    '(internal/security-runbooks.md).'
  );
}

/**
 * Boot preflight: attempt one decrypt of the key the jwt plugin would sign
 * with. Exactly the plugin's selection rule (sign.mjs): newest by createdAt;
 * a missing table-or-row and an EXPIRED newest row are both fine — the next
 * mint creates a fresh key under the current secret.
 */
export async function preflightSigningKey(db: Db, authSecret: string): Promise<SigningKeyPreflight> {
  const [latest] = await db
    .select({ id: jwks.id, privateKey: jwks.privateKey, expiresAt: jwks.expiresAt })
    .from(jwks)
    .orderBy(desc(jwks.createdAt))
    .limit(1);
  if (!latest) return { ok: true, kid: null };
  if (latest.expiresAt && latest.expiresAt < new Date()) return { ok: true, kid: null };
  try {
    // The plugin stores JSON.stringify(symmetricEncrypt(...)) — decrypt takes
    // the JSON.parse'd string (sign.mjs).
    await symmetricDecrypt({ key: authSecret, data: JSON.parse(latest.privateKey) as string });
    return { ok: true, kid: latest.id };
  } catch {
    return { ok: false, kid: latest.id, reason: signingKeyPreflightMessage(latest.id) };
  }
}

/**
 * Mint a new signing key under the given secret — the manual rotation step
 * (a compromise drill, or re-keying after an AUTH_SECRET change). Mirrors
 * the plugin's createJwk (utils.mjs): extractable RS256 pair, JWK-exported,
 * private half encrypted exactly as the plugin decrypts it. The new row's
 * createdAt makes it the active signer; every older row stays published on
 * /jwks (the overlap) until explicitly retired.
 */
export async function rotateSigningKey(db: Db, authSecret: string): Promise<{ kid: string }> {
  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  const publicWebKey = await exportJWK(publicKey);
  const privateWebKey = await exportJWK(privateKey);
  const kid = generateRandomString(32, 'a-z', 'A-Z', '0-9');
  await db.insert(jwks).values({
    id: kid,
    publicKey: JSON.stringify(publicWebKey),
    privateKey: JSON.stringify(
      await symmetricEncrypt({ key: authSecret, data: JSON.stringify(privateWebKey) })
    ),
    createdAt: new Date(),
    expiresAt: null
  });
  return { kid };
}

/**
 * Delete ONE retired key by kid, after the overlap window. Refuses the
 * newest row: deleting the active signer would silently re-key the instance
 * on the next mint with zero coordination — the exact failure the preflight
 * exists to prevent.
 */
export async function retireSigningKey(db: Db, kid: string): Promise<void> {
  const [latest] = await db.select({ id: jwks.id }).from(jwks).orderBy(desc(jwks.createdAt)).limit(1);
  if (!latest) throw new Error('no signing keys exist');
  if (latest.id === kid) {
    throw new Error(
      `refusing to retire ${kid}: it is the ACTIVE signing key (newest row). ` +
        'Mint a replacement first with rotate-signing-key, wait out the overlap window, then retire.'
    );
  }
  const deleted = await db.delete(jwks).where(eq(jwks.id, kid)).returning({ id: jwks.id });
  if (deleted.length === 0) throw new Error(`no signing key with kid ${kid}`);
}

/**
 * `node dist/index.js rotate-signing-key [--retire <kid>]` — the operator
 * entry point (index.ts). Runs against the container's own env (DATABASE_URL
 * + AUTH_SECRET/DATA_DIR), so `docker compose run --rm app …` works while
 * the server is down — the state the preflight refusal leaves you in.
 * Output goes to stdout on purpose: this is an interactive operator command,
 * not the service log.
 */
export async function runSigningKeyCli(
  db: Db,
  authSecret: string,
  args: readonly string[],
  out: (line: string) => void
): Promise<number> {
  const retireAt = args.indexOf('--retire');
  if (retireAt !== -1) {
    const kid = args[retireAt + 1];
    if (!kid) {
      out('usage: rotate-signing-key --retire <kid>');
      return 1;
    }
    await retireSigningKey(db, kid);
    out(`retired signing key ${kid} — it is no longer published on /jwks; tokens it signed no longer verify`);
    return 0;
  }

  const before = await db.select({ id: jwks.id }).from(jwks).orderBy(desc(jwks.createdAt));
  const { kid } = await rotateSigningKey(db, authSecret);
  out(`minted new signing key ${kid} under the current AUTH_SECRET — it signs from the next mint on`);
  if (before.length > 0) {
    out(
      `retired key(s) still published for the overlap window (already-issued tokens keep verifying): ` +
        before.map((k) => k.id).join(', ')
    );
    out(
      'after the overlap window (outstanding access tokens live 15 min; allow for external JWKS caches), ' +
        'retire each with: rotate-signing-key --retire <kid>'
    );
  }
  return 0;
}
