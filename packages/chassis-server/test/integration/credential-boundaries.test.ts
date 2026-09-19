import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
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
 * Adversarial verifier suite (Stage D, the user-scoped credential core):
 * three cross-tenant / cross-user boundaries the wider workspace-scoping
 * suite proves at MINT time but not at RESOLUTION time. Each is a named
 * attack in the re-architecture's rollout choreography:
 *
 *  1. A key is its CREATOR's credential — the creator-only revoke must not
 *     let another user (even a co-owner of the pinned workspace) revoke or
 *     probe it; a foreign key answers the SAME 404 as a nonexistent one.
 *  2. "Stale pin after the membership is deactivated": a pinned key whose
 *     creator loses their live membership of the pin fails CLOSED with the
 *     uniform 401 — never the 403 mismatch, never silently served the pin.
 *  3. Default selection is fail-CLOSED against a non-live default: an
 *     `is_default` row that is not an ACTIVE membership is ignored, and
 *     selector-less resolution falls back to the oldest ACTIVE membership.
 *
 * Every machine-credential request rotates its forwarded IP so the per-IP
 * key-failure limiter never colours a deliberate resolution miss.
 */

const EVE = { email: 'eve@cred.test', name: 'Eve Owner', password: 'a-long-eve-password-12345' };
const FRANK = { email: 'frank@cred.test', name: 'Frank Owner', password: 'a-long-frank-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let eveCookie = '';
let frankCookie = '';
let eveId = '';
let frankId = '';
let wE = ''; // Eve's org, co-owned by Frank (so deactivating Eve never trips the last-owner trigger)

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
const keyHeaders = (key: string) => ({ authorization: `Bearer ${key}`, 'x-forwarded-for': nextIp() });

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function mintKey(
  cookie: string,
  name: string,
  workspaceId?: string
): Promise<{ key: string; id: string }> {
  const res = await app.app.request('/api/v1/api-keys', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes: [host.scopes.read], ...(workspaceId ? { workspaceId } : {}) })
  });
  expect(res.status).toBe(201);
  const body = await readJson(res);
  return { key: body.key, id: body.apiKey.id };
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'cred_boundaries');
  app = await createTestApp(dbUrl);

  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Cred Boundaries',
      owner: EVE
    })
  });
  expect(setup.status).toBe(201);

  eveCookie = await signIn(EVE.email, EVE.password);
  eveId = (await readJson(await app.app.request('/api/v1/me', { headers: { cookie: eveCookie } }))).user.id;

  const frank = await app.auth.api.signUpEmail({
    body: { email: FRANK.email, password: FRANK.password, name: FRANK.name }
  });
  frankId = frank.user.id;

  // Setup's workspace is Eve's oldest membership (the selector-less default).
  wE = (await readJson(await app.app.request('/api/v1/me', { headers: { cookie: eveCookie } }))).workspace.id;
  // Frank co-owns wE — a live second owner so Eve's membership can be
  // deactivated without the 0009 last-owner trigger firing.
  await app.db.db.insert(workspaceMembers).values({ workspaceId: wE, userId: frankId, role: 'owner' });
  frankCookie = await signIn(FRANK.email, FRANK.password);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a key is its creator’s credential — revoke is creator-only (attack surface 3)', () => {
  it('a co-owner of the pinned workspace cannot revoke another user’s key (404, and the key stays live)', async () => {
    // Eve mints a key PINNED to wE — so the row carries workspace_id = wE and
    // a (regressed) workspace-scoped revoke WOULD find it. The creator-scoped
    // revoke must not.
    const eveKey = await mintKey(eveCookie, 'eve-pinned-key', wE);

    // Frank — a co-owner of the SAME workspace — tries to revoke Eve's key.
    const foreignRevoke = await app.app.request(`/api/v1/api-keys/${eveKey.id}`, {
      method: 'DELETE',
      headers: { cookie: frankCookie }
    });
    // Existence is not probeable across users: identical to a nonexistent id.
    expect(foreignRevoke.status).toBe(404);
    expect((await readJson(foreignRevoke)).error.code).toBe('not_found');

    // And it truly did NOT revoke: Eve's key still resolves.
    const stillLive = await app.app.request('/api/v1/me', { headers: keyHeaders(eveKey.key) });
    expect(stillLive.status).toBe(200);

    // Sanity: the CREATOR revokes it, and only then does it die.
    const ownRevoke = await app.app.request(`/api/v1/api-keys/${eveKey.id}`, {
      method: 'DELETE',
      headers: { cookie: eveCookie }
    });
    expect(ownRevoke.status).toBe(200);
    const dead = await app.app.request('/api/v1/me', { headers: keyHeaders(eveKey.key) });
    expect(dead.status).toBe(401);
  });
});

describe('a stale pin fails closed once the creator’s membership is deactivated (attack surface 1)', () => {
  it('the pinned key answers the uniform 401 — never the 403 mismatch, never served the pin', async () => {
    const pinned = await mintKey(eveCookie, 'eve-stale-pin', wE);
    // Works while Eve is a live member of the pin.
    expect((await app.app.request('/api/v1/me', { headers: keyHeaders(pinned.key) })).status).toBe(200);

    // Deactivate Eve's membership of the pinned workspace (Frank keeps wE alive).
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false WHERE user_id = $1 AND workspace_id = $2`,
      [eveId, wE]
    );
    try {
      // No X-Workspace-Id header: the pin resolves to no live membership →
      // the uniform 401 (invalid_api_key), indistinguishable from any other
      // resolution miss. A regression that trusted the pin without the live
      // isActive check would answer 200 here.
      const res = await app.app.request('/api/v1/me', { headers: keyHeaders(pinned.key) });
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('invalid_api_key');
    } finally {
      await app.db.pool.query(
        `UPDATE workspace_members SET is_active = true WHERE user_id = $1 AND workspace_id = $2`,
        [eveId, wE]
      );
    }
    // Reactivated: the very same key resolves again (the row, not the token,
    // is the authorization).
    expect((await app.app.request('/api/v1/me', { headers: keyHeaders(pinned.key) })).status).toBe(200);
  });
});

describe('default selection is fail-closed against a non-live default (attack surface 2)', () => {
  it('an is_default flag on an INACTIVE membership is ignored; resolution falls back to the oldest ACTIVE', async () => {
    // A second org for Eve; make it her DEFAULT but mark the membership
    // INACTIVE. Frank co-owns it so deactivating Eve never trips the 0009
    // last-owner trigger (this test is about default selection, not lifecycle).
    const wE2 = (await app.registry.workspaces.create('Eve Org Two', eveId)).workspaceId;
    await app.db.db.insert(workspaceMembers).values({ workspaceId: wE2, userId: frankId, role: 'owner' });
    await app.db.pool.query(
      `UPDATE workspace_members SET is_default = true, is_active = false WHERE user_id = $1 AND workspace_id = $2`,
      [eveId, wE2]
    );
    try {
      // Selector-less resolution must NOT land on the dead default; it falls
      // back to the oldest ACTIVE membership (wE, the setup workspace).
      const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: eveCookie } }));
      expect(me.activeWorkspaceId).toBe(wE);
      // The inactive workspace is not even enumerated (the /me isActive filter).
      expect(me.workspaces.map((w: { id: string }) => w.id)).not.toContain(wE2);
    } finally {
      await app.db.pool.query(`UPDATE workspace_members SET is_default = false WHERE user_id = $1`, [eveId]);
    }
  });
});
