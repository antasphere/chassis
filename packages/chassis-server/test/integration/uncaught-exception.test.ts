import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';

/**
 * PRDCT-3583, through the booted app: the host's own database handle survives
 * a checked-out connection ended by the server (the tool's `db` slot is built
 * on createDb), and the boot's last resort turns an exception nothing caught
 * into a closed service (503 service_closed, the verdict on /readyz) rather
 * than a dead process.
 */
let container: StartedPostgreSqlContainer;
let app: TestApp;
let lastResort: (err: Error) => void;

beforeAll(async () => {
  container = await startPostgres();
  const before = new Set(process.listeners('uncaughtException'));
  app = await createTestApp(await createDatabase(container, 'uncaught_exception'));
  const added = process.listeners('uncaughtException').filter((l) => !before.has(l));
  expect(added).toHaveLength(1);
  lastResort = (err) => (added[0] as (err: Error) => void)(err);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the booted app', () => {
  it("survives a backend ended inside a transaction on the host's own handle", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const tx = app.db.db.transaction(async (trx) => {
        const res = await trx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const admin = new pg.Client({ connectionString: app.env.DATABASE_URL });
        await admin.connect();
        try {
          await admin.query('select pg_terminate_backend($1)', [res.rows[0]!.pid]);
        } finally {
          await admin.end();
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await trx.execute(sql`select 1`);
      });
      await expect(tx).rejects.toThrow();
      expect(uncaught).toEqual([]);
      expect(app.state.closed).toBeNull();
      expect((await app.app.request('/readyz')).status).toBe(200);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('an uncaught exception closes the service: 503 service_closed, /readyz red, /healthz alive', async () => {
    lastResort(new Error('a listener nobody attached'));

    expect(app.state.closed).toMatch(/uncaught exception/);
    const closed = await app.app.request('/api/v1/me');
    expect(closed.status).toBe(503);
    expect(await readJson(closed)).toMatchObject({ error: { code: 'service_closed' } });
    const ready = await app.app.request('/readyz');
    expect(ready.status).toBe(503);
    expect((await app.app.request('/healthz')).status).toBe(200);
  });
});
