import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import { and, eq, isNull } from 'drizzle-orm';
import { apiKeys, auditLog, files, workspaceMembers } from '@antasphere/chassis-db';
import { AccountDeletionService, LastOwnerError } from '@antasphere/chassis-server/accounts';
import { AuditService } from '@antasphere/chassis-server/audit';
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
 * GDPR export + delete (M5):
 *  - GET /workspace/export streams a complete zip (sections, no secrets,
 *    blobs byte-identical, soft-deleted blobs skipped with a reason);
 *  - the dedicated opt-in export scope (the read scope must NOT reach it),
 *    the admin role gate, the ws-export rate limit, and audit coverage for
 *    session AND machine principals;
 *  - self-service and admin account deletion: cascade semantics with files
 *    SURVIVING (created_by → NULL), audit anonymization + completion rows,
 *    the guard ladder, and the last-owner rule;
 *  - (the CLI export command against a real listening server is the tool's:
 *    the tool's app keeps it, `apps/server/test/integration/gdpr-cli.test.ts`).
 *
 * Every actor gets its own x-forwarded-for (TRUST_PROXY=true in the test
 * app) so the per-IP login and ws-export buckets never bleed across tests.
 */

const OWNER = { email: 'owner@gdpr.test', name: 'GDPR Owner', password: 'gdpr-owner-password-12' };
const MEMBER = { email: 'member@gdpr.test', name: 'GDPR Member', password: 'gdpr-member-password-1' };
const ADMIN = { email: 'admin@gdpr.test', name: 'GDPR Admin', password: 'gdpr-admin-password-12' };
const VICTIM = { email: 'victim@gdpr.test', name: 'GDPR Victim', password: 'gdpr-victim-password-1' };
const VICTIM2 = { email: 'victim2@gdpr.test', name: 'GDPR Victim2', password: 'gdpr-victim2-passwd-1' };
const RL = { email: 'rl@gdpr.test', name: 'GDPR RateLimit', password: 'gdpr-rl-password-1234' };

const IPS = {
  owner: '10.0.0.1',
  member: '10.0.0.2',
  admin: '10.0.0.3',
  victim: '10.0.0.4',
  victim2: '10.0.0.5',
  rl: '10.0.0.6',
  machine: '10.0.1.1',
  memberKey: '10.0.1.2'
} as const;

const BLOB_BYTES = 'gdpr export blob payload — byte-identical round trip expected';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let connectionString: string;

let ownerCookie: string;
let memberCookie: string;
let adminCookie: string;
let victimCookie: string;
let victim2Cookie: string;
let rlCookie: string;

let ownerUserId: string;
let workspaceId: string;
let ownerMemberId: string;
let memberMemberId: string;
let adminMemberId: string;
let adminUserId: string;

let liveFileId: string;
let trashedFileId: string;
let exportKey: string; // owner-minted, the export scope only
let exportKeyId: string; // its row id (audit identity assertion)

const json = (body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string, ip: string): Promise<string> {
  const res = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email, password }, { 'x-forwarded-for': ip })
  );
  return extractCookie(res);
}

/** Invite → accept → sign in; returns the session cookie. */
async function addUser(
  user: { email: string; name: string; password: string },
  role: 'member' | 'admin',
  ip: string
): Promise<string> {
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', {
      ...json({ email: user.email, role }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    })
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: user.name, password: user.password })
  );
  return signIn(user.email, user.password, ip);
}

async function upload(cookie: string, name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

async function mintKey(cookie: string, name: string, scopes: string[]): Promise<{ key: string; id: string }> {
  // PINNED to the workspace: the export's api-keys.json section is
  // workspace data, so it lists pinned keys only — a user-scoped (unpinned)
  // key belongs to its holder, not to any one workspace's export.
  const res = await app.app.request('/api/v1/api-keys', {
    ...json({ name, scopes, workspaceId }),
    headers: { 'content-type': 'application/json', cookie }
  });
  expect(res.status).toBe(201);
  const body = await readJson(res);
  return { key: body.key as string, id: body.apiKey.id as string };
}

async function memberIdOf(email: string): Promise<string> {
  const { members } = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
  );
  return members.find((m: { email: string }) => m.email === email).id as string;
}

async function exportRequest(headers: Record<string, string>): Promise<Response> {
  return app.app.request('/api/v1/workspace/export', { headers });
}

