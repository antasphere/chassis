import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1357, the two members this lane added:
 *
 *  - OPS-3: a GDPR erasure lands an append-only tombstone in the data
 *    volume (outside the dump); a boot that finds a tombstoned user present
 *    again — the restore-from-an-older-dump shape — re-erases them and
 *    audits the replay;
 *  - OPS-6: migration status is hash-based, so a database migrated by a
 *    NEWER image (a rollback, `:next` behind `:latest`) refuses readiness
 *    instead of reporting "current".
 */

const OWNER = { email: 'owner@posture.test', name: 'Owner', password: 'owner-password-12345' };

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe('erasure tombstone (OPS-3)', () => {
  let url: string;
  let app: TestApp;
  let dataDir: string;
  let ownerCookie: string;
  const VICTIM_ID = 'u-erased';

  async function seedMember(a: TestApp, id: string, email: string): Promise<string> {
    await a.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, now(), now())`,
      [id, email, email]
    );
    await a.db.pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $3, 'hash', now(), now())`,
      [`acc-${id}`, id, id]
    );
    const ws = await a.db.pool.query<{ id: string }>(`SELECT id FROM workspaces LIMIT 1`);
    const m = await a.db.pool.query<{ id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'local', true) RETURNING id`,
      [ws.rows[0]!.id, id]
    );
    return m.rows[0]!.id;
  }

  beforeAll(async () => {
    url = await createDatabase(container, 'posture_erasure');
    app = await createTestApp(url);
    dataDir = app.env.DATA_DIR;
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Posture', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    ownerCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
  });

  afterAll(async () => {
    await app.stop();
  });

  it('an admin erasure appends a tombstone that names the user id and hashes (never carries) the email', async () => {
    const memberId = await seedMember(app, VICTIM_ID, 'victim@posture.test');
    const res = await app.app.request(`/api/v1/members/${memberId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
    const path = join(dataDir, 'erasures.jsonl');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { userId: string; emailHash: string; at: string });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.userId).toBe(VICTIM_ID);
    expect(lines[0]!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain('victim@posture.test');
  });

  it('a boot that finds the erased user PRESENT again re-erases them and audits the replay', async () => {
    // The restore-from-an-older-dump shape: the row (and their password) is back.
    await seedMember(app, VICTIM_ID, 'victim@posture.test');
    await app.stop();
    app = await createTestApp(url, { DATA_DIR: dataDir });
    const users = await app.db.pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [VICTIM_ID]);
    expect(users.rows).toHaveLength(0);
    const members = await app.db.pool.query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [
      VICTIM_ID
    ]);
    expect(members.rows).toHaveLength(0);
    const audit = await app.db.pool.query<{ action: string; actor_via: string | null; resource_id: string }>(
      `SELECT action, actor_via, resource_id FROM audit_log WHERE action = 'user.erasure_replayed'`
    );
    expect(audit.rows).toEqual([
      { action: 'user.erasure_replayed', actor_via: 'system', resource_id: VICTIM_ID }
    ]);
  });

  it('a boot with nothing to replay replays nothing (idempotent) and the login still works', async () => {
    await app.stop();
    app = await createTestApp(url, { DATA_DIR: dataDir });
    const audit = await app.db.pool.query(`SELECT 1 FROM audit_log WHERE action = 'user.erasure_replayed'`);
    expect(audit.rows).toHaveLength(1);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
  });
});

describe('hash-based migration status (OPS-6)', () => {
  it('a database carrying a migration this image does not ship refuses readiness (a downgrade), instead of "current"', async () => {
    const url = await createDatabase(container, 'posture_downgrade');
    const app = await createTestApp(url);
    // What a NEWER image leaves behind: an applied hash no file here produces.
    await app.db.pool.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [
      'f'.repeat(64),
      Date.now()
    ]);
    await app.stop();

    const older = await createTestApp(url);
    try {
      expect(older.state.ready).toBe(false);
      expect(older.state.reason).toMatch(/AHEAD of this image/);
      const res = await older.app.request('/readyz');
      expect(res.status).toBe(503);
      const body = await readJson(res);
      expect(body.status).toBe('unavailable');
      expect(body.reason).toMatch(/AHEAD of this image/);
    } finally {
      await older.stop();
    }
  });
});
