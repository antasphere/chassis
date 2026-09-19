import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * The user-scoped credential model (ADR 014 as amended): one user in TWO
 * workspaces, one workspace per request, selected by X-Workspace-Id for
 * EVERY credential kind. Covers the session mechanism (default, switch,
 * fail-closed), /me's all-workspaces shape with explicit default/suspended
 * flags, cross-workspace data/key/invitation isolation, user-scoped vs
 * PINNED API keys (pin resolution + the mismatch 403 pinned keys keep), the
 * CLI-auth unpinned-by-default mint, the is_default inertness invariant,
 * the multi-owned-workspace deletion guard, and the admin cross-workspace
 * delete refusal.
 */
const OWNER = {
  email: 'multi-owner@ws.test',
  name: 'Multi Owner',
  password: 'a-long-owner-password-123'
};
const BOB = { email: 'bob@ws.test', name: 'Bob Member', password: 'a-long-bob-password-1234' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let email: RecordingEmailDriver;
let ownerCookie: string;
let w1 = ''; // setup's workspace — the OLDEST membership, the default
let w2 = ''; // second workspace, created through the registry service

const WS_HEADER = 'x-workspace-id';

async function me(cookie: string, workspace?: string) {
  return app.app.request('/api/v1/me', {
    headers: { cookie, ...(workspace ? { [WS_HEADER]: workspace } : {}) }
  });
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'ws_scoping');
  email = new RecordingEmailDriver();
  app = await createTestApp(dbUrl, {}, { email });

  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'First Workspace',
      owner: OWNER
    })
  });
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;

  const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  expect(signIn.status).toBe(200);
  ownerCookie = extractCookie(signIn);

  // The registry's WorkspaceService is the blessed later-workspace path.
  const meRes = await readJson(await me(ownerCookie));
  const created = await app.registry.workspaces.create('Second Workspace', meRes.user.id);
  w2 = created.workspaceId;

  // Bob: a single-membership member of W2 only.
  const bob = await app.auth.api.signUpEmail({
    body: { email: BOB.email, password: BOB.password, name: BOB.name }
  });
  await app.db.db.insert(workspaceMembers).values({ workspaceId: w2, userId: bob.user.id, role: 'member' });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('session resolution (X-Workspace-Id)', () => {
  it('defaults to the OLDEST active membership (no default set) and lists all workspaces', async () => {
    const res = await me(ownerCookie);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(w1);
    expect(body.workspace.id).toBe(w1);
    expect(body.workspace.name).toBe('First Workspace');
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, w2]);
    expect(body.workspaces[1]).toEqual({
      id: w2,
      name: 'Second Workspace',
      role: 'owner',
      hubOrigin: false,
      look: { theme: null, pattern: null, field: null, grain: null },
      suspended: false,
      default: false
    });
  });

  it('the header switches the active workspace', async () => {
    const body = await readJson(await me(ownerCookie, w2));
    expect(body.activeWorkspaceId).toBe(w2);
    expect(body.workspace.name).toBe('Second Workspace');
    expect(body.role).toBe('owner');
    // The list is header-independent — all memberships either way.
    expect(body.workspaces).toHaveLength(2);
  });

  it('fails closed on a workspace the user does not belong to (no oracle)', async () => {
    // Bob is NOT a member of W1 — same 401 as a workspace that does not exist.
    const bobSignIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: BOB.email, password: BOB.password })
    });
    const bobCookie = extractCookie(bobSignIn);
    const foreign = await me(bobCookie, w1);
    expect(foreign.status).toBe(401);
    const phantom = await me(bobCookie, '00000000-0000-4000-8000-000000000000');
    expect(phantom.status).toBe(401);
    // Malformed header: clean 401, never a Postgres uuid-cast 500.
    const malformed = await me(bobCookie, 'not-a-uuid');
    expect(malformed.status).toBe(401);
    // Sanity: without the header Bob's sole membership resolves.
    const plain = await readJson(await me(bobCookie));
    expect(plain.activeWorkspaceId).toBe(w2);
    expect(plain.workspaces).toHaveLength(1);
  });
});

