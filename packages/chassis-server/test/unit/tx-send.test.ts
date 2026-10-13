import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connectionOf } from '../../src/webhooks/tx-send.js';

/**
 * The transactional send reaches the connection behind a drizzle handle
 * through the driver binding's session (`session.client`): this pins the
 * shape against the installed drizzle, so a bump that moves it fails here
 * and not in a delivery.
 */
describe('tx-send: the connection behind a drizzle handle', () => {
  it('a plain handle exposes its pool, with query', () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const db = drizzle(pool);
    expect(connectionOf(db)).toBe(pool);
    expect(typeof connectionOf(db).query).toBe('function');
  });

  it('something that is not a drizzle handle is refused, naming the shape', () => {
    expect(() => connectionOf({} as never)).toThrow(/session\.client/);
  });
});
