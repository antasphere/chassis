import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
 * The hub organization id as a workspace selector (PRDCT-2947), cloud edition.
 *
 * `X-Workspace-Id` (and an API key's pin comparison) accepts EITHER the local
 * workspace id OR the id of the hub organization the workspace projects
 * (`workspaces.central_account_id`): a person names their organization the
 * hub's way (`--org <hub org id>`) and the one membership rule
 * (`resolveMembership`) maps it, for every credential kind. This suite pins:
 *
 *  - a session naming ORG_A / ORG_B by hub id lands on each projection's
 *    LOCAL id, and the two differ;
 *  - a hub id the person holds no membership under (a phantom uuid, or a
 *    REAL projected org of someone else) is the same fail-closed 401 as an
 *    unknown local id — no oracle;
 *  - an unpinned API key resolves the hub id the same way (401
 *    `invalid_api_key` on a miss);
 *  - a key PINNED to ORG_A's projection takes ORG_A's hub id as a
 *    restatement of the pin, and still refuses ORG_B by hub id AND by local
 *    id with 403 `workspace_mismatch`;
 *  - an OAuth bearer resolves the hub id too;
 *  - `/me.workspaces[]` carries `centralAccountId` (ORG_A on the projection,
 *    null on the local workspace).
 */

const OPERATOR = { email: 'operator@orgsel.test', name: 'Operator', password: 'operator-pass-orgsel-1' };
const ORG_A = '88888888-aaaa-4bbb-8ccc-000000000001';
const ORG_B = '88888888-aaaa-4bbb-8ccc-000000000002';
/** A real org, projected here by someone else: hana holds no membership in it. */
const ORG_C = '88888888-aaaa-4bbb-8ccc-000000000003';
/** Well-formed, and no workspace id nor hub org id anywhere. */
const PHANTOM = '88888888-aaaa-4bbb-8ccc-0000000000ff';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

let hanaCookie = '';
/** The operator's cloud-LOCAL workspace (centralAccountId NULL), hana a local member of it. */
let localWorkspaceId = '';
let orgALocalId = '';
let orgBLocalId = '';
let orgCLocalId = '';
let unpinnedKey = '';
let pinnedKey = '';

let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const hana: HubUserFixture = {
  sub: 'hub-hana-orgsel',
  email: 'hana@orgsel.test',
  name: 'Hana Hub',
  workspaceId: ORG_A,
  role: 'owner',
  workspaceName: 'Org A'
};

const otto: HubUserFixture = {
  sub: 'hub-otto-orgsel',
  email: 'otto@orgsel.test',
  name: 'Otto Other',
  workspaceId: ORG_C,
  role: 'owner',
  workspaceName: 'Org C'
};

const me = (headers: Record<string, string>) =>
  app.app.request('/api/v1/me', { headers: { 'x-forwarded-for': nextIp(), ...headers } });

async function localIdOf(centralAccountId: string): Promise<string> {
  const { rows } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
    centralAccountId
  ]);
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