describe('data + invitation isolation across workspaces', () => {
  it('files are scoped to the active workspace', async () => {
    const up1 = await app.app.request('/api/v1/files?name=w1.txt', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain' },
      body: 'first workspace bytes'
    });
    expect(up1.status).toBe(201);
    const up2 = await app.app.request('/api/v1/files?name=w2.txt', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain', [WS_HEADER]: w2 },
      body: 'second workspace bytes'
    });
    expect(up2.status).toBe(201);

    const list1 = await readJson(
      await app.app.request('/api/v1/files', { headers: { cookie: ownerCookie } })
    );
    expect(list1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1.txt']);
    const list2 = await readJson(
      await app.app.request('/api/v1/files', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
    );
    expect(list2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);

    // A W2 file id is NOT reachable in the W1 context (404, not leak).
    const w2FileId = list2.files[0].id;
    const cross = await app.app.request(`/api/v1/files/${w2FileId}`, {
      headers: { cookie: ownerCookie }
    });
    expect(cross.status).toBe(404);
  });

  it('invitations land in — and list under — the active workspace only', async () => {
    const create = await app.app.request('/api/v1/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json', [WS_HEADER]: w2 },
      body: JSON.stringify({ email: 'invitee-w2@ws.test', role: 'member' })
    });
    expect(create.status).toBe(201);

    const listW1 = await readJson(
      await app.app.request('/api/v1/invitations', { headers: { cookie: ownerCookie } })
    );
    expect(
      listW1.invitations.filter((i: { email: string }) => i.email === 'invitee-w2@ws.test')
    ).toHaveLength(0);
    const listW2 = await readJson(
      await app.app.request('/api/v1/invitations', {
        headers: { cookie: ownerCookie, [WS_HEADER]: w2 }
      })
    );
    expect(
      listW2.invitations.filter((i: { email: string }) => i.email === 'invitee-w2@ws.test')
    ).toHaveLength(1);
  });

  it('members lists follow the active workspace', async () => {
    const listW2 = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
    );
    const emails = listW2.members.map((m: { email: string }) => m.email);
    expect(emails).toContain(BOB.email);
    const listW1 = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    expect(listW1.members.map((m: { email: string }) => m.email)).not.toContain(BOB.email);
  });
});

