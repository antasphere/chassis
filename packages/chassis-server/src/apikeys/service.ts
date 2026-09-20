import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { apiKeys, type Db } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import {
  isWorkspaceSelector,
  resolveMembership,
  type OnWorkspaceMiss
} from '../identity/resolve-membership.js';
import type { PepperRegistry } from './peppers.js';

/**
 * API keys: `<prefix>_<keyId8>_<secret>`.
 *
 * The prefix is the TOOL's (`identity.apiKeyPrefix`, e.g. a product called
 * Acme might use `acm`): a constructor value with no default, so the chassis
 * spells none. The shape is fixed: keyId gives an O(1)
 * indexed lookup, the secret is stored as sha256(secret + pepper) and
 * compared constant-time. The pepper defaults to the server auth secret, so
 * a leaked database alone cannot validate keys — and it is VERSIONED
 * (peppers.ts, ADR 008): each row records the pepper version that hashed it,
 * mint uses the registry's current version, and resolution uses the stored
 * version's pepper or fails closed. Keys are minted by sessions only.
 *
 * A key is a USER credential (user-scoped credential model): it acts as its
 * creator, and the target workspace resolves per request through the shared
 * resolveMembership rule — the X-Workspace-Id header, else the creator's
 * default membership. `workspace_id` on the row is an OPTIONAL PIN (least
 * privilege, and the grandfathered binding of pre-model-change keys): a
 * pinned key resolves ONLY its pinned workspace, and a request naming a
 * DIFFERENT one is rejected loudly (WorkspaceMismatchError → 403).
 */
const KEY_ID_BYTES = 6; // 8 chars base64url
const SECRET_BYTES = 32; // 43 chars base64url

/** The prefix is a literal in the pattern: every RegExp metacharacter in it is escaped. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The key shape for one prefix: `<prefix>_<keyId8>_<secret>`, two capture groups. */
const keyPattern = (prefix: string): RegExp =>
  new RegExp(`^${escapeRegExp(prefix)}_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{20,})$`);

/**
 * A VALID pinned key presented with an X-Workspace-Id naming a different
 * workspace — a client bug or a confused-deputy attempt. Distinct from a
 * plain resolution miss (null → 401) so the middleware can answer the loud
 * 403 the pinned model always answered.
 */
export class WorkspaceMismatchError extends Error {
  constructor() {
    super('This credential is pinned to a different workspace');
    this.name = 'WorkspaceMismatchError';
  }
}

function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256')
    .update(secret + pepper)
    .digest('hex');
}

export interface MintedKey {
  id: string;
  keyId: string;
  /** The full key — returned once, never stored. */
  key: string;
}

export class ApiKeyService {
  private readonly keyRe: RegExp;

  constructor(
    private readonly db: Db,
    private readonly peppers: PepperRegistry,
    /** The tool's key prefix, without the underscore (`identity.apiKeyPrefix`). Required: no chassis default. */
    private readonly prefix: string,
    /** Cloud only: one cached reconcile on a well-formed selector miss. */
    private readonly onWorkspaceMiss?: OnWorkspaceMiss | undefined
  ) {
    if (!prefix) throw new Error('ApiKeyService: the key prefix is required');
    this.keyRe = keyPattern(prefix);
  }

  /** Distinguishes an API-key credential from other bearers (the shape only, no lookup). */
  readonly isToken = (token: string): boolean => this.keyRe.test(token);

