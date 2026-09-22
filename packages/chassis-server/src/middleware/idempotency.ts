import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pendingBodyRefusal } from './body-refusal.js';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, type Db } from '@antasphere/chassis-db';
import { apiError } from '../api/errors.js';

/**
 * Idempotency-Key middleware: an opt-in `Idempotency-Key` request header on
 * the non-idempotent create POSTs makes a network-blip retry replay the
 * original response instead of double-creating. Claim-first: the row is
 * inserted BEFORE the handler runs (the unique index is the mutex), so two
 * concurrent requests with the same key can never both execute.
 *
 * Explicit target list, fail-closed style — only these consult it (the
 * lines that say "the tool's" are the TOOL's, declared through `toolTargets`):
 *   POST /api/v1/api-keys
 *   POST /api/v1/invitations
 *   POST /api/v1/members/{id}/reset-link
 *   POST /api/v1/members/{id}/change-email-link (FUZZ-7, PRDCT-1354: the
 *     SECOND secret-minting member route, and the more dangerous one — its
 *     token is sign-in-equivalent. Its contract has always declared
 *     `Idempotency-Key` and a 409, but the claim never covered it, so a
 *     retried mint silently produced a SECOND live sign-in-equivalent JWT
 *     that cannot be revoked, on top of the first. The two mint routes must
 *     stay listed together.)
 *   the tool's token mint on one of its resources
 *   the tool's duplicate of a resource (PRDCT-2279: one click mints
 *     one copy; a network-blip retry must not mint a second copy)
 *   POST /api/v1/workspaces (PRDCT-2444/2443: one click mints one workspace;
 *     on cloud the retry would otherwise create a second organization at
 *     the hub. The claim is scoped to the caller's CURRENT workspace + user;
 *     the cloud zero-membership session has no principal and runs unclaimed)
 *   the tool's upload reserve (a retried reserve must not leak a
 *     second session + reserved resource id)
 *   POST /api/v1/projects (one click mints one project) and
 *   POST /api/v1/projects/{id}/members (a retried add answers the first
 *     add's 201, not 409 `already_member`)
 * Deliberate NON-targets:
 *   POST /api/v1/files and the tool's asset upload — content-addressed
 *     dedupe already makes them idempotent, and upload bodies must never be
 *     buffered here;
 *   POST /api/v1/setup and /api/v1/invitations/accept — one-shot by
 *     construction (retries answer 410), and they run without a principal;
 *   the tool's version commits — one-shot (session consumed / version counter)
 *     by construction: a retry answers 409.
 *
 * The cached response body is stored AES-256-GCM ENCRYPTED: these responses
 * carry one-shot secrets (the full API key, the invitation acceptUrl token,
 * the reset link) whose plaintext is deliberately never persisted anywhere
 * else, and this cache must not become the exception. Sealed payload format:
 * `iv.ciphertext.tag`, each part base64url; key = sha256(authSecret +
 * ':idempotency'). Rotating AUTH_SECRET inside the 24h window is the same
 * hard cutover it is for API keys: `open()` fails closed (null) and the
 * stale row is dropped and re-executed.
 *
 * Accepted edge: a crash between the handler's commit and the response
 * persist leaves a claim without a response — same-key retries answer 409
 * `idempotency_in_flight` until the 24h expiry. Safe (never double-creates),
 * mildly annoying, self-healing.
 */

/** Rows live 24h (the Stripe convention); the nightly purge deletes expired ones. */
const TTL_MS = 24 * 60 * 60 * 1000;

const KEY_MAX_LENGTH = 200;

const TARGET_PATHS = new Set([
  '/api/v1/api-keys',
  '/api/v1/invitations',
  '/api/v1/workspaces',
  '/api/v1/projects'
]);
// The two member routes that MINT a credential for another user. Both are
// covered (FUZZ-7): a replayed mint hands out a second live secret, and the
// change-email JWT is stateless, so it cannot even be revoked afterwards.
const RESET_LINK_RE = /^\/api\/v1\/members\/[^/]+\/reset-link$/;
const CHANGE_EMAIL_LINK_RE = /^\/api\/v1\/members\/[^/]+\/change-email-link$/;
const PROJECT_MEMBERS_RE = /^\/api\/v1\/projects\/[^/]+\/members$/;

function isTarget(
  method: string,
  path: string,
  toolTargets: ((path: string) => boolean) | undefined
): boolean {
  return (
    method === 'POST' &&
    (TARGET_PATHS.has(path) ||
      RESET_LINK_RE.test(path) ||
      CHANGE_EMAIL_LINK_RE.test(path) ||
      PROJECT_MEMBERS_RE.test(path) ||
      (toolTargets?.(path) ?? false))
  );
}

/** AES-256-GCM key derived from the server auth secret (domain-separated). */
function keyOf(authSecret: string): Buffer {
  return createHash('sha256')
    .update(authSecret + ':idempotency')
    .digest();
}

