import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { declareRouteEntitlements, type EntitlementRequest } from '@antasphere/chassis-contract';
import { createPlatform } from '../../src/index.js';
import { requireAuth, requireNonGuest } from '../../src/middleware/index.js';
import {
  FakeHub,
  createDatabase,
  extractCookie,
  json,
  makeCreateTestApp,
  readJson,
  seedLocalWorkspace,
  ssoLogin,
  startPostgres,
  type HubUserFixture,
  type TestApp
} from '../../src/testing/index.js';
import { minimalTool } from '../host/minimal-tool.js';

/**
 * A count limit's hook that answers null ends the gate's judgement of the
 * request (the tool template's feedback of 29 September 2026): no plan read,
 * no credit check at the hub, no usage event. The hook answers null for a
 * caller the handler refuses on its own, so the handler's answer is the one
 * that caller reads, never the organization's balance and top-up page.
 *
 * The route is this file's own: a metered create, closed to guests by its
 * handler, whose count hook answers null for a guest (the shape of a tool's
 * guest-closed door). The file carries its own tool, so it runs in the
 * chassis package only (the tool's integration run excludes it, like
 * `empty-tool.test.ts`).
 */

const HUB_CLIENT_ID = 'tool-things-cloud';
const HUB_SECRET = 'integration-test-hub-secret-nullhook';
const ORG = '77777777-aaaa-4bbb-8ccc-00000000f001';
const GUEST_ORG = '77777777-aaaa-4bbb-8ccc-00000000f002';
const OPERATOR = { email: 'operator@nullhook.test', name: 'Operator', password: 'operator-nullhook-pass-1' };
const ACTION = 'things.create';
const LIMIT = 'things.perWorkspace';

/** The count after this create, or null for a caller the handler refuses (a guest). */
async function thingsAfterCreate(ctx: EntitlementRequest): Promise<number | null> {
  if (!ctx.principal || ctx.principal.origin === 'guest') return null;
  return 1;
}

const tool: typeof minimalTool = {
  ...minimalTool,
  api: {
    ...minimalTool.api,
    routes: (api, ctx, domain) => {
      minimalTool.api.routes!(api, ctx, domain);
      api.use('/counted-things', requireAuth());
      api.post('/counted-things', requireNonGuest(), (c) => c.json({ thing: { id: 'counted' } }, 201));
    }
  },
  entitlements: (env, ctx) => {
    const base = minimalTool.entitlements!(env, ctx);
    return {
      ...base,
      actions: [...base.actions, { key: ACTION, creditsPerUnit: 3, unit: 'call', label: 'Create a thing' }],
      limits: { ...base.limits, [LIMIT]: { oss: null, free: 10, pro: null } },
      routes: declareRouteEntitlements([
        ...base.routes.values(),
        {
          route: { method: 'post', path: '/counted-things' },
          meter: { key: ACTION, unit: 'call' },
          limit: { key: LIMIT, value: thingsAfterCreate }
        }
      ])
    };
  }
};

const createTestApp = makeCreateTestApp(createPlatform(tool).boot);

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let workspaceId: string;
let ownerCookie: string;
let guestCookie: string;

const owner: HubUserFixture = {
  sub: 'hub-nullhook-owner',
  email: 'owner@nullhook.test',
  name: 'Owner',
  workspaceId: ORG,
  role: 'owner',
  workspaceName: 'Null Hook Org'
};
// A hub person whose own organizations never include ORG: their seat there is a guest row.
const guest: HubUserFixture = {
  sub: 'hub-nullhook-guest',
  email: 'guest@nullhook.test',
  name: 'Guest',
  workspaceId: GUEST_ORG,
  role: 'owner',
  workspaceName: 'Guest Own Org'
};

const create = (cookie: string) =>
  app.app.request('/api/v1/counted-things', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-workspace-id': workspaceId },
    body: JSON.stringify({ name: 'a thing' })
  });

beforeAll(async () => {
  container = await startPostgres();
  hub = await FakeHub.start({ clientId: HUB_CLIENT_ID, clientSecret: HUB_SECRET });
  app = await createTestApp(
    await createDatabase(container, 'ent_null_hook'),
    { EDITION: 'cloud', HUB_ISSUER_URL: hub.issuer, HUB_CLIENT_ID, HUB_CLIENT_SECRET: HUB_SECRET },
    { entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0, outageHoldMs: 0 } }
  );
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Null Hook', owner: OPERATOR })
  );
  await seedLocalWorkspace(app, 'Null Hook', OPERATOR.email);
  extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OPERATOR.email, password: OPERATOR.password })
    )
  );
  ownerCookie = await ssoLogin(app, hub, owner);
  guestCookie = await ssoLogin(app, hub, guest);
  const { rows } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [ORG]);
  workspaceId = rows[0].id as string;
  await app.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, (SELECT id FROM "user" WHERE email = $2), 'member', 'guest', true)`,
    [workspaceId, guest.email]
  );
  hub.setPrice(ACTION, { creditsPerUnit: 3, unit: 'call', per: 1 });
  hub.setBalance(ORG, 0);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('a count hook that answers null ends the gate’s judgement', () => {
  // First, on a cold plan cache: a gate that still read the plan for a
  // caller its hook answered null for would ask the hub here (verifier
  // round 1, F2).
  it('a guest at a zero balance reads the handler’s 403 guest_forbidden, no balance, and the hub is asked nothing', async () => {
    const checks = hub.checkRequests.length;
    const plans = hub.entitlementsRequests.length;
    const res = await create(guestCookie);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('guest_forbidden');
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('balance');
    expect(hub.checkRequests.length).toBe(checks);
    expect(hub.entitlementsRequests.length).toBe(plans);
  });

  it('a member at a zero balance meets the credit check: 402 with the organization’s figures (the route is metered)', async () => {
    const checks = hub.checkRequests.length;
    const res = await create(ownerCookie);
    expect(res.status).toBe(402);
    expect((await readJson(res)).error).toMatchObject({
      code: 'entitlement_denied',
      details: { credits: 3, balance: 0 }
    });
    expect(hub.checkRequests.length).toBe(checks + 1);
  });

  it('a guest with credits in the organization still reads 403 guest_forbidden, and no event is queued', async () => {
    hub.setBalance(ORG, 1_000);
    const checks = hub.checkRequests.length;
    const res = await create(guestCookie);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_forbidden');
    expect(hub.checkRequests.length).toBe(checks);
    await new Promise((r) => setTimeout(r, 2_500)); // longer than the queue's poll
    expect(hub.usageEvents.size).toBe(0);
    hub.setBalance(ORG, 0);
  });
});
