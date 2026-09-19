import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';

/**
 * PRDCT-1347 (audit A7): the first-boot claim is NEVER free. With no
 * SETUP_TOKEN configured the server generates one into $DATA_DIR/setup-token
 * at boot and POST /setup refuses every claim that does not present it — the
 * documented `docker run` / plain `docker compose up` paths (which never go
 * through setup.sh) therefore produce an instance claimable only with a
 * secret. The generated token is reused across boots until the claim, and
 * removed once the instance is set up.
 */

const OWNER = { email: 'owner@claim.test', name: 'Owner', password: 'owner-password-12345' };

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

describe('first-boot claim without SETUP_TOKEN (generated token)', () => {
  let app: TestApp;
  let url: string;

  beforeAll(async () => {
    url = await createDatabase(container, 'claim_generated');
    // Blank = unset (blankToUndefined): the minimal-env container shape.
    app = await createTestApp(url, { SETUP_TOKEN: '' });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('boot generated a 0600 token file in the data volume', () => {
    const path = join(app.env.DATA_DIR, 'setup-token');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThanOrEqual(32);
  });

  it('a tokenless claim is refused (403 invalid_setup_token) and creates nothing', async () => {
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'Free', owner: OWNER }));
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('invalid_setup_token');
    const rows = await app.db.pool.query('SELECT 1 FROM instance_settings');
    expect(rows.rows).toHaveLength(0);
    const users = await app.db.pool.query('SELECT 1 FROM "user"');
    expect(users.rows).toHaveLength(0);
  });

  it('a wrong token is refused too', async () => {
    const res = await app.app.request(
      '/api/v1/setup',
      json({ instanceName: 'Guess', owner: OWNER, setupToken: 'not-the-generated-token' })
    );
    expect(res.status).toBe(403);
  });

  it('a second boot before the claim reuses the same generated token', async () => {
    const path = join(app.env.DATA_DIR, 'setup-token');
    const first = readFileSync(path, 'utf8').trim();
    const again = await createTestApp(url, { SETUP_TOKEN: '', DATA_DIR: app.env.DATA_DIR });
    try {
      expect(readFileSync(path, 'utf8').trim()).toBe(first);
    } finally {
      await again.stop();
    }
  });

  it('the generated token claims the instance, then the file is gone and the claim is closed', async () => {
    const path = join(app.env.DATA_DIR, 'setup-token');
    const token = readFileSync(path, 'utf8').trim();
    const res = await app.app.request(
      '/api/v1/setup',
      json({ instanceName: 'Claimed', owner: OWNER, setupToken: token })
    );
    expect(res.status).toBe(201);
    expect(existsSync(path)).toBe(false);
    // A replay — even with the right token — meets the 410, never a second owner.
    const replay = await app.app.request(
      '/api/v1/setup',
      json({ instanceName: 'Again', owner: { ...OWNER, email: 'other@claim.test' }, setupToken: token })
    );
    expect(replay.status).toBe(410);
  });

  it('a boot of the set-up instance generates no token file', async () => {
    const rebooted = await createTestApp(url, { SETUP_TOKEN: '' });
    try {
      expect(existsSync(join(rebooted.env.DATA_DIR, 'setup-token'))).toBe(false);
      const res = await rebooted.app.request('/api/v1/setup', json({ instanceName: 'X', owner: OWNER }));
      expect(res.status).toBe(410);
    } finally {
      await rebooted.stop();
    }
  });
});

describe('first-boot claim with SETUP_TOKEN configured', () => {
  it('the env token is the credential and no file is generated', async () => {
    const app = await createTestApp(await createDatabase(container, 'claim_env'), {
      SETUP_TOKEN: 'operator-chosen-token'
    });
    try {
      expect(existsSync(join(app.env.DATA_DIR, 'setup-token'))).toBe(false);
      const free = await app.app.request('/api/v1/setup', json({ instanceName: 'Free', owner: OWNER }));
      expect(free.status).toBe(403);
      const ok = await app.app.request(
        '/api/v1/setup',
        json({ instanceName: 'Ok', owner: OWNER, setupToken: 'operator-chosen-token' })
      );
      expect(ok.status).toBe(201);
    } finally {
      await app.stop();
    }
  });
});
