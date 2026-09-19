import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiKeys, files, invitations, user as userTable, workspaceMembers } from '@antasphere/chassis-db';
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
 * Cursor pagination across the list endpoints: exhaustive page walks (no
 * duplicates, no gaps, strict (created_at, id) DESC), the same-timestamp
 * tie-break (the microsecond regression the plain-id cursor exists for),
 * cursor tolerance (malformed → page 1, unknown uuid → empty page), limit
 * validation, the SQL-side soft-delete filter, and api-key scoping held
 * across pages.
 */

const OWNER = { email: 'owner@pagination.test', name: 'Page Owner', password: 'page-owner-password-1' };
const MEMBER = { email: 'member@pagination.test', name: 'Page Member', password: 'page-member-pass-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let workspaceId: string;
let ownerUserId: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

/** Deterministic, distinct timestamps (UTC, second-spaced) for seeded rows. */
const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i));

async function listPage(path: string, query: Record<string, string>, cookie = ownerCookie) {
  const qs = new URLSearchParams(query).toString();
  return app.app.request(`/api/v1/${path}${qs ? `?${qs}` : ''}`, { headers: { cookie } });
}

interface WalkRow {
  id: string;
  createdAt: string;
}

/** Follow nextCursor to the end; the final page must answer nextCursor null. */
async function walk(path: string, key: string, limit: number, cookie = ownerCookie): Promise<WalkRow[]> {
  const rows: WalkRow[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const res = await listPage(path, { limit: String(limit), ...(cursor ? { cursor } : {}) }, cookie);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const page = body[key] as WalkRow[];
    expect(page.length).toBeLessThanOrEqual(limit);
    rows.push(...page);
    if (body.nextCursor === null) return rows;
    expect(typeof body.nextCursor).toBe('string');
    cursor = body.nextCursor;
  }
  throw new Error(`walk of /${path} did not terminate`);
}

/** No duplicates, no gaps: the walked ids are exactly the expected set. */
function expectExactly(rows: WalkRow[], expectedIds: string[]): void {
  const ids = rows.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(ids)).toEqual(new Set(expectedIds));
}

/** Strict (createdAt, id) DESC across page boundaries (ISO strings compare lexicographically). */
function expectStrictDesc(rows: WalkRow[]): void {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    const strictlyBefore =
      cur.createdAt < prev.createdAt || (cur.createdAt === prev.createdAt && cur.id < prev.id);
    expect(
      strictlyBefore,
      `row ${i} out of order: ${prev.createdAt}/${prev.id} then ${cur.createdAt}/${cur.id}`
    ).toBe(true);
  }
}

async function uploadFile(name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', cookie: ownerCookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'pagination'));

  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Pagination', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  workspaceId = me.workspace.id;
  ownerUserId = me.user.id;
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('page walks (no dups, no gaps, strict order)', () => {
  const walkFileIds: string[] = [];

  it('files: uploads walk back newest-first through ?limit=2 pages', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await uploadFile(`walk-${i}.txt`, `walk file ${i}`);
      walkFileIds.push(id);
      // Pin distinct timestamps so the expected order is exact; the
      // identical-timestamp case gets its own test below.
      await app.db.db
        .update(files)
        .set({ createdAt: ts(i) })
        .where(eq(files.id, id));
    }
    const rows = await walk('files', 'files', 2);
    expectExactly(rows, walkFileIds);
    expectStrictDesc(rows);
  });

  it('members: seeded memberships walk cleanly (join included)', async () => {
    const memberIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const userId = `pagination-user-${i}`;
      await app.db.db.insert(userTable).values({
        id: userId,
        name: `Walk User ${i}`,
        email: `walk-user-${i}@pagination.test`,
        emailVerified: true
      });
      const [row] = await app.db.db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role: 'member', createdAt: ts(i) })
        .returning({ id: workspaceMembers.id });
      memberIds.push(row!.id);
    }
    const [ownerRow] = await app.db.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, ownerUserId));
    const rows = await walk('members', 'members', 2);
    expectExactly(rows, [...memberIds, ownerRow!.id]);
    expectStrictDesc(rows);
  });

  it('invitations: seeded invitations walk cleanly', async () => {
    const invitationIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [row] = await app.db.db
        .insert(invitations)
        .values({
          workspaceId,
          email: `walk-invitee-${i}@pagination.test`,
          role: 'member',
          tokenHash: randomUUID(),
          invitedBy: ownerUserId,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: ts(i)
        })
        .returning({ id: invitations.id });
      invitationIds.push(row!.id);
    }
    const rows = await walk('invitations', 'invitations', 2);
    expectExactly(rows, invitationIds);
    expectStrictDesc(rows);
  });
});

describe('same-timestamp tie-break (the microsecond regression test)', () => {
  it('walks limit=1 through rows sharing one createdAt without dup or gap', async () => {
    const tied = new Date(Date.UTC(2025, 5, 1, 12, 0, 0, 123));
    const tiedIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await uploadFile(`tied-${i}.txt`, `tied file ${i}`);
      await app.db.db.update(files).set({ createdAt: tied }).where(eq(files.id, id));
      tiedIds.push(id);
    }
    const rows = await walk('files', 'files', 1);
    // Each tied row exactly once (id DESC breaks the tie), everything ordered.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const id of tiedIds) expect(rows.map((r) => r.id)).toContain(id);
    expectStrictDesc(rows);
  });
});