beforeAll(async () => {
  container = await startPostgres();
  connectionString = await createDatabase(container, 'gdpr');
  app = await createTestApp(connectionString);

  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'GDPR', owner: OWNER })
  );
  ownerCookie = await signIn(OWNER.email, OWNER.password, IPS.owner);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  ownerUserId = me.user.id;
  workspaceId = me.workspace.id;

  memberCookie = await addUser(MEMBER, 'member', IPS.member);
  adminCookie = await addUser(ADMIN, 'admin', IPS.admin);
  victimCookie = await addUser(VICTIM, 'member', IPS.victim);
  victim2Cookie = await addUser(VICTIM2, 'member', IPS.victim2);
  rlCookie = await addUser(RL, 'admin', IPS.rl);

  ownerMemberId = await memberIdOf(OWNER.email);
  memberMemberId = await memberIdOf(MEMBER.email);
  adminMemberId = await memberIdOf(ADMIN.email);
  const adminMe = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: adminCookie } }));
  adminUserId = adminMe.user.id;

  // Export fixtures: one live blob with known bytes, one soft-deleted file
  // (file delete removes the blob → the export must list it as skipped).
  liveFileId = await upload(ownerCookie, 'export-blob.bin', BLOB_BYTES);
  trashedFileId = await upload(ownerCookie, 'trashed.txt', 'to be soft-deleted');
  await app.app.request(`/api/v1/files/${trashedFileId}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie }
  });

  const minted = await mintKey(ownerCookie, 'export-only', [host.scopes.dataExport]);
  exportKey = minted.key;
  exportKeyId = minted.id;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /workspace/export', () => {
  it('streams a complete bundle for an owner session (audited exactly once)', async () => {
    const res = await exportRequest({ cookie: ownerCookie, 'x-forwarded-for': IPS.owner });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="export-.+\.zip"$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    for (const section of [
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'audit-log.ndjson',
      'files.json',
      'skipped-blobs.json'
    ]) {
      expect(names).toContain(section);
    }

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.workspaceId).toBe(workspaceId);
    expect(manifest.instance.instanceId).toBeTruthy();
    expect(manifest.instance.name).toBe('GDPR');

    const members = JSON.parse(zip.readAsText('members.json'));
    expect(members.map((m: { email: string }) => m.email)).toContain(OWNER.email);

    // Secrets never leave the instance.
    const invitationRows = JSON.parse(zip.readAsText('invitations.json'));
    expect(invitationRows.length).toBeGreaterThan(0);
    for (const row of invitationRows) expect(row).not.toHaveProperty('tokenHash');
    const keyRows = JSON.parse(zip.readAsText('api-keys.json'));
    expect(keyRows.length).toBeGreaterThan(0);
    for (const row of keyRows) {
      expect(row).not.toHaveProperty('secretHash');
      expect(row.keyId).toBeTruthy();
    }

    const ndjsonLines = zip
      .readAsText('audit-log.ndjson')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(ndjsonLines.length).toBeGreaterThanOrEqual(1);
    for (const line of ndjsonLines) expect(() => JSON.parse(line)).not.toThrow();

    // files.json carries ALL rows, soft-deleted included.
    const fileRows = JSON.parse(zip.readAsText('files.json'));
    const trashed = fileRows.find((f: { id: string }) => f.id === trashedFileId);
    expect(trashed).toBeTruthy();
    expect(trashed.deletedAt).toBeTruthy();

    // The live blob is byte-identical; the soft-deleted one is skipped.
    const blobEntry = zip.getEntry(`files/${liveFileId}-export-blob.bin`);
    expect(blobEntry).toBeTruthy();
    expect(blobEntry!.getData().toString('utf8')).toBe(BLOB_BYTES);
    const skipped = JSON.parse(zip.readAsText('skipped-blobs.json'));
    expect(skipped).toContainEqual(
      expect.objectContaining({ fileId: trashedFileId, reason: 'soft-deleted' })
    );

    // Session GETs are not middleware-audited — the handler writes directly,
    // and exactly once.
    const rows = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'workspace.export'), eq(auditLog.actorVia, 'session')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(ownerUserId);
  });

  it('denies a member-role session (403)', async () => {
    const res = await exportRequest({ cookie: memberCookie, 'x-forwarded-for': IPS.member });
    expect(res.status).toBe(403);
  });

  it('machine access: the export scope required, role still enforced, audited with the key identity', async () => {
    // An admin-minted key WITH the export scope streams the zip.
    const ok = await exportRequest({
      authorization: `Bearer ${exportKey}`,
      'x-forwarded-for': IPS.machine
    });
    expect(ok.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await ok.arrayBuffer()));
    expect(zip.getEntry('manifest.json')).toBeTruthy();

    // The read scope alone must NEVER reach the export (exfiltration guard).
    const readOnly = await mintKey(ownerCookie, 'read-only', [host.scopes.read]);
    const denied = await exportRequest({
      authorization: `Bearer ${readOnly.key}`,
      'x-forwarded-for': IPS.machine
    });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('insufficient_scope');

    // A member-minted key with the export scope passes the scope gate but fails
    // the role gate.
    const memberKey = await mintKey(memberCookie, 'member-export', [host.scopes.dataExport]);
    const roleDenied = await exportRequest({
      authorization: `Bearer ${memberKey.key}`,
      'x-forwarded-for': IPS.memberKey
    });
    expect(roleDenied.status).toBe(403);

    // The machine export landed in the audit log with the key's identity.
    const rows = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'workspace.export'), eq(auditLog.actorVia, 'api_key')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKeyId).toBe(exportKeyId);
    expect(rows[0]!.actorUserId).toBe(ownerUserId);
  });

  it('rate limits the 6th export in the window (429)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await exportRequest({ cookie: rlCookie, 'x-forwarded-for': IPS.rl });
      expect(res.status).toBe(200);
      await res.arrayBuffer(); // drain so the pump finishes cleanly
    }
    const sixth = await exportRequest({ cookie: rlCookie, 'x-forwarded-for': IPS.rl });
    expect(sixth.status).toBe(429);
  }, 60_000);
});

describe('self-service account deletion (POST /auth/delete-user)', () => {
  it('rejects a wrong password (400) and leaves the user intact', async () => {
    const res = await app.app.request(
      '/api/v1/auth/delete-user',
      json(
        { password: 'definitely-not-the-password' },
        { cookie: victimCookie, 'x-forwarded-for': IPS.victim }
      )
    );
    expect(res.status).toBe(400);
    expect((await app.app.request('/api/v1/me', { headers: { cookie: victimCookie } })).status).toBe(200);
  });

  it('blocks the last active owner (400 last_owner)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/delete-user',
      json({ password: OWNER.password }, { cookie: ownerCookie, 'x-forwarded-for': IPS.owner })
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(JSON.stringify(body)).toContain('active owner');
    // The owner is untouched.
    expect((await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } })).status).toBe(200);
  });

  it('deletes the account with the full cascade — files survive anonymized', async () => {
    // The victim leaves personal traces first: a file, an API key, audit rows.
    const victimMe = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie: victimCookie } })
    );
    const victimUserId = victimMe.user.id as string;
    const victimFileId = await upload(victimCookie, 'victim-notes.txt', 'personal upload by victim');
    const victimKey = await mintKey(victimCookie, 'victim-key', [host.scopes.read]);

    const [uploadAudit] = await app.db.db
      .select({ id: auditLog.id, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'file.upload'), eq(auditLog.resourceId, victimFileId)));
    expect(uploadAudit!.actorUserId).toBe(victimUserId);

    const res = await app.app.request(
      '/api/v1/auth/delete-user',
      json({ password: VICTIM.password }, { cookie: victimCookie, 'x-forwarded-for': IPS.victim })
    );
    expect(res.status).toBe(200);

    // Sign-in is gone; the session is gone.
    const relogin = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: VICTIM.email, password: VICTIM.password }, { 'x-forwarded-for': IPS.victim })
    );
    expect(relogin.status).toBe(401);
    expect((await app.app.request('/api/v1/me', { headers: { cookie: victimCookie } })).status).toBe(401);

    // Membership and api_keys rows cascade away; the key stops resolving.
    const memberships = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, victimUserId));
    expect(memberships).toHaveLength(0);
    const keys = await app.db.db.select().from(apiKeys).where(eq(apiKeys.createdBy, victimUserId));
    expect(keys).toHaveLength(0);
    const keyProbe = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${victimKey.key}` }
    });
    expect(keyProbe.status).toBe(401);

    // Their files SURVIVE with created_by nulled (files are workspace data).
    const [fileRow] = await app.db.db.select().from(files).where(eq(files.id, victimFileId));
    expect(fileRow).toBeTruthy();
    expect(fileRow!.createdBy).toBeNull();
    expect(fileRow!.deletedAt).toBeNull();

    // Pre-existing audit rows anonymize; a system-actor completion row lands.
    const [anonymized] = await app.db.db
      .select({ actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.id, uploadAudit!.id));
    expect(anonymized!.actorUserId).toBeNull();
    const completionRows = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.account_delete'), eq(auditLog.resourceId, victimUserId)));
    expect(completionRows).toHaveLength(1);
    expect(completionRows[0]!.actorVia).toBe('system');
    expect(completionRows[0]!.actorUserId).toBeNull();
    expect((completionRows[0]!.metadata as { email: string }).email).toBe(VICTIM.email);
  });
});

