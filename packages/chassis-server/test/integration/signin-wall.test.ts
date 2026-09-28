import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';

/**
 * PRDCT-2830 / PRDCT-2848: the sign-in library's own wall (3 per 10 seconds
 * per address on `/sign-in*`, on under NODE_ENV=production) answers 429 inside
 * the `/auth/*` mount, and the chassis's failure-only login wall in front of
 * it (10 per 15 minutes) counted every one of those 429s as a refused
 * credential. A burst of ordinary sign-ins from one address (a room behind one
 * public IP) then locked that address out for 15 minutes.
 *
 * Pinned here: a library 429 costs the chassis wall nothing; a wrong password
 * still does; the federated start (`sign-in/oauth2`, no credential) is off the
 * wall. The library's wall is off under NODE_ENV=test, so the suite switches
 * it on in the live auth context, as production has it.
 */

const OWNER = { email: 'owner@wall.test', name: 'Wall Owner', password: 'wall-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
type RateLimitCtx = { rateLimit: { enabled: boolean } };
let authCtx: RateLimitCtx;

const post = (path: string, ip: string, body: unknown) =>
  app.app.request(`/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
    body: JSON.stringify(body)
  });

/** The chassis's own wall answers `{ error: { code: 'rate_limited' } }`; the library's does not. */
async function isChassisWall(res: Response): Promise<boolean> {
  if (res.status !== 429) return false;
  const body = await readJson(res).catch(() => null);
  return body?.error?.code === 'rate_limited';
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'signin_wall'));
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName: 'Wall', owner: OWNER })
  });
  expect(setup.status).toBeLessThan(300);
  authCtx = (await (app.auth as unknown as { $context: Promise<RateLimitCtx> }).$context) as RateLimitCtx;
});

afterAll(async () => {
  if (authCtx) authCtx.rateLimit.enabled = false;
  await app?.stop();
  await container?.stop();
});

describe('the login wall and the library wall behind it', () => {
  it('a burst the library answers 429 does not lock the address out', async () => {
    const ip = '198.51.100.10';
    authCtx.rateLimit.enabled = true;
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 15; i++) {
        const res = await post('/sign-in/email', ip, { email: OWNER.email, password: OWNER.password });
        statuses.push(res.status);
        expect(await isChassisWall(res)).toBe(false);
      }
    } finally {
      // The library's 10-second window, elapsed.
      authCtx.rateLimit.enabled = false;
    }
    // The library's wall did answer: 3 in, the rest 429 (more than the login wall's 10 points).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(10);
    // Once the library lets the address through again, the right password signs in.
    const after = await post('/sign-in/email', ip, { email: OWNER.email, password: OWNER.password });
    expect(after.status).toBe(200);
  });

  it('a wrong password still costs: the eleventh from one address meets the 15-minute wall', async () => {
    const ip = '198.51.100.20';
    for (let i = 0; i < 10; i++) {
      const res = await post('/sign-in/email', ip, {
        email: `nobody-${i}@wall.test`,
        password: 'wrong-password-1'
      });
      expect(res.status).toBe(401);
    }
    const eleventh = await post('/sign-in/email', ip, {
      email: 'nobody-x@wall.test',
      password: 'wrong-password-1'
    });
    expect(await isChassisWall(eleventh)).toBe(true);
  });

  it('the federated start presents no credential and never meets the login wall', async () => {
    const ip = '198.51.100.30';
    for (let i = 0; i < 12; i++) {
      const res = await post('/sign-in/oauth2', ip, { providerId: 'antasphere', callbackURL: '/' });
      expect(await isChassisWall(res)).toBe(false);
    }
  });
});