describe('API keys are user credentials with an optional pin', () => {
  let userKey = ''; // unpinned (the mint default) — user-scoped
  let pinnedKey = ''; // pinned to w2 at mint

  it('mints UNPINNED by default: the header selects the workspace per request', async () => {
    const mint = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'k-user', scopes: [host.scopes.read] })
    });
    expect(mint.status).toBe(201);
    const minted = await readJson(mint);
    expect(minted.apiKey.workspaceId).toBeNull();
    userKey = minted.key;

    // No selector → the same default rule as sessions (oldest membership).
    const files1 = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${userKey}` } })
    );
    expect(files1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1.txt']);
    // The header is honored by the machine credential — org as a parameter.
    const files2 = await readJson(
      await app.app.request('/api/v1/files', {
        headers: { authorization: `Bearer ${userKey}`, [WS_HEADER]: w2 }
      })
    );
    expect(files2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);
    // A workspace the creator does not belong to fails closed — same 401 as
    // one that does not exist (no oracle).
    const foreign = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${userKey}`, [WS_HEADER]: '00000000-0000-4000-8000-000000000000' }
    });
    expect(foreign.status).toBe(401);
  });

  it('/me lists ALL the holder’s workspaces for a machine credential, flags explicit', async () => {
    const meKey = await readJson(
      await app.app.request('/api/v1/me', {
        headers: { authorization: `Bearer ${userKey}`, [WS_HEADER]: w2 }
      })
    );
    expect(meKey.activeWorkspaceId).toBe(w2);
    expect(meKey.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, w2]);
    expect(
      meKey.workspaces.every((w: { suspended: boolean; default: boolean }) => !w.suspended && !w.default)
    ).toBe(true);
  });

  it('an explicit pin keeps the old binding: pin resolved, mismatching header → 403', async () => {
    const mint = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'k-pinned', scopes: [host.scopes.read], workspaceId: w2 })
    });
    expect(mint.status).toBe(201);
    const minted = await readJson(mint);
    expect(minted.apiKey.workspaceId).toBe(w2);
    pinnedKey = minted.key;

    // The pin resolves — NOT the user's default (w1): pinned keys behave
    // exactly as keys did before the model change.
    const files = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${pinnedKey}` } })
    );
    expect(files.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);
    // A MATCHING header is fine (idempotent restatement of the pin)...
    const match = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${pinnedKey}`, [WS_HEADER]: w2 }
    });
    expect(match.status).toBe(200);
    // ...a MISMATCHING one is rejected loudly, never silently served the pin.
    const mismatch = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${pinnedKey}`, [WS_HEADER]: w1 }
    });
    expect(mismatch.status).toBe(403);
    expect((await readJson(mismatch)).error.code).toBe('workspace_mismatch');
  });

  it('pinning requires an ACTIVE membership of the pin (uniform 403, no oracle)', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'k-evil',
        scopes: [host.scopes.read],
        workspaceId: '00000000-0000-4000-8000-000000000000'
      })
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('no_membership');
  });

  it('the listing is creator-scoped (all the caller’s keys, any workspace context)', async () => {
    const names = (
      await readJson(await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie } }))
    ).apiKeys.map((k: { name: string }) => k.name);
    expect(names).toContain('k-user');
    expect(names).toContain('k-pinned');
    // The active-workspace header does not re-scope the listing — keys are
    // the USER's credentials, not workspace inventory.
    const namesW2 = (
      await readJson(
        await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
      )
    ).apiKeys.map((k: { name: string }) => k.name);
    expect(namesW2).toEqual(names);
  });
});

describe('CLI auth mints user-scoped keys (optional pin)', () => {
  async function completeCli(extra: Record<string, unknown> = {}) {
    email.sent.length = 0;
    const req = await app.app.request('/api/v1/cli/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER.email })
    });
    expect(req.status).toBe(200);
    const mail = [...email.sent].reverse().find((m) => m.to === OWNER.email);
    const otp = /^(\d{6}) /.exec(mail?.subject ?? '')?.[1];
    expect(otp, 'a 6-digit code in the OTP mail subject').toBeTruthy();
    return app.app.request('/api/v1/cli/auth/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER.email, otp, ...extra })
    });
  }

  it('mints UNBOUND by default: the key follows the per-request selector', async () => {
    const res = await completeCli();
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.workspaceId).toBeNull();
    expect(body.apiKey.workspaceId).toBeNull();
    // No selector → the default rule (oldest membership) …
    const files1 = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${body.key}` } })
    );
    expect(files1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1.txt']);
    // … and the header reaches the other workspace with the SAME key.
    const files2 = await readJson(
      await app.app.request('/api/v1/files', {
        headers: { authorization: `Bearer ${body.key}`, [WS_HEADER]: w2 }
      })
    );
    expect(files2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);
  });

  it('honors an explicit workspaceId as a PIN', async () => {
    const res = await completeCli({ workspaceId: w2 });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(w2);
    expect(body.apiKey.workspaceId).toBe(w2);
    // The minted key really is pinned to W2 …
    const files = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${body.key}` } })
    );
    expect(files.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);
    // … and keeps the pinned mismatch refusal.
    const mismatch = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${body.key}`, [WS_HEADER]: w1 }
    });
    expect(mismatch.status).toBe(403);
    expect((await readJson(mismatch)).error.code).toBe('workspace_mismatch');
  });

  it('rejects a pin the account is not an active member of (uniform 403)', async () => {
    const res = await completeCli({ workspaceId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('no_membership');
  });
});