describe('admin member deletion (DELETE /members/{id})', () => {
  it('guards: member 403, admin-on-owner 403, self 400, unknown 404, machine 403', async () => {
    // A member-role caller never reaches the handler.
    const memberCall = await app.app.request(`/api/v1/members/${adminMemberId}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie }
    });
    expect(memberCall.status).toBe(403);

    // Only an owner deletes an owner.
    const adminOnOwner = await app.app.request(`/api/v1/members/${ownerMemberId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie }
    });
    expect(adminOnOwner.status).toBe(403);

    // Self-deletion goes through the account page, not the admin surface.
    const self = await app.app.request(`/api/v1/members/${adminMemberId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie }
    });
    expect(self.status).toBe(400);
    expect((await readJson(self)).error.code).toBe('cannot_delete_self');

    // Unknown id.
    const unknown = await app.app.request('/api/v1/members/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { cookie: adminCookie }
    });
    expect(unknown.status).toBe(404);

    // Machines are excluded fail-closed: the endpoint is unlisted in the
    // scope allowlist, whatever the key carries.
    const machine = await app.app.request(`/api/v1/members/${memberMemberId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${exportKey}` }
    });
    expect(machine.status).toBe(403);
    expect((await readJson(machine)).error.code).toBe('endpoint_not_allowed');
  });

  it('enforces the last-owner rule (the guard the ladder shares with self-delete)', async () => {
    // At the wire, guard order makes the admin-surface last_owner rung
    // unreachable without a concurrent role change (an active-owner caller
    // proves another active owner exists, and self-targets 400 first), so
    // the rung is race defense-in-depth. Prove the shared guard directly:
    // the sole owner is not deletable.
    const service = new AccountDeletionService(
      app.db.db,
      new AuditService(app.db.db, app.logger),
      app.logger,
      connectionString
    );
    await expect(service.assertDeletable(ownerUserId)).rejects.toBeInstanceOf(LastOwnerError);
  });

  it('deletes a member: 200 snapshot, cascade, files survive, audited with the admin actor', async () => {
    const victim2Me = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie: victim2Cookie } })
    );
    const victim2UserId = victim2Me.user.id as string;
    const victim2FileId = await upload(victim2Cookie, 'victim2-report.txt', 'uploaded by victim2');
    const victim2Key = await mintKey(victim2Cookie, 'victim2-key', [host.scopes.read]);
    const victim2MemberId = await memberIdOf(VICTIM2.email);

    const res = await app.app.request(`/api/v1/members/${victim2MemberId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie }
    });
    expect(res.status).toBe(200);
    const snapshot = await readJson(res);
    expect(snapshot.id).toBe(victim2MemberId);
    expect(snapshot.userId).toBe(victim2UserId);
    expect(snapshot.email).toBe(VICTIM2.email);

    // Same cascade semantics as self-delete.
    expect(
      await app.db.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, victim2UserId))
    ).toHaveLength(0);
    expect(await app.db.db.select().from(apiKeys).where(eq(apiKeys.createdBy, victim2UserId))).toHaveLength(
      0
    );
    expect(
      (await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${victim2Key.key}` } })).status
    ).toBe(401);
    expect((await app.app.request('/api/v1/me', { headers: { cookie: victim2Cookie } })).status).toBe(401);
    const [fileRow] = await app.db.db.select().from(files).where(eq(files.id, victim2FileId));
    expect(fileRow!.createdBy).toBeNull();

    // Audited with the acting admin as the actor.
    const rows = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.delete'), eq(auditLog.resourceId, victim2MemberId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(adminUserId);
    expect((rows[0]!.metadata as { targetUserId: string }).targetUserId).toBe(victim2UserId);
  });
});

// The files list still tolerates NULL uploader rows (regression sweep for
// the migration-0008 nullability): listed here so the suite pins it.
describe('files list after uploader deletion', () => {
  it('lists workspace files whose creator was deleted', async () => {
    const rows = await app.db.db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), isNull(files.createdBy)));
    expect(rows.length).toBeGreaterThanOrEqual(2); // victim + victim2 uploads

    const res = await app.app.request('/api/v1/files?limit=100', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const nullOwned = body.files.filter((f: { createdBy: string | null }) => f.createdBy === null);
    expect(nullOwned.length).toBeGreaterThanOrEqual(2);
  });
});