describe('cursor tolerance', () => {
  const endpoints: Array<[path: string, key: string]> = [
    ['members', 'members'],
    ['api-keys', 'apiKeys'],
    ['invitations', 'invitations'],
    ['files', 'files'],
    ['audit', 'entries']
  ];

  it('a malformed cursor is ignored: ?cursor=banana equals the uncursored first page', async () => {
    for (const [path] of endpoints) {
      const withBanana = await listPage(path, { cursor: 'banana' });
      expect(withBanana.status).toBe(200);
      const plain = await listPage(path, {});
      expect(await readJson(withBanana)).toEqual(await readJson(plain));
    }
  });

  it('an unknown well-formed uuid cursor yields an empty page + nextCursor null', async () => {
    const ghost = randomUUID();
    for (const [path, key] of endpoints) {
      if (path === 'audit') continue; // numeric ids — a uuid is just malformed there
      const res = await listPage(path, { cursor: ghost });
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ [key]: [], nextCursor: null });
    }
  });

  it('rejects out-of-range limits with validation_error on every list', async () => {
    for (const [path] of endpoints) {
      for (const limit of ['0', '101']) {
        const res = await listPage(path, { limit });
        expect(res.status).toBe(400);
        const body = await readJson(res);
        expect(body.error.code).toBe('validation_error');
      }
    }
  });
});

describe('soft-deleted files stay out of every page', () => {
  it('a deleted file appears on no page of the walk', async () => {
    const doomedId = await uploadFile('doomed.txt', 'delete me before the walk');
    const del = await app.app.request(`/api/v1/files/${doomedId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(del.status).toBe(200);
    const rows = await walk('files', 'files', 1);
    expect(rows.map((r) => r.id)).not.toContain(doomedId);
  });

  it('re-uploading identical bytes revives the soft-deleted row back into the list', async () => {
    const body = 'phoenix bytes — deleted then re-uploaded';
    const phoenixId = await uploadFile('phoenix.txt', body);

    const del = await app.app.request(`/api/v1/files/${phoenixId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(del.status).toBe(200);
    const gone = await readJson(await listPage('files', {}));
    expect(gone.files.map((f: WalkRow) => f.id)).not.toContain(phoenixId);

    // Same bytes → the dedupe path revives the existing row (deletedAt back
    // to null), which the SQL-side isNull filter must show again.
    const reupload = await app.app.request(`/api/v1/files?name=${encodeURIComponent('phoenix.txt')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: ownerCookie },
      body
    });
    expect(reupload.status).toBe(201);
    const reuploaded = await readJson(reupload);
    expect(reuploaded.deduplicated).toBe(true);
    expect(reuploaded.file.id).toBe(phoenixId);

    const back = await readJson(await listPage('files', {}));
    expect(back.files.map((f: WalkRow) => f.id)).toContain(phoenixId);
  });
});

describe('api-key scoping holds on every page', () => {
  let memberCookie: string;
  const memberKeyIds: string[] = [];
  const ownerKeyIds: string[] = [];

  it('each user sees exactly THEIR OWN keys across a walk (keys are user credentials)', async () => {
    // Bring in a real member via the invitation-accept flow.
    const invite = await app.app.request('/api/v1/invitations', {
      ...json({ email: MEMBER.email, role: 'member' }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    const { acceptUrl } = await readJson(invite);
    const token = acceptUrl.split('/invite/')[1]!;
    const accepted = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: MEMBER.name, password: MEMBER.password })
    );
    expect(accepted.status).toBe(200);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: MEMBER.email, password: MEMBER.password })
    );
    memberCookie = extractCookie(signIn);

    const mint = async (cookie: string, name: string) => {
      const res = await app.app.request('/api/v1/api-keys', {
        ...json({ name, scopes: [host.scopes.read] }),
        headers: { 'content-type': 'application/json', cookie }
      });
      expect(res.status).toBe(201);
      return (await readJson(res)).apiKey.id as string;
    };
    for (let i = 0; i < 2; i++) memberKeyIds.push(await mint(memberCookie, `member-key-${i}`));
    for (let i = 0; i < 3; i++) ownerKeyIds.push(await mint(ownerCookie, `owner-key-${i}`));
    // Pin distinct timestamps (rapid mints can share a millisecond) so the
    // strict-order assertion is exact.
    const allKeyIds = [...memberKeyIds, ...ownerKeyIds];
    for (let i = 0; i < allKeyIds.length; i++) {
      await app.db.db
        .update(apiKeys)
        .set({ createdAt: ts(10 + i) })
        .where(eq(apiKeys.id, allKeyIds[i]!));
    }

    const memberRows = await walk('api-keys', 'apiKeys', 1, memberCookie);
    expectExactly(memberRows, memberKeyIds);
    expectStrictDesc(memberRows);

    // The owner's walk is creator-scoped too (user-scoped credential model):
    // no role sees anyone else's keys through this listing.
    const ownerRows = await walk('api-keys', 'apiKeys', 2);
    expectExactly(ownerRows, ownerKeyIds);
    expectStrictDesc(ownerRows);
  });
});
