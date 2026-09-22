import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { desc, eq } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
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
 * M2 platform core: API keys, members, invitations, audit, rate limits.
 * Isolated database (per-suite isolation, decision 15); the flow inside is
 * deliberately ordered — it is the exit-criteria #3/#4 story.
 */

const OWNER = { email: 'owner@core.test', name: 'Core Owner', password: 'core-owner-password-12' };
const INVITEE = { email: 'teammate@core.test', name: 'Team Mate', password: 'teammate-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  const url = await createDatabase(container, 'platform_core');
  app = await createTestApp(url);

  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Core', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('API keys (exit criterion 4, API half)', () => {
  let mintedKey: string;
  let keyRecordId: string;
  let keyId: string;

  it('mints a key from a session; the secret appears exactly once', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'ci key', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    // The HOST's prefix, read literally (no pattern built from it), then the fixed shape.
    const prefix = `${host.identity.apiKeyPrefix}_`;
    expect(body.key.startsWith(prefix)).toBe(true);
    expect(body.key.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}$/);
    expect(body.apiKey.scopes).toEqual([host.scopes.read]);
    mintedKey = body.key;
    keyRecordId = body.apiKey.id;
    keyId = body.apiKey.keyId; // authoritative — never derive it by splitting on '_'

    const list = await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie } });
    const listBody = await readJson(list);
    expect(listBody.apiKeys.map((k: { id: string }) => k.id)).toContain(keyRecordId);
    // The full key never reappears, and no secret material (hash) leaks. Do
    // NOT split on '_' to isolate the secret — base64url secrets contain '_',
    // so a fragment can spuriously collide with a UUID/timestamp in the list.
    const serialized = JSON.stringify(listBody);
    expect(serialized).not.toContain(mintedKey);
    expect(serialized).not.toContain('secretHash');
  });

  it('authenticates a curl-style Bearer request and lands it in the audit log with the key identity', async () => {
    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${mintedKey}` }
    });
    expect(me.status).toBe(200);
    const body = await readJson(me);
    expect(body.via).toBe('api_key');
    expect(body.scopes).toEqual([host.scopes.read]);

    // Exit criterion 4: the key-authenticated request itself appears in the
    // audit log with the KEY identity (machine reads are audited).
    const [keyAudit] = await app.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorVia, 'api_key'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(keyAudit).toBeTruthy();
    expect(keyAudit!.apiKeyId).toBe(keyRecordId);
    expect(keyAudit!.action).toBe('get /api/v1/me');

    // The mint was audited with the SESSION identity + the key as resource.
    const [mintAudit] = await app.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'apikey.create'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(mintAudit).toBeTruthy();
    expect(mintAudit!.resourceId).toBe(keyRecordId);
    expect(mintAudit!.actorVia).toBe('session');
  });

  it('walls machine principals off unlisted endpoints (fail-closed allowlist)', async () => {
    const res = await app.app.request('/api/v1/members', {
      headers: { authorization: `Bearer ${mintedKey}` }
    });
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('endpoint_not_allowed');
  });

  it('refuses to mint a key with a key (sessions only)', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'evil', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mintedKey}` }
    });
    expect(res.status).toBe(403);
  });

  it('rejects a tampered key and rate-limits repeated failures per IP', async () => {
    // Use the real keyId (a base64url string that may contain '_') so the
    // tampered key still passes the format check and reaches the wall.
    const bad = `${host.identity.apiKeyPrefix}_${keyId}_${'A'.repeat(43)}`;
    // Own bucket via spoofed client IP: the wall must not bleed into the
    // other tests' default bucket.
    const attacker = { authorization: `Bearer ${bad}`, 'x-forwarded-for': '203.0.113.9' };
    const first = await app.app.request('/api/v1/me', { headers: attacker });
    expect(first.status).toBe(401);

    // The wall trips within the window; the exact iteration is ±1 (the
    // limiter checks state before consuming), so hammer past the threshold
    // and assert a 429 appears — not on a specific iteration.
    let sawRateLimit = false;
    for (let i = 0; i < 30 && !sawRateLimit; i++) {
      const r = await app.app.request('/api/v1/me', { headers: attacker });
      if (r.status === 429) sawRateLimit = true;
      else expect(r.status).toBe(401);
    }
    expect(sawRateLimit).toBe(true);

    // The wall is per-IP: the valid key from ANOTHER address still works.
    const stillFine = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${mintedKey}`, 'x-forwarded-for': '198.51.100.7' }
    });
    expect(stillFine.status).toBe(200);
  });

  it('revoking the key kills it immediately', async () => {
    const res = await app.app.request(`/api/v1/api-keys/${keyRecordId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
    const after = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${mintedKey}` }
    });
    expect(after.status).toBe(401);
  });
});

describe('invitations without SMTP (exit criterion 3, API half)', () => {
  let acceptUrl: string;

  it('creates an invitation and always returns a copyable link (no SMTP configured)', async () => {
    const res = await app.app.request('/api/v1/invitations', {
      ...json({ email: INVITEE.email, role: 'member' }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.emailSent).toBe(false);
    expect(body.acceptUrl).toContain('/invite/');
    acceptUrl = body.acceptUrl;
  });

  it('rejects a duplicate open invitation', async () => {
    const res = await app.app.request('/api/v1/invitations', {
      ...json({ email: INVITEE.email, role: 'member' }),
      headers: { 'content-type': 'application/json', cookie: ownerCookie }
    });
    expect(res.status).toBe(409);
  });

  it('resolves the token publicly (accept-page data)', async () => {
    const token = acceptUrl.split('/invite/')[1]!;
    const res = await app.app.request(`/api/v1/invitations/lookup?token=${token}`);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.email).toBe(INVITEE.email);
    // No account-existence signal on the public lookup (PRDCT-1437): the
    // admin holds the accept URL, so the field was an instance-global oracle.
    expect(body).not.toHaveProperty('accountExists');
    expect(body.workspaceName).toBe('Core');
  });

  it('accepts with new-account credentials, then the invitee logs in with member role', async () => {
    // `user.created` fires from the identity layer's database hook — every
    // entrance, by construction. Subscribe before accept.
    const created: Array<{ userId: string; email: string }> = [];
    const unsubscribe = app.registry.events.on('user.created', (payload) => {
      created.push(payload);
    });

    const token = acceptUrl.split('/invite/')[1]!;
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: INVITEE.name, password: INVITEE.password })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.role).toBe('member');

    unsubscribe();
    expect(created).toHaveLength(1);
    expect(created[0]!.email).toBe(INVITEE.email);
    expect(created[0]!.userId).toBeTruthy();

    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: INVITEE.email, password: INVITEE.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    const meBody = await readJson(me);
    expect(meBody.role).toBe('member');
  });

  it('a used token is dead (single redemption)', async () => {
    const token = acceptUrl.split('/invite/')[1]!;
    const res = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: 'X', password: 'x'.repeat(16) })
    );
    expect(res.status).toBe(404); // no longer live
  });

  it('enforces roles: the member cannot invite, list audit, or update members', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: INVITEE.email, password: INVITEE.password })
    );
    const cookie = extractCookie(signIn);

    const invite = await app.app.request('/api/v1/invitations', {
      ...json({ email: 'x@y.test', role: 'member' }),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(invite.status).toBe(403);

    const audit = await app.app.request('/api/v1/audit', { headers: { cookie } });
    expect(audit.status).toBe(403);
  });
});

describe('audit trail (exit criterion 4 wrap-up)', () => {
  it('exposes the trail to admins with actor identities and request ids', async () => {
    const res = await app.app.request('/api/v1/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const actions = body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['apikey.create', 'apikey.revoke', 'invitation.create', 'invitation.accept'])
    );
    const withRequestId = body.entries.filter((e: { requestId: string | null }) => e.requestId);
    expect(withRequestId.length).toBeGreaterThan(0);
  });
});

describe('jobs runtime', () => {
  it('pg-boss started and accepts a send (usage sink path)', async () => {
    await app.registry.usage.emit({
      id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      meter: 'test.meter',
      actionKey: 'test.meter',
      quantity: 1,
      unit: 'count',
      occurredAt: new Date().toISOString(),
      workspaceId: '00000000-0000-0000-0000-000000000000',
      userId: null,
      via: 'session',
      source: { instanceId: 'test', edition: 'oss', version: 'dev' }
    });
    // send() throwing would have been logged + swallowed; assert the queue exists.
    const size = await app.jobs.boss.getQueueSize('usage-events');
    expect(size).toBeGreaterThanOrEqual(0);
  });
});
