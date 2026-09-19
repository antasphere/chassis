import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  createDatabase,
  createTestApp,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1809 (found by the adversarial e2e pass of 2026-08-29, red repro on
 * adv/sl-e2e@c3d1416): the boot-time tombstone replay when the erased
 * subject is the SOLE active owner in the restored dump.
 *
 * Before the fix the replay called the cascade OUTSIDE the last-owner guard:
 * the 0009 trigger refused the membership delete mid-cascade, the error was
 * swallowed, boot continued (readyz 200, PII back, password working, no
 * audit row) and — because Better Auth drops the account rows BEFORE the
 * user row — the owner was left half-erased (no credential, membership
 * intact).
 *
 * The contract now: FAIL CLOSED. The guard refuses before any row is
 * touched; the boot audits the refusal, keeps /readyz red with the reason
 * and CLOSES the service surface (503 service_closed on every route but the
 * probes) until an operator promotes another owner and restarts, at which
 * point the replay erases the subject under the guard and the instance
 * serves.
 */
const OWNER = { email: 'alice@adv.test', name: 'Alice', password: 'alice-password-12345' };
const BOB_ID = 'bob-adv-restore-0001';
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
beforeAll(async () => {
  container = await startPostgres();
}, 180_000);
afterAll(async () => {
  await container?.stop();
});

async function seedMember(a: TestApp, id: string, email: string): Promise<string> {
  await a.db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, true, now(), now())`,
    [id, id, email]
  );
  await a.db.pool.query(
    `INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
     VALUES ($1, $2, 'credential', $3, 'hash', now(), now())`,
    [`acc-${id}`, id, id]
  );
  const ws = await a.db.pool.query<{ id: string }>(`SELECT id FROM workspaces LIMIT 1`);
  await a.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, $2, 'member', 'local', true)`,
    [ws.rows[0]!.id, id]
  );
  return ws.rows[0]!.id;
}

describe('PRDCT-1809: tombstone replay when the erased subject is the sole active owner in the restored dump', () => {
  it('fails CLOSED: nothing touched, refusal audited, readiness red, the service surface 503s; a promoted owner + restart erases and serves', async () => {
    const url = await createDatabase(container, 'adv_replay_owner');
    let app: TestApp = await createTestApp(url);
    const dataDir = app.env.DATA_DIR;
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Adv', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const { ownerUserId } = await readJson(setup);
    // Bob is a plain member in the OLDER dump being restored.
    const workspaceId = await seedMember(app, BOB_ID, 'bob@adv.test');

    // The live timeline: Alice promoted Bob, Bob erased Alice → tombstone.
    // The dump predates the promotion: Alice is still the sole active owner.
    appendFileSync(
      join(dataDir, 'erasures.jsonl'),
      JSON.stringify({ userId: ownerUserId, emailHash: 'x', at: new Date().toISOString() }) + '\n'
    );
    await app.stop();

    // ── Boot 1: the refusal ───────────────────────────────────────────────
    app = await createTestApp(url, { DATA_DIR: dataDir });
    try {
      expect(app.state.ready).toBe(false);
      expect(app.state.closed).toMatch(/erasure tombstone/);

      const ready = await app.app.request('/readyz');
      expect(ready.status).toBe(503);
      const readyBody = await readJson(ready);
      expect(readyBody).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('erasure tombstone')
      });
      // Coarse on purpose: the probe is unauthenticated and the subject asked to be forgotten.
      expect(JSON.stringify(readyBody)).not.toContain(ownerUserId);
      expect(JSON.stringify(readyBody)).not.toContain(OWNER.email);
      // …but the remedy names the cause the operator faces: a last-owner refusal, not a generic failure.
      expect(readyBody.reason).toContain('promote another member to owner');
      expect(readyBody.reason).not.toContain('re-erasure(s) failed');
      expect((await app.app.request('/healthz')).status).toBe(200);

      // The surface is CLOSED: the resurrected owner cannot sign in, nothing else serves either.
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      expect(signIn.status).toBe(503);
      expect(await readJson(signIn)).toMatchObject({ error: { code: 'service_closed' } });
      expect((await app.app.request('/api/v1/me')).status).toBe(503);
      // Every other mount is behind the closure too: the dashboard, the share-link
      // viewer, MCP, discovery, static assets.
      for (const path of [
        '/',
        '/v/not-a-real-secret/',
        '/mcp',
        '/.well-known/openid-configuration',
        '/favicon.ico'
      ]) {
        const res = await app.app.request(path, { headers: { accept: 'text/html' } });
        expect(res.status, path).toBe(503);
      }

      // NOTHING was touched: no half-erased owner (credential, membership, row all intact).
      const acc = await app.db.pool.query(`SELECT count(*)::int AS n FROM account WHERE user_id = $1`, [
        ownerUserId
      ]);
      const mem = await app.db.pool.query(
        `SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1`,
        [ownerUserId]
      );
      const u = await app.db.pool.query(`SELECT email FROM "user" WHERE id = $1`, [ownerUserId]);
      expect(acc.rows[0].n).toBe(1);
      expect(mem.rows[0].n).toBe(1);
      expect(u.rows).toHaveLength(1);

      // The refusal is on the record; no replay row was minted.
      const audit = await app.db.pool.query<{
        action: string;
        actor_via: string | null;
        resource_id: string;
      }>(`SELECT action, actor_via, resource_id FROM audit_log WHERE action LIKE 'user.erasure_replay%'`);
      expect(audit.rows).toEqual([
        { action: 'user.erasure_replay_refused', actor_via: 'system', resource_id: ownerUserId }
      ]);
    } finally {
      await app.stop();
    }

    // ── The operator's remedy (the runbook's psql statement), then restart ──
    const operator = new pg.Client({ connectionString: url });
    await operator.connect();
    try {
      await operator.query(
        `UPDATE workspace_members SET role = 'owner', is_active = true WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, BOB_ID]
      );
    } finally {
      await operator.end();
    }

    // ── Boot 2: the replay applies under the guard and the instance serves ─
    app = await createTestApp(url, { DATA_DIR: dataDir });
    try {
      expect(app.state.closed).toBeNull();
      expect((await app.app.request('/readyz')).status).toBe(200);
      const users = await app.db.pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [ownerUserId]);
      expect(users.rows).toHaveLength(0);
      const mem = await app.db.pool.query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [
        ownerUserId
      ]);
      expect(mem.rows).toHaveLength(0);
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      expect(signIn.status).not.toBe(200);
      const audit = await app.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action LIKE 'user.erasure_replay%' ORDER BY created_at`
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'user.erasure_replay_refused',
        'user.erasure_replayed'
      ]);
      // Bob owns the workspace; the workspace kept an active owner throughout.
      const owners = await app.db.pool.query<{ user_id: string }>(
        `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' AND is_active`,
        [workspaceId]
      );
      expect(owners.rows.map((r) => r.user_id)).toEqual([BOB_ID]);
    } finally {
      await app.stop();
    }
  }, 180_000);
});