/** Encrypt a response body for storage at rest: `iv.ciphertext.tag` base64url. */
export function seal(plain: string, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(authSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

/** Decrypt a sealed body; null on tamper, malformed input, or a wrong/rotated key. */
export function open(sealed: string, authSecret: string): string | null {
  const [iv, ciphertext, tag] = sealed.split('.');
  if (!iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(authSecret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
}

export interface IdempotencyDeps {
  db: Db;
  authSecret: string;
  /** The tool's own create POSTs that take the claim (a pure predicate over the path; POST only). */
  toolTargets?: (path: string) => boolean;
}

export function idempotency({ db, authSecret, toolTargets }: IdempotencyDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!isTarget(c.req.method, c.req.path, toolTargets)) return next();
    const key = c.req.header('idempotency-key');
    if (key === undefined) return next();
    if (key.length === 0 || key.length > KEY_MAX_LENGTH) {
      // This middleware runs before contract validation, so the header bound
      // is enforced here (the contract mirrors it for the OpenAPI document).
      return apiError(c, 400, 'invalid_idempotency_key', 'Idempotency-Key must be 1–200 characters');
    }
    const principal = c.get('principal');
    if (!principal) return next(); // the route gates 401 downstream
    // A size refusal the cap deferred to the entitlement gate is pending:
    // nothing reads this body, and a refused request claims no key
    // (PRDCT-2632; the gate refuses it).
    if (pendingBodyRefusal(c)) return next();

    // Hono caches the body: the zod validator's later c.req.json() re-reads
    // from the same cache (verified on hono 4.12), so this text() is safe.
    const bodyText = await c.req.text();
    // Raw bytes, no canonicalization: a retry that re-serializes the same
    // JSON differently hashes differently and 409s — by design.
    const requestHash = createHash('sha256')
      .update(`${c.req.method}\n${c.req.path}\n${bodyText}`)
      .digest('hex');

    const scope = and(
      eq(idempotencyKeys.workspaceId, principal.workspaceId),
      eq(idempotencyKeys.userId, principal.userId),
      eq(idempotencyKeys.key, key)
    );
    const claim = async (): Promise<string | null> => {
      const rows = await db
        .insert(idempotencyKeys)
        .values({
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          key,
          requestHash,
          expiresAt: new Date(Date.now() + TTL_MS)
        })
        .onConflictDoNothing({
          target: [idempotencyKeys.workspaceId, idempotencyKeys.userId, idempotencyKeys.key]
        })
        .returning({ id: idempotencyKeys.id });
      return rows[0]?.id ?? null;
    };

    let claimId = await claim();

    if (claimId === null) {
      // Claim lost: someone (possibly an earlier attempt of this very
      // client) holds the key. Inspect the row to replay or conflict.
      const [existing] = await db.select().from(idempotencyKeys).where(scope).limit(1);
      if (!existing) {
        // The row vanished between insert and select (raced the nightly
        // purge). Claim once more; losing again means a live concurrent racer.
        claimId = await claim();
        if (claimId === null) {
          return apiError(
            c,
            409,
            'idempotency_in_flight',
            'A request with this Idempotency-Key is in flight — retry shortly'
          );
        }
      } else if (existing.requestHash !== requestHash) {
        return apiError(
          c,
          409,
          'idempotency_key_reuse',
          'This Idempotency-Key was already used with a different request'
        );
      } else if (existing.responseStatus === null || existing.responseBodyEnc === null) {
        return apiError(
          c,
          409,
          'idempotency_in_flight',
          'The original request is still in flight — retry shortly'
        );
      } else {
        const plain = open(existing.responseBodyEnc, authSecret);
        if (plain === null) {
          // Sealed under a rotated AUTH_SECRET (documented hard cutover):
          // unrecoverable, so drop the stale row and execute afresh.
          await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
          claimId = await claim();
          if (claimId === null) {
            return apiError(
              c,
              409,
              'idempotency_in_flight',
              'A request with this Idempotency-Key is in flight — retry shortly'
            );
          }
        } else {
          c.header('idempotency-replayed', 'true');
          return c.json(JSON.parse(plain), existing.responseStatus as ContentfulStatusCode);
        }
      }
    }

    // Owner path: we hold the claim; the handler executes.
    const ownedClaimId = claimId;
    // Best-effort release: a failed request must stay retryable with the
    // same key (release errors must not mask the real outcome).
    const release = async () => {
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.id, ownedClaimId))
        .catch(() => {});
    };
    try {
      await next();
    } catch (e) {
      await release();
      throw e;
    }
    if (c.res.status >= 200 && c.res.status < 300) {
      // clone() tees the stream — the client still receives the original.
      const body = await c.res.clone().text();
      try {
        await db
          .update(idempotencyKeys)
          .set({ responseStatus: c.res.status, responseBodyEnc: seal(body, authSecret) })
          .where(eq(idempotencyKeys.id, ownedClaimId));
      } catch {
        // Best-effort, like audit: the handler's mutation has already
        // committed, so a failed persist must never turn into a 500. The
        // claim stays response-less; same-key retries 409 until expiry.
      }
    } else {
      await release();
    }
  };
}
