import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * API-key pepper versioning (ADR 008), proven end to end across real reboots
 * of the app against ONE database:
 *
 *  1. Zero-config backward compat — version 1 reproduces the historical
 *     computation byte-identically: sha256(secret + AUTH_SECRET) hex.
 *  2. Rotation survivability — pin v1, add v2, then ROTATE AUTH_SECRET; keys
 *     minted under both versions keep authenticating.
 *  3. Fail-closed — an unknown pepper_version answers the byte-identical 401
 *     a revoked key gets, and a v1 hash is never accepted against v2's
 *     pepper (no cross-version acceptance).
 *
 * Migration 0010 applies in this harness on every boot (backfill default 1).
 */

// Test-only throwaway values (same convention as the shared helper's secret).
const SECRET_OLD = 'rotation-old-auth-secret-0123456789abcdef01234567';
const SECRET_NEW = 'rotation-new-auth-secret-fedcba9876543210fedcba98';
const PEPPER_V2 = 'rotation-pepper-v2-abcdef0123456789abcdef012345';

const OWNER = { email: 'owner@pepper.test', name: 'Pepper Owner', password: 'pepper-owner-pass-123' };

let container: StartedPostgreSqlContainer;
let connectionString: string;
let app: TestApp;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function signIn(): Promise<string> {
  const res = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function mint(cookie: string, name: string) {
  const res = await app.app.request('/api/v1/api-keys', {
    ...json({ name, scopes: [host.scopes.read] }),
    headers: { 'content-type': 'application/json', cookie }
  });
  expect(res.status).toBe(201);
  return readJson(res);
}

async function me(key: string) {
  return app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
}

/**
 * The secret is everything after `<prefix>_<keyId>_` — sliced by length, NEVER by
 * splitting on `_` (base64url contains `_`; see LESSONS.md). keyId comes from
 * the mint response.
 */
function secretOf(minted: { key: string; apiKey: { keyId: string } }): string {
  return minted.key.slice(`${host.identity.apiKeyPrefix}_${minted.apiKey.keyId}_`.length);
}

/** Today's (pre-versioning) computation, reproduced independently. */
function legacyHash(secret: string, pepper: string): string {
  return createHash('sha256')
    .update(secret + pepper)
    .digest('hex');
}

async function keyRow(keyId: string): Promise<{ secret_hash: string; pepper_version: number }> {
  const res = await app.db.pool.query<{ secret_hash: string; pepper_version: number }>(
    'SELECT secret_hash, pepper_version FROM api_keys WHERE key_id = $1',
    [keyId]
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!;
}

/** Stop the current app and boot a fresh one against the SAME database. */
async function reboot(extraEnv: Record<string, string>): Promise<void> {
  await app.stop();
  app = await createTestApp(connectionString, extraEnv);
}

beforeAll(async () => {
  container = await startPostgres();
  connectionString = await createDatabase(container, 'pepperrotation');
  app = await createTestApp(connectionString, { AUTH_SECRET: SECRET_OLD });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Pepper', owner: OWNER })
  );
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// Shared across the sequential phases below (vitest runs this file in order).
let k1: { key: string; apiKey: { keyId: string } };
let k2: { key: string; apiKey: { keyId: string } };

describe('phase 1 — zero-config backward compatibility (no API_KEY_PEPPERS)', () => {
  it('mints at pepper_version 1 and the hash reproduces sha256(secret + AUTH_SECRET) byte-identically', async () => {
    k1 = await mint(await signIn(), 'k1-version-1');
    const row = await keyRow(k1.apiKey.keyId);
    expect(row.pepper_version).toBe(1);
    // The backward-compat proof: version 1 IS the historical computation.
    expect(row.secret_hash).toBe(legacyHash(secretOf(k1), SECRET_OLD));
  });

  it('the freshly minted key resolves', async () => {
    expect((await me(k1.key)).status).toBe(200);
  });
});

describe('phase 2 — introduce pepper v2 as current (AUTH_SECRET unchanged)', () => {
  it('boots with API_KEY_PEPPERS=2:<pepper>; the v1 key still resolves', async () => {
    await reboot({ AUTH_SECRET: SECRET_OLD, API_KEY_PEPPERS: `2:${PEPPER_V2}` });
    expect((await me(k1.key)).status).toBe(200);
  }, 120_000);

  it('new keys mint at version 2, hashed under the v2 pepper', async () => {
    k2 = await mint(await signIn(), 'k2-version-2');
    const row = await keyRow(k2.apiKey.keyId);
    expect(row.pepper_version).toBe(2);
    expect(row.secret_hash).toBe(legacyHash(secretOf(k2), PEPPER_V2));
    expect((await me(k2.key)).status).toBe(200);
  });

  it('no cross-version acceptance: a v1 hash presented against v2 is rejected', async () => {
    // Point k1's row at v2 — its hash was computed under v1's pepper, so
    // resolution (which uses the STORED version) must reject, not fall back.
    await app.db.pool.query('UPDATE api_keys SET pepper_version = 2 WHERE key_id = $1', [k1.apiKey.keyId]);
    expect((await me(k1.key)).status).toBe(401);
    await app.db.pool.query('UPDATE api_keys SET pepper_version = 1 WHERE key_id = $1', [k1.apiKey.keyId]);
    expect((await me(k1.key)).status).toBe(200);
  });
});

describe('phase 3 — rotate AUTH_SECRET with v1 pinned (the runbook)', () => {
  it('BOTH keys survive the rotation, each via its stored version', async () => {
    await reboot({
      AUTH_SECRET: SECRET_NEW, // rotated!
      API_KEY_PEPPERS: `1:${SECRET_OLD};2:${PEPPER_V2}` // v1 pinned to the historical pepper
    });
    expect((await me(k1.key)).status).toBe(200); // v1 via the pinned pepper
    expect((await me(k2.key)).status).toBe(200); // v2 via its own pepper
  }, 120_000);

  it('an unknown pepper_version fails closed with the byte-identical 401 of a revoked key', async () => {
    // Sessions died with the AUTH_SECRET rotation (expected, out of scope) —
    // a fresh password sign-in works and mints under the current version (2).
    const cookie = await signIn();
    const orphan = await mint(cookie, 'orphan-unknown-version');
    const revoked = await mint(cookie, 'revoked-control');
    expect((await keyRow(orphan.apiKey.keyId)).pepper_version).toBe(2);

    await app.db.pool.query('UPDATE api_keys SET pepper_version = 9 WHERE key_id = $1', [
      orphan.apiKey.keyId
    ]);
    const revokeRes = await app.app.request(`/api/v1/api-keys/${revoked.apiKey.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(revokeRes.status).toBe(200);

    const orphanRes = await me(orphan.key);
    const revokedRes = await me(revoked.key);
    expect(orphanRes.status).toBe(401); // never a crash, never another pepper
    expect(revokedRes.status).toBe(401);
    // One fail-closed path: the raw bodies must be byte-identical.
    expect(await orphanRes.text()).toBe(await revokedRes.text());
  });
});
