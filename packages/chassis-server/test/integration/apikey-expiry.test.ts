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
 * API-key expiry, end to end: the TTL at mint becomes an absolute expires_at,
 * resolution rejects an expired key with EXACTLY the revoked key's 401 (one
 * fail-closed path, no behavioural fork), and the nightly sweep normalizes
 * expired keys to revoked_at without touching live ones.
 */

const OWNER = { email: 'owner@expiry.test', name: 'Expiry Owner', password: 'expiry-owner-pass-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function mint(body: Record<string, unknown>) {
  return app.app.request('/api/v1/api-keys', {
    ...json(body),
    headers: { 'content-type': 'application/json', cookie: ownerCookie }
  });
}

async function me(key: string) {
  return app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
}

async function expiresAtOf(keyId: string): Promise<Date | null> {
  const res = await app.db.pool.query<{ expires_at: Date | null }>(
    'SELECT expires_at FROM api_keys WHERE key_id = $1',
    [keyId]
  );
  return res.rows[0]?.expires_at ?? null;
}

async function revokedAtOf(keyId: string): Promise<Date | null> {
  const res = await app.db.pool.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM api_keys WHERE key_id = $1',
    [keyId]
  );
  return res.rows[0]?.revoked_at ?? null;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'apikeyexpiry'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Expiry', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('minting with a TTL', () => {
  it('computes an absolute expiry ~expiresInDays out and surfaces it in the list', async () => {
    const res = await mint({ name: 'seven-days', scopes: [host.scopes.read], expiresInDays: 7 });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.apiKey.expiresAt).toBeTruthy();
    const expected = Date.now() + 7 * 86_400_000;
    expect(Math.abs(new Date(body.apiKey.expiresAt).getTime() - expected)).toBeLessThan(5 * 60_000);

    const list = await readJson(
      await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie } })
    );
    const listed = list.apiKeys.find((k: { id: string }) => k.id === body.apiKey.id);
    expect(listed?.expiresAt).toBe(body.apiKey.expiresAt);
  });

  it('omitting the TTL mints a never-expiring key', async () => {
    const res = await mint({ name: 'forever', scopes: [host.scopes.read] });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.apiKey.expiresAt).toBeNull();
  });

  it('rejects expiresInDays: 0 as a validation error', async () => {
    const res = await mint({ name: 'zero-days', scopes: [host.scopes.read], expiresInDays: 0 });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('validation_error');
  });
});

describe('resolution treats expired exactly like revoked', () => {
  it('answers an expired key with the identical 401 body a revoked key gets', async () => {
    const expired = await readJson(
      await mint({ name: 'to-expire', scopes: [host.scopes.read], expiresInDays: 7 })
    );
    const revoked = await readJson(await mint({ name: 'to-revoke', scopes: [host.scopes.read] }));

    // Both keys are live before their terminal states.
    expect((await me(expired.key)).status).toBe(200);
    expect((await me(revoked.key)).status).toBe(200);

    await app.db.pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE key_id = $1`, [
      expired.apiKey.keyId
    ]);
    const revokeRes = await app.app.request(`/api/v1/api-keys/${revoked.apiKey.id}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(revokeRes.status).toBe(200);

    const expiredRes = await me(expired.key);
    const revokedRes = await me(revoked.key);
    expect(expiredRes.status).toBe(401);
    expect(revokedRes.status).toBe(401);
    // Same fail-closed path: the bodies must be indistinguishable.
    expect(await readJson(expiredRes)).toEqual(await readJson(revokedRes));
  });

  it('a key expiring in the future still resolves and reports its expiry on /me', async () => {
    const minted = await readJson(await mint({ name: 'boundary', scopes: [host.scopes.read] }));
    await app.db.pool.query(`UPDATE api_keys SET expires_at = now() + interval '1 hour' WHERE key_id = $1`, [
      minted.apiKey.keyId
    ]);
    const res = await me(minted.key);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.apiKeyExpiresAt).toBeTruthy();
    expect(new Date(body.apiKeyExpiresAt).toISOString()).toBe(body.apiKeyExpiresAt);
  });
});

describe('nightly expiry sweep', () => {
  it('normalizes expired keys to revoked_at = expires_at and leaves live keys alone', async () => {
    const doomed = await readJson(
      await mint({ name: 'sweep-doomed', scopes: [host.scopes.read], expiresInDays: 7 })
    );
    const survivor = await readJson(
      await mint({ name: 'sweep-survivor', scopes: [host.scopes.read], expiresInDays: 7 })
    );
    await app.db.pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE key_id = $1`, [
      doomed.apiKey.keyId
    ]);

    // Trigger the worker's sweep handler out of band (the schedule is 03:00).
    await app.jobs.boss.send('apikey-expiry-sweep', {});

    const deadline = Date.now() + 15_000;
    let revokedAt: Date | null = null;
    while (!revokedAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      revokedAt = await revokedAtOf(doomed.apiKey.keyId);
    }
    const expiresAt = await expiresAtOf(doomed.apiKey.keyId);
    expect(revokedAt).not.toBeNull();
    expect(revokedAt!.getTime()).toBe(expiresAt!.getTime());

    // The unexpired key is untouched.
    expect(await revokedAtOf(survivor.apiKey.keyId)).toBeNull();
  }, 30_000);
});
