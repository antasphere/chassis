import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';

/**
 * Tool-local first-run onboarding (SL-6, decision 8): the banner truth is
 * `user_onboarding` — NOT the hub's advisory tool_first_login claim — and
 * its semantics are retry-safe by construction:
 *
 *  - `firstRunPending := NOT EXISTS (row WHERE dismissed_at IS NOT NULL)`,
 *    so a LOST first-login insert still shows the welcome next time and
 *    only an explicit dismissal ever hides it;
 *  - the SSO login path lazily inserts the row (ON CONFLICT DO NOTHING,
 *    best-effort, never a login failure mode);
 *  - the deploy backfill marks every pre-existing user dismissed (no
 *    retroactive welcome);
 *  - `ssoOnly` is the hint-watch discriminator: hub-JIT users true, any
 *    credential-holding operator false — D9-linked or not;
 *  - both /me keys are CLOUD + SESSION only; machines 403 on dismiss.
 */

const OWNER = { email: 'owner@onboarding.test', name: 'Op Owner', password: 'op-owner-password-123' };
const ORG_O = '33333333-aaaa-4bbb-8ccc-000000000001';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
let hub: FakeHub;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
});

afterAll(async () => {
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('cloud: first-run onboarding + ssoOnly', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'onboarding'), {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
    });
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Onb', owner: OWNER })
    );
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  const dana: HubUserFixture = {
    sub: 'hub-dana',
    email: 'dana@onboarding.test',
    name: 'Dana',
    workspaceId: ORG_O,
    role: 'member',
    workspaceName: 'Onb Org'
  };

  async function onboardingRow(email: string): Promise<{ dismissed_at: Date | null } | undefined> {
    const { rows } = await app.db.pool.query<{ dismissed_at: Date | null }>(
      `SELECT o.dismissed_at FROM user_onboarding o JOIN "user" u ON u.id = o.user_id WHERE u.email = $1`,
      [email]
    );
    return rows[0];
  }

  it('a fresh hub-JIT login inserts the row and /me says firstRunPending:true, ssoOnly:true', async () => {
    const cookie = await sso.ssoLogin(app, hub, dana);
    const row = await onboardingRow(dana.email);
    expect(row).toBeDefined();
    expect(row!.dismissed_at).toBeNull();
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.firstRunPending).toBe(true);
    expect(me.ssoOnly).toBe(true);
  });

  it('a LOST first-login insert still shows the welcome (NOT-EXISTS semantics) and self-heals on relogin', async () => {
    // Simulate the failed best-effort insert by deleting the row outright.
    await app.db.pool.query(
      `DELETE FROM user_onboarding WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [dana.email]
    );
    const cookie = await sso.ssoLogin(app, hub, dana);
    // No row at all — the banner is still owed…
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.firstRunPending).toBe(true);
    // …and the login's lazy insert re-created the row for next time.
    expect((await onboardingRow(dana.email))?.dismissed_at).toBeNull();
  });

  it('dismiss flips firstRunPending, persists across logins, and is idempotent', async () => {
    const cookie = await sso.ssoLogin(app, hub, dana);
    const dismiss = await app.app.request('/api/v1/me/onboarding/dismiss', {
      method: 'POST',
      headers: { cookie }
    });
    expect(dismiss.status).toBe(200);
    expect(await readJson(dismiss)).toEqual({ dismissed: true });
    const first = (await onboardingRow(dana.email))!.dismissed_at;
    expect(first).not.toBeNull();

    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.firstRunPending).toBe(false);

    // A returning login must not resurrect the welcome (ON CONFLICT DO
    // NOTHING on the login path)…
    const cookie2 = await sso.ssoLogin(app, hub, dana);
    const me2 = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: cookie2 } }));
    expect(me2.firstRunPending).toBe(false);
    // …and a second dismiss keeps the FIRST dismissal timestamp.
    const again = await app.app.request('/api/v1/me/onboarding/dismiss', {
      method: 'POST',
      headers: { cookie: cookie2 }
    });
    expect(again.status).toBe(200);
    expect((await onboardingRow(dana.email))!.dismissed_at!.toISOString()).toBe(first!.toISOString());
  });

  it('the operator (credential account) is NEVER ssoOnly — zero-membership and D9-linked alike', async () => {
    // Zero-membership operator session (cloud setup mints no workspace):
    // the /me zero state carries the extras, ssoOnly false.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const zero = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie: extractCookie(signIn) } })
    );
    expect(zero.workspaces).toEqual([]);
    expect(zero.ssoOnly).toBe(false);
    expect(typeof zero.firstRunPending).toBe('boolean');

    // D9 trusted-link: the operator logs in via SSO (same verified email) —
    // now holding BOTH an antasphere row and the credential row. Still
    // never ssoOnly: the hint-watch must not be able to sign out someone
    // who can break-glass back in.
    const cookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-owner',
      email: OWNER.email,
      name: OWNER.name,
      workspaceId: ORG_O,
      role: 'owner',
      workspaceName: 'Onb Org'
    });
    const linked = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(linked.ssoOnly).toBe(false);
    const { rows } = await app.db.pool.query<{ provider_id: string }>(
      `SELECT provider_id FROM account WHERE user_id = (SELECT id FROM "user" WHERE email = $1) ORDER BY provider_id`,
      [OWNER.email]
    );
    expect(rows.map((r) => r.provider_id)).toEqual(['antasphere', 'credential']);
  });

  it('machine credentials never see the keys and 403 on dismiss (fail-closed allowlist)', async () => {
    // The D9-linked operator now holds a membership (the SSO reconcile
    // projected ORG_O) — mint a key from their session.
    const cookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-owner',
      email: OWNER.email,
      name: OWNER.name,
      workspaceId: ORG_O,
      role: 'owner',
      workspaceName: 'Onb Org'
    });
    const mint = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'onboarding probe', scopes: [host.scopes.read, host.scopes.write] }),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(mint.status).toBe(201);
    const { key } = await readJson(mint);

    const me = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
    expect(me.status).toBe(200);
    const body = await readJson(me);
    expect(body.via).toBe('api_key');
    expect('firstRunPending' in body).toBe(false);
    expect('ssoOnly' in body).toBe(false);

    const dismiss = await app.app.request('/api/v1/me/onboarding/dismiss', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` }
    });
    expect(dismiss.status).toBe(403);
    expect((await readJson(dismiss)).error.code).toBe('endpoint_not_allowed');
  });

  it('the deploy backfill marks row-less users dismissed and never clobbers existing rows', async () => {
    // Fixture: the operator has NO row (no SSO dismiss ever ran for them —
    // clear defensively), dana has a DISMISSED row from the test above.
    await app.db.pool.query(
      `DELETE FROM user_onboarding WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [OWNER.email]
    );
    const danaBefore = (await onboardingRow(dana.email))!.dismissed_at!;

    // Run the committed backfill migration SQL verbatim against the pool —
    // exactly what a redeploy would apply.
    const backfill = await readFile(
      join(import.meta.dirname, '../../../../packages/db/drizzle/0028_user_onboarding_backfill.sql'),
      'utf8'
    );
    await app.db.pool.query(backfill);

    // Pre-existing (row-less) users are dismissed — no retroactive welcome…
    const owner = await onboardingRow(OWNER.email);
    expect(owner).toBeDefined();
    expect(owner!.dismissed_at).not.toBeNull();
    // …and existing rows are untouched (ON CONFLICT DO NOTHING).
    expect((await onboardingRow(dana.email))!.dismissed_at!.toISOString()).toBe(danaBefore.toISOString());
  });
});

describe('oss: zero onboarding surface', () => {
  it('/me carries neither key and the dismiss route answers the JSON 404 terminator', async () => {
    const app = await createTestApp(await createDatabase(container, 'onboarding_oss'));
    try {
      const setup = await app.app.request(
        '/api/v1/setup',
        json({ setupToken: 'integration-test-setup-token', instanceName: 'OnbOss', owner: OWNER })
      );
      expect(setup.status).toBe(201);
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      const cookie = extractCookie(signIn);
      const me = await app.app.request('/api/v1/me', { headers: { cookie } });
      expect(me.status).toBe(200);
      const body = await readJson(me);
      expect('firstRunPending' in body).toBe(false);
      expect('ssoOnly' in body).toBe(false);

      const dismiss = await app.app.request('/api/v1/me/onboarding/dismiss', {
        method: 'POST',
        headers: { cookie }
      });
      expect(dismiss.status).toBe(404);
      expect((await readJson(dismiss)).error.code).toBe('not_found');
    } finally {
      await app.stop();
    }
  });
});
