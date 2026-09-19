import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@antasphere/chassis-db/migrate';
import { workspaceMembers } from '@antasphere/chassis-db';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

const OWNER = {
  email: 'owner@example.com',
  name: 'Owner One',
  password: 'a-long-owner-password-123'
};

let container: StartedPostgreSqlContainer;
let app: TestApp;

const migrationsFolder = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, '../../../../packages/db/drizzle');
  if (!existsSync(p)) throw new Error(`migrations not found at ${p}`);
  return p;
})();

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(container.getConnectionUri());
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('migrations', () => {
  it('is idempotent: a second run applies nothing', async () => {
    // Boot already migrated. Run the migrator again and compare the journal.
    const client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    const before = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    await runMigrations({ connectionString: container.getConnectionUri(), migrationsFolder });
    const after = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    await client.end();
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(before.rows[0].n).toBeGreaterThan(0);
  });

  it('ships an image where pgvector is installable (products run CREATE EXTENSION — ADR 004)', async () => {
    const client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    const res = await client.query(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`
    );
    await client.end();
    expect(res.rows[0].n).toBe(1);
  });
});

describe('first-boot setup', () => {
  it('reports setupRequired before setup', async () => {
    const res = await app.app.request('/api/v1/instance');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.setupRequired).toBe(true);
    expect(body.instanceId).toBeNull();
    expect(body.auth.methods).toContain('password');
  });

  it('creates owner + workspace, then flips setupRequired', async () => {
    const res = await app.app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: 'integration-test-setup-token',
        instanceName: 'Test Instance',
        owner: OWNER
      })
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.workspaceId).toBeTruthy();
    expect(body.ownerUserId).toBeTruthy();
    expect(body.instanceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID

    const inst = await app.app.request('/api/v1/instance');
    const instBody = await readJson(inst);
    expect(instBody.setupRequired).toBe(false);
    expect(instBody.name).toBe('Test Instance');
  });

  it('returns 410 on a second setup attempt', async () => {
    const res = await app.app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: 'integration-test-setup-token',
        instanceName: 'Again',
        owner: { ...OWNER, email: 'other@example.com' }
      })
    });
    expect(res.status).toBe(410);
    const body = await readJson(res);
    expect(body.error.code).toBe('already_setup');
  });
});

describe('authentication + /me', () => {
  let cookie: string;

  it('signs in the owner with password and gets a session cookie', async () => {
    const res = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
    });
    expect(res.status).toBe(200);
    cookie = extractCookie(res);
    expect(cookie).toContain('better-auth');
  });

  it('resolves /me with the session cookie (role owner, via session)', async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.user.email).toBe(OWNER.email);
    expect(body.role).toBe('owner');
    expect(body.via).toBe('session');
    expect(body.scopes).toBeNull();
    expect(body.workspace.name).toBe('Test Instance');
  });

  it('401s without credentials', async () => {
    const res = await app.app.request('/api/v1/me');
    expect(res.status).toBe(401);
  });

  it('401s a JWT-shaped bearer that this instance never minted', async () => {
    const res = await app.app.request('/api/v1/me', {
      headers: { authorization: 'Bearer aaa.bbb.ccc' }
    });
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('invalid_token');
  });

  it('revokes instantly: deactivating the membership kills the live session', async () => {
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    const body = await readJson(me);
    // The last-owner trigger (migration 0009) forbids deactivating the sole
    // owner, so seed a throwaway sibling owner first — this test is about the
    // live re-check killing the subject's session, not the last-owner rule.
    const siblingUserId = `sibling-${body.user.id}`;
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Sibling Owner', $2, true)`,
      [siblingUserId, `sibling-${Date.now()}@revoke.test`]
    );
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'owner', true)`,
      [body.workspace.id, siblingUserId]
    );
    try {
      await app.db.db
        .update(workspaceMembers)
        .set({ isActive: false })
        .where(eq(workspaceMembers.userId, body.user.id));

      // The live re-check kills WORKSPACE access instantly: a real
      // workspace endpoint 401s (no active membership resolves).
      const denied = await app.app.request(host.probeRoute, { headers: { cookie } });
      expect(denied.status).toBe(401);
      // /me itself now answers the zero-membership zero state (200, empty
      // list) rather than a 401 — the user is signed in but belongs to no
      // workspace (user-scoped credential model); the dashboard renders the
      // no-organization page instead of bouncing to login.
      const after = await app.app.request('/api/v1/me', { headers: { cookie } });
      expect(after.status).toBe(200);
      const afterBody = await readJson(after);
      expect(afterBody.workspaces).toEqual([]);
      expect(afterBody.activeWorkspaceId).toBeNull();
    } finally {
      // restore even when the assertion fails — later suites need the owner
      await app.db.db
        .update(workspaceMembers)
        .set({ isActive: true })
        .where(eq(workspaceMembers.userId, body.user.id));
      // drop the sibling (owner still active, so the trigger is satisfied)
      await app.db.pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [siblingUserId]);
      await app.db.pool.query(`DELETE FROM "user" WHERE id = $1`, [siblingUserId]);
    }
  });

  it('blocks public HTTP sign-up (accounts enter via setup or invitations)', async () => {
    const res = await app.app.request('/api/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'squatter@example.com', password: 'x'.repeat(16), name: 'Squatter' })
    });
    expect(res.status).toBe(403);
  });
});

describe('setup token', () => {
  it('enforces SETUP_TOKEN when configured (403 wrong, 201 right)', async () => {
    const url = await createDatabase(container, 'setup_token_test');
    const tokenApp = await createTestApp(url, { SETUP_TOKEN: 'super-setup-token' });
    try {
      const wrong = await tokenApp.app.request('/api/v1/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceName: 'T', owner: OWNER, setupToken: 'nope-wrong-token' })
      });
      expect(wrong.status).toBe(403);

      const right = await tokenApp.app.request('/api/v1/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceName: 'T', owner: OWNER, setupToken: 'super-setup-token' })
      });
      expect(right.status).toBe(201);
    } finally {
      await tokenApp.stop();
    }
  });
});

describe('openapi + health', () => {
  it('serves a generated OpenAPI document', async () => {
    const res = await app.app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await readJson(res);
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/instance', '/setup', '/me']));
  });

  it('reports ready after boot', async () => {
    const res = await app.app.request('/readyz');
    expect(res.status).toBe(200);
  });
});
