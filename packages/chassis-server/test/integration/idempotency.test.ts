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
 * Idempotency-Key, end to end: a retried create replays the original
 * response (same one-shot secret, one DB row, no second audit row), key
 * reuse with a different body 409s, a failed request releases the claim,
 * an in-flight claim 409s, the cached body is encrypted at rest, and the
 * nightly purge drops only expired rows.
 */

const OWNER = { email: 'owner@idem.test', name: 'Idem Owner', password: 'idem-owner-pass-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let workspaceId: string;
let ownerUserId: string;

/** The minted full key from the first K1 create — the secret the cache must never store in clear. */
let k1MintedKey: string;
let k1RowId: string;

const post = (path: string, body: unknown, idempotencyKey?: string) =>
  app.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: ownerCookie,
      ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function countRows(sqlText: string, params: unknown[] = []): Promise<number> {
  const res = await app.db.pool.query<{ n: number }>(sqlText, params);
  return res.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'idempotency'));
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName: 'Idem', owner: OWNER })
  });
  const setupBody = await readJson(setup);
  workspaceId = setupBody.workspaceId;
  ownerUserId = setupBody.ownerUserId;
  const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  ownerCookie = extractCookie(signIn);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('api-key create replay', () => {
  const body = { name: 'idem-one', scopes: [host.scopes.read] };

  it('replays the identical response (same secret, one row) and marks it', async () => {
    const first = await post('/api/v1/api-keys', body, 'K1');
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    const firstText = await first.text();
    const firstBody = JSON.parse(firstText);
    k1MintedKey = firstBody.key;
    k1RowId = firstBody.apiKey.id;

    const replay = await post('/api/v1/api-keys', body, 'K1');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    // Byte-identical: the SAME minted secret and id come back, not a new key.
    expect(await replay.text()).toBe(firstText);

    expect(await countRows(`SELECT count(*)::int AS n FROM api_keys WHERE name = 'idem-one'`)).toBe(1);
  });

  it('409s when the same key arrives with a different request body', async () => {
    const res = await post('/api/v1/api-keys', { name: 'idem-other', scopes: [host.scopes.read] }, 'K1');
    expect(res.status).toBe(409);
    expect((await readJson(res)).error.code).toBe('idempotency_key_reuse');
  });

  it('stores the cached response encrypted — the minted secret is not at rest', async () => {
    const res = await app.db.pool.query<{ response_body_enc: string | null; response_status: number | null }>(
      `SELECT response_body_enc, response_status FROM idempotency_keys WHERE key = 'K1'`
    );
    const stored = res.rows[0];
    expect(stored?.response_status).toBe(201);
    expect(stored?.response_body_enc).toBeTruthy();
    // The full key is `<prefix>_<keyId>_<secret>`; neither it nor its secret
    // fragment may appear in the stored blob.
    const secretPart = k1MintedKey.split('_').slice(2).join('_');
    expect(stored!.response_body_enc).not.toContain(k1MintedKey);
    expect(stored!.response_body_enc).not.toContain(secretPart);
    expect(() => JSON.parse(stored!.response_body_enc!)).toThrow();
    expect(stored!.response_body_enc!.split('.')).toHaveLength(3);
  });

  it('writes no second audit row on replay', async () => {
    const create = await post(
      '/api/v1/api-keys',
      { name: 'idem-audit', scopes: [host.scopes.read] },
      'K-audit'
    );
    expect(create.status).toBe(201);
    const before = await countRows(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'apikey.create'`);
    const replay = await post(
      '/api/v1/api-keys',
      { name: 'idem-audit', scopes: [host.scopes.read] },
      'K-audit'
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    const after = await countRows(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'apikey.create'`);
    expect(after).toBe(before);
  });

  it('rejects an oversized Idempotency-Key with 400 before doing anything', async () => {
    const res = await post('/api/v1/api-keys', body, 'x'.repeat(201));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_idempotency_key');
  });

  it('creates two rows for two calls without the header (opt-in only)', async () => {
    const twice = { name: 'idem-twice', scopes: [host.scopes.read] } as const;
    expect((await post('/api/v1/api-keys', twice)).status).toBe(201);
    expect((await post('/api/v1/api-keys', twice)).status).toBe(201);
    expect(await countRows(`SELECT count(*)::int AS n FROM api_keys WHERE name = 'idem-twice'`)).toBe(2);
  });
});