  async mint(opts: {
    /** Optional workspace PIN — omitted/null mints a user-scoped key. */
    workspaceId?: string | null;
    createdBy: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
  }): Promise<MintedKey> {
    const keyId = randomBytes(KEY_ID_BYTES).toString('base64url');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    // Mint always hashes under the CURRENT pepper version and records which
    // one, so resolution can keep verifying old keys across pepper rotations.
    const pepperVersion = this.peppers.current;
    const pepper = this.peppers.get(pepperVersion);
    if (pepper === undefined) throw new Error(`pepper registry has no current version ${pepperVersion}`);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        workspaceId: opts.workspaceId ?? null,
        keyId,
        secretHash: hashSecret(secret, pepper),
        pepperVersion,
        name: opts.name,
        scopes: opts.scopes,
        createdBy: opts.createdBy,
        expiresAt: opts.expiresAt ?? null
      })
      .returning({ id: apiKeys.id });
    if (!row) throw new Error('api key insert failed');
    return { id: row.id, keyId, key: `${this.prefix}_${keyId}_${secret}` };
  }

  /**
   * Resolve a presented key to a live principal, or null. The key dies with
   * its creator: a live active membership is required (same re-check
   * discipline as sessions).
   *
   * `requested` is the request's X-Workspace-Id (or null). An UNPINNED key
   * selects with it exactly like a session (fail closed on non-membership);
   * a PINNED key always resolves its pin and THROWS WorkspaceMismatchError
   * when `requested` names a different workspace — never silently serves
   * the pinned one.
   */
  async resolve(token: string, requested: string | null): Promise<Principal | null> {
    const match = this.keyRe.exec(token);
    if (!match) return null;
    const [, keyId, secret] = match;
    if (!keyId || !secret) return null;

    const [row] = await this.db
      .select({
        id: apiKeys.id,
        secretHash: apiKeys.secretHash,
        pepperVersion: apiKeys.pepperVersion,
        workspaceId: apiKeys.workspaceId,
        scopes: apiKeys.scopes,
        createdBy: apiKeys.createdBy,
        expiresAt: apiKeys.expiresAt
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          isNull(apiKeys.revokedAt),
          // Expired = same lookup miss as revoked — one fail-closed 401, no
          // behavioural fork. DB clock, not app clock.
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`))
        )
      )
      .limit(1);
    if (!row) return null;

    // Verify under the pepper version THIS row was hashed with — never the
    // current one, never a fallback. An unknown version (e.g. the operator
    // dropped a retired pepper from API_KEY_PEPPERS while such keys remain)
    // FAILS CLOSED: same null → same 401 as a revoked or expired key.
    const pepper = this.peppers.get(row.pepperVersion);
    if (pepper === undefined) return null;

    const presented = Buffer.from(hashSecret(secret, pepper), 'hex');
    const stored = Buffer.from(row.secretHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

    // Live membership through the shared selection rule. A pinned key's pin
    // IS the selector (fail-closed on the live membership, as always); an
    // unpinned key selects like a session. Guest capability limits (D2) bind
    // machine credentials too — the origin of the LIVE membership rides the
    // principal, and accountRef carries the projection id the cloud live
    // gate keys on (internal/federation.md).
    const selector = row.workspaceId ?? requested;
    let member = await resolveMembership(this.db, row.createdBy, selector);
    if (!member && selector && this.onWorkspaceMiss && isWorkspaceSelector(selector)) {
      // Unknown-workspace retry (cloud): the KEY verified above — the miss
      // may be a hub org granted since the last reconcile pass. One cached
      // reconcile, one re-run of the SAME lookup — no recursion. Covers the
      // pin too: a pinned key into a freshly granted hub org resolves.
      await this.onWorkspaceMiss(row.createdBy, selector);
      member = await resolveMembership(this.db, row.createdBy, selector);
    }
    if (!member) return null;
    // A valid PINNED key + a header naming another workspace: reject loudly
    // (the pre-model-change contract). Checked after the membership resolves
    // so a dead key/membership stays the uniform 401, exactly as before.
    if (row.workspaceId && requested && requested.toLowerCase() !== row.workspaceId.toLowerCase()) {
      throw new WorkspaceMismatchError();
    }

    // Advisory only — never correctness-load-bearing (statelessness invariant).
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, row.id))
      .catch(() => {});

    return {
      userId: row.createdBy,
      email: member.email,
      name: member.name,
      workspaceId: member.workspaceId,
      role: member.role,
      origin: member.origin,
      via: 'api_key',
      scopes: new Set(row.scopes),
      apiKeyId: row.id,
      ...(row.expiresAt ? { apiKeyExpiresAt: row.expiresAt.toISOString() } : {}),
      ...(member.accountRef ? { accountRef: member.accountRef } : {})
    };
  }
}