describe('is_default is INERT this phase — but the ordering already honors it', () => {
  it('no flow above ever set a default membership (nothing writes it yet)', async () => {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_members WHERE is_default`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('a manually-set default flips selector-less resolution (the reconcile contract)', async () => {
    const meBody = await readJson(await me(ownerCookie));
    const ownerId = meBody.user.id as string;
    expect(meBody.activeWorkspaceId).toBe(w1); // ordering no-op while all false
    await app.db.pool.query(
      `UPDATE workspace_members SET is_default = true WHERE user_id = $1 AND workspace_id = $2`,
      [ownerId, w2]
    );
    try {
      const flipped = await readJson(await me(ownerCookie));
      expect(flipped.activeWorkspaceId).toBe(w2);
      expect(
        flipped.workspaces.find((w: { id: string }) => w.id === w2)?.default,
        'the wire carries the default flag explicitly'
      ).toBe(true);
    } finally {
      await app.db.pool.query(`UPDATE workspace_members SET is_default = false WHERE user_id = $1`, [
        ownerId
      ]);
    }
    // Back to the deterministic oldest once no default exists.
    expect((await readJson(await me(ownerCookie))).activeWorkspaceId).toBe(w1);
  });
});

describe('admin delete stays inside the workspace', () => {
  it('refuses to delete an account that belongs to other workspaces', async () => {
    // Bob joins W1 too — the admin surface must now refuse account deletion.
    const [bobRow] = await app.db.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w2), eq(workspaceMembers.role, 'member')));
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: w1, userId: bobRow!.userId, role: 'member' });

    const members = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    const bobMember = members.members.find((m: { email: string }) => m.email === BOB.email);
    expect(bobMember).toBeTruthy();

    const del = await app.app.request(`/api/v1/members/${bobMember.id}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(del.status).toBe(409);
    expect((await readJson(del)).error.code).toBe('member_of_other_workspaces');

    // Deactivation is the in-workspace tool and still works.
    const patch = await app.app.request(`/api/v1/members/${bobMember.id}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false })
    });
    expect(patch.status).toBe(200);
    // Bob's W2 standing is untouched.
    const [w2Row] = await app.db.db
      .select({ isActive: workspaceMembers.isActive })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w2), eq(workspaceMembers.userId, bobRow!.userId)));
    expect(w2Row!.isActive).toBe(true);
  });
});

describe('self-service deletion guards EVERY owned workspace', () => {
  const CARL = { email: 'carl@ws.test', name: 'Carl Owner', password: 'a-long-carl-password-123' };
  const DAVE = { email: 'dave@ws.test', name: 'Dave Owner', password: 'a-long-dave-password-123' };
  let carlCookie = '';
  let carlId = '';
  let daveId = '';
  let w3 = '';
  let w4 = '';

  beforeAll(async () => {
    const carl = await app.auth.api.signUpEmail({
      body: { email: CARL.email, password: CARL.password, name: CARL.name }
    });
    carlId = carl.user.id;
    const dave = await app.auth.api.signUpEmail({
      body: { email: DAVE.email, password: DAVE.password, name: DAVE.name }
    });
    daveId = dave.user.id;
    w3 = (await app.registry.workspaces.create('Carl W3', carlId)).workspaceId;
    w4 = (await app.registry.workspaces.create('Carl W4', carlId)).workspaceId;
    const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: CARL.email, password: CARL.password })
    });
    carlCookie = extractCookie(signIn);
  });

  async function deleteCarl() {
    return app.app.request('/api/v1/auth/delete-user', {
      method: 'POST',
      headers: { cookie: carlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: CARL.password })
    });
  }

  it('rejects while the user is the sole owner of ANY workspace', async () => {
    expect((await deleteCarl()).status).toBe(400);

    // A co-owner in ONE of the two owned workspaces is not enough.
    await app.db.db.insert(workspaceMembers).values({ workspaceId: w3, userId: daveId, role: 'owner' });
    expect((await deleteCarl()).status).toBe(400);
  });

  it('succeeds once every owned workspace keeps another owner; audits per workspace', async () => {
    await app.db.db.insert(workspaceMembers).values({ workspaceId: w4, userId: daveId, role: 'owner' });
    const res = await deleteCarl();
    expect(res.status).toBe(200);

    const rows = await app.db.pool.query(
      `SELECT workspace_id FROM audit_log
       WHERE action = 'user.account_delete' AND resource_id = $1
       ORDER BY workspace_id`,
      [carlId]
    );
    expect(rows.rows.map((r) => r.workspace_id).sort()).toEqual([w3, w4].sort());
  });
});