describe('invitation create replay', () => {
  it('replays the identical acceptUrl and keeps one invitation row', async () => {
    const body = { email: 'invitee@idem.test', role: 'member' };
    const first = await post('/api/v1/invitations', body, 'K-inv');
    expect(first.status).toBe(201);
    const firstBody = await readJson(first);
    expect(firstBody.acceptUrl).toContain('/invite/');

    const replay = await post('/api/v1/invitations', body, 'K-inv');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    const replayBody = await readJson(replay);
    expect(replayBody.acceptUrl).toBe(firstBody.acceptUrl);

    expect(
      await countRows(`SELECT count(*)::int AS n FROM invitations WHERE email = 'invitee@idem.test'`)
    ).toBe(1);
  });
});

describe('reset-link create replay', () => {
  it('replays the identical resetUrl and mints exactly one verification token', async () => {
    const members = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    const ownerMemberId = members.members.find((m: { userId: string }) => m.userId === ownerUserId)
      .id as string;

    const first = await post(`/api/v1/members/${ownerMemberId}/reset-link`, undefined, 'K-reset');
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody.resetUrl).toContain('/reset-password?token=');

    const replay = await post(`/api/v1/members/${ownerMemberId}/reset-link`, undefined, 'K-reset');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(replay)).resetUrl).toBe(firstBody.resetUrl);

    // One single-use token for this user, not two (value stores the user id).
    expect(
      await countRows(
        `SELECT count(*)::int AS n FROM verification
         WHERE identifier LIKE 'reset-password:%' AND value LIKE '%' || $1 || '%'`,
        [ownerUserId]
      )
    ).toBe(1);
  });
});

describe('claim lifecycle', () => {
  it('releases the claim on failure so the key is retryable', async () => {
    // Fails contract validation (empty scopes) → 400 → the claim is released.
    const bad = await post('/api/v1/api-keys', { name: 'idem-retry', scopes: [] }, 'K2');
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('validation_error');

    const good = await post('/api/v1/api-keys', { name: 'idem-retry', scopes: [host.scopes.read] }, 'K2');
    expect(good.status).toBe(201);
    // Fresh execution, not a replay of anything.
    expect(good.headers.get('idempotency-replayed')).toBeNull();
  });

  it('409s in-flight while a claim has no stored response yet', async () => {
    const body = { name: 'idem-flight', scopes: [host.scopes.read] };
    const bodyText = JSON.stringify(body);
    // A claim exactly as the middleware would write it, response still null —
    // the shape a concurrent first request holds while its handler runs.
    const requestHash = createHash('sha256').update(`POST\n/api/v1/api-keys\n${bodyText}`).digest('hex');
    await app.db.pool.query(
      `INSERT INTO idempotency_keys (workspace_id, user_id, key, request_hash, expires_at)
       VALUES ($1, $2, 'K3', $3, now() + interval '24 hours')`,
      [workspaceId, ownerUserId, requestHash]
    );

    const res = await post('/api/v1/api-keys', body, 'K3');
    expect(res.status).toBe(409);
    expect((await readJson(res)).error.code).toBe('idempotency_in_flight');
    // Fail-closed: the blocked retry executed nothing.
    expect(await countRows(`SELECT count(*)::int AS n FROM api_keys WHERE name = 'idem-flight'`)).toBe(0);
  });
});

describe('nightly purge', () => {
  it('drops expired rows and leaves fresh ones alone', async () => {
    await app.db.pool.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour' WHERE key = 'K1'`
    );

    // Trigger the worker's purge handler out of band (the schedule is 03:00).
    await app.jobs.boss.send('idempotency-purge', {});

    const deadline = Date.now() + 15_000;
    let expired = 1;
    while (expired > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      expired = await countRows(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'K1'`);
    }
    expect(expired).toBe(0);

    // A fresh row survives — and still replays.
    expect(await countRows(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'K-inv'`)).toBe(1);

    // With K1's row gone, the same key + body executes afresh (a NEW key is
    // minted — the 24h replay window is over).
    const res = await post('/api/v1/api-keys', { name: 'idem-one', scopes: [host.scopes.read] }, 'K1');
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotency-replayed')).toBeNull();
    const minted = await readJson(res);
    expect(minted.apiKey.id).not.toBe(k1RowId);
    expect(minted.key).not.toBe(k1MintedKey);
  }, 30_000);
});