async function mintKey(body: Record<string, unknown>): Promise<string> {
  const res = await app.app.request(
    '/api/v1/api-keys',
    json({ scopes: [host.scopes.read], ...body }, { cookie: hanaCookie, 'x-workspace-id': orgALocalId })
  );
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  app = await createTestApp(await createDatabase(container, 'hub_org_selector'), {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-orgsel'
  });

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Org Selector', owner: OPERATOR })
  );
  expect(setup.status).toBe(201);
  localWorkspaceId = await sso.seedLocalWorkspace(app, 'Operator Local', OPERATOR.email);
  // Sanity: the operator can sign in (the local workspace is a real one).
  extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OPERATOR.email, password: OPERATOR.password })
    )
  );

  // Otto projects ORG_C, an org hana is not in.
  await sso.ssoLogin(app, hub, otto);
  orgCLocalId = await localIdOf(ORG_C);

  // Hana is in ORG_A (her fixture's org) and ORG_B: one login projects both.
  hub.setUserOrg(hana.sub, ORG_B, { name: 'Org B', role: 'member' });
  hanaCookie = await sso.ssoLogin(app, hub, hana);
  orgALocalId = await localIdOf(ORG_A);
  orgBLocalId = await localIdOf(ORG_B);

  // And a LOCAL membership of the operator's workspace (the reconcile only
  // ever touches origin='hub' rows).
  await app.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, (SELECT id FROM "user" WHERE email = $2), 'member', 'local', true)`,
    [localWorkspaceId, hana.email]
  );

  unpinnedKey = await mintKey({ name: 'orgsel-unpinned' });
  pinnedKey = await mintKey({ name: 'orgsel-pinned', workspaceId: orgALocalId });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('a session names its organization by the hub id', () => {
  it('ORG_A hub id → the LOCAL id of ORG_A’s projection, hub-origin', async () => {
    const res = await me({ cookie: hanaCookie, 'x-workspace-id': ORG_A });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(orgALocalId);
    expect(body.activeWorkspaceId).not.toBe(ORG_A);
    expect(body.workspace.hubOrigin).toBe(true);
  });

  it('ORG_B hub id → ORG_B’s projection, a different workspace', async () => {
    const res = await me({ cookie: hanaCookie, 'x-workspace-id': ORG_B });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(orgBLocalId);
    expect(orgBLocalId).not.toBe(orgALocalId);
    expect(body.workspace.hubOrigin).toBe(true);
  });

  it('a hub id she holds no membership under is the same fail-closed 401 as an unknown local id', async () => {
    const phantomHubId = await me({ cookie: hanaCookie, 'x-workspace-id': PHANTOM });
    const foreignHubId = await me({ cookie: hanaCookie, 'x-workspace-id': ORG_C });
    const foreignLocalId = await me({ cookie: hanaCookie, 'x-workspace-id': orgCLocalId });
    const unknownLocalId = await me({
      cookie: hanaCookie,
      'x-workspace-id': '00000000-0000-4000-8000-000000000000'
    });
    const bodies = await Promise.all(
      [phantomHubId, foreignHubId, foreignLocalId, unknownLocalId].map((r) => r.text())
    );
    for (const res of [phantomHubId, foreignHubId, foreignLocalId, unknownLocalId]) {
      expect(res.status).toBe(401);
    }
    // One answer for all four: nothing tells an existing org from a phantom.
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('API keys', () => {
  it('an UNPINNED key resolves the hub id; a hub id she is not in is 401 invalid_api_key', async () => {
    const res = await me({ authorization: `Bearer ${unpinnedKey}`, 'x-workspace-id': ORG_A });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(orgALocalId);

    for (const named of [ORG_C, PHANTOM]) {
      const miss = await me({ authorization: `Bearer ${unpinnedKey}`, 'x-workspace-id': named });
      expect(miss.status).toBe(401);
      expect((await readJson(miss)).error.code).toBe('invalid_api_key');
    }
  });

  it('a key PINNED to ORG_A: its hub id restates the pin, ORG_B by either id is workspace_mismatch', async () => {
    const byHubId = await me({ authorization: `Bearer ${pinnedKey}`, 'x-workspace-id': ORG_A });
    expect(byHubId.status).toBe(200);
    expect((await readJson(byHubId)).activeWorkspaceId).toBe(orgALocalId);

    const byLocalId = await me({ authorization: `Bearer ${pinnedKey}`, 'x-workspace-id': orgALocalId });
    expect(byLocalId.status).toBe(200);
    expect((await readJson(byLocalId)).activeWorkspaceId).toBe(orgALocalId);

    for (const named of [ORG_B, orgBLocalId]) {
      const mismatch = await me({ authorization: `Bearer ${pinnedKey}`, 'x-workspace-id': named });
      expect(mismatch.status).toBe(403);
      expect((await readJson(mismatch)).error.code).toBe('workspace_mismatch');
    }

    const bare = await me({ authorization: `Bearer ${pinnedKey}` });
    expect(bare.status).toBe(200);
    expect((await readJson(bare)).activeWorkspaceId).toBe(orgALocalId);
  });
});

describe('the hub id is matched without regard to case (verifier round 1, F6)', () => {
  const UPPER_A = ORG_A.toUpperCase();

  it('the upper-case spelling differs from the stored one (the test means something)', () => {
    expect(UPPER_A).not.toBe(ORG_A);
  });

  it('a session naming ORG_A in upper case → ORG_A’s projection', async () => {
    const res = await me({ cookie: hanaCookie, 'x-workspace-id': UPPER_A });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(orgALocalId);
  });

  it('an unpinned key naming ORG_A in upper case → ORG_A’s projection', async () => {
    const res = await me({ authorization: `Bearer ${unpinnedKey}`, 'x-workspace-id': UPPER_A });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(orgALocalId);
  });

  it('the key pinned to ORG_A takes the upper-case hub id as its pin', async () => {
    const res = await me({ authorization: `Bearer ${pinnedKey}`, 'x-workspace-id': UPPER_A });
    expect(res.status).toBe(200);
    expect((await readJson(res)).activeWorkspaceId).toBe(orgALocalId);
  });
});

describe('OAuth bearer', () => {
  it('ORG_A hub id → ORG_A’s projection', async () => {
    const bearer = await sso.oauthBearer(app, hanaCookie);
    const res = await me({ authorization: `Bearer ${bearer}`, 'x-workspace-id': ORG_A });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(orgALocalId);
    expect(body.via).toBe('oauth');
  });
});

describe('/me.workspaces[] carries the hub org id', () => {
  it('ORG_A’s row carries ORG_A, ORG_B’s ORG_B, the local workspace’s null', async () => {
    const res = await me({ cookie: hanaCookie });
    expect(res.status).toBe(200);
    const rows = Object.fromEntries(
      (await readJson(res)).workspaces.map((w: { id: string; centralAccountId: string | null }) => [
        w.id,
        w.centralAccountId
      ])
    );
    expect(rows[orgALocalId]).toBe(ORG_A);
    expect(rows[orgBLocalId]).toBe(ORG_B);
    expect(rows[localWorkspaceId]).toBeNull();
    expect(orgCLocalId in rows).toBe(false);
  });
});
