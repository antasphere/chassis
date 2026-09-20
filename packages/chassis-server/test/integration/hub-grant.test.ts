import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { createDatabase, createTestApp, host, startPostgres, type TestApp } from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';
import {
  DEFAULT_GRANT_DIALS,
  HubGrantService,
  LOCK_WATCHDOG_HEADROOM_MS
} from '@antasphere/chassis-server/identity';

/**
 * The per-user hub grant (identity/hub-grant.ts) against the FakeHub's
 * rotating token endpoint — the security-critical mechanics:
 *
 *  - refresh single-flight: N concurrent demands cost ONE token-endpoint
 *    POST (a double-refresh would trip RFC 9700 reuse detection and kill
 *    the whole grant family);
 *  - the advisory-lock re-read: a second "replica" (a second service
 *    instance on the same database) waiting on the lock consumes the
 *    winner's freshly stored access token instead of presenting the
 *    now-rotated-out refresh token;
 *  - the rotation round-trip goes THROUGH the Better-Auth-compatible
 *    encryption: the service decrypts what better-auth's SSO callback
 *    wrote, and what the service writes back is ciphertext better-auth's
 *    own primitive opens;
 *  - the failure taxonomy: invalid_grant → grant DEAD (row tokens nulled;
 *    dead marker = refreshToken IS NULL); invalid_client → transient and
 *    LOUD, the row is never touched; network/5xx → transient;
 *  - reuse detection end-to-end: presenting a rotated-out token kills the
 *    family — every later presentation of ANY of its tokens is dead;
 *  - a browser SSO login re-seeds a dead grant (the account row is
 *    re-written) and the service serves again.
 *
 * The services here are constructed STANDALONE against the booted app's
 * database — deliberately: two instances = two replicas sharing one
 * Postgres, which is exactly the deployment shape the lock protects.
 */

const OWNER = { email: 'owner@grant.test', name: 'Op Grant', password: 'op-grant-password-123' };
const AUTH_SECRET = 'integration-test-secret-0123456789abcdef0123456789abcdef';

const ORG_G = '44444444-aaaa-4bbb-8ccc-000000000001';

const alice: HubUserFixture = {
  sub: 'hub-grant-alice',
  email: 'alice@grant.test',
  workspaceId: ORG_G,
  role: 'member',
  workspaceName: 'Grant Org'
};

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;
let connectionString: string;
let aliceId: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

function makeService(dials: Partial<typeof DEFAULT_GRANT_DIALS> = {}): HubGrantService {
  return new HubGrantService({
    db: app.db.db,
    issuerUrl: hub.issuer,
    clientId: host.hubClientId,
    clientSecret: 'integration-test-hub-secret-0001',
    tokenResource: `${hub.issuer}/mcp`,
    key: async () => AUTH_SECRET,
    connectionString,
    logger: app.logger,
    dials: { ...DEFAULT_GRANT_DIALS, tokenTimeoutMs: 3_000, ...dials }
  });
}

/** The unanswered-presentation record for alice's hub link, or null. */
async function presentationRow(): Promise<{ refresh_token: string } | null> {
  const { rows } = await app.db.pool.query(
    `SELECT p.refresh_token FROM hub_grant_presentations p JOIN account a ON a.id = p.account_id
     WHERE a.provider_id = 'antasphere' AND a.user_id = $1`,
    [aliceId]
  );
  return (rows[0] as { refresh_token: string } | undefined) ?? null;
}

async function grantRow(): Promise<{ access_token: string | null; refresh_token: string | null }> {
  const { rows } = await app.db.pool.query(
    `SELECT a.access_token, a.refresh_token FROM account a JOIN "user" u ON u.id = a.user_id
     WHERE u.email = $1 AND a.provider_id = 'antasphere'`,
    [alice.email]
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Expire the stored access token so the next demand takes the refresh path. */
async function staleStoredAccess(): Promise<void> {
  await app.db.pool.query(
    `UPDATE account SET access_token_expires_at = now()
     WHERE provider_id = 'antasphere' AND user_id = $1`,
    [aliceId]
  );
}

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  connectionString = await createDatabase(container, 'hub_grant');
  app = await createTestApp(connectionString, {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
  });
  const res = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Grant', owner: OWNER })
  );
  expect(res.status).toBe(201);
  // A real browser SSO login writes the grant onto the account row — the
  // exact rows (and ciphertext) production sees.
  await sso.ssoLogin(app, hub, alice);
  const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [alice.email]);
  aliceId = rows[0].id as string;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('reading the grant better-auth wrote', () => {
  it('serves the login-stored access token (decrypted) without any refresh', async () => {
    const service = makeService();
    const before = hub.refreshCount();
    const access = await service.accessToken(aliceId);
    expect(access.kind).toBe('ok');
    if (access.kind !== 'ok') return;
    // A real JWT the hub minted — decrypted from the row's ciphertext.
    expect(access.accessToken.split('.')).toHaveLength(3);
    expect(hub.refreshCount()).toBe(before); // no refresh needed
  });

  it('a user with no hub identity answers no_link', async () => {
    const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [OWNER.email]);
    const service = makeService();
    expect(await service.accessToken(rows[0].id as string)).toEqual({ kind: 'no_link' });
  });

  it('prime() serves the login token from memory (zero row reads needed to prove: zero refreshes)', async () => {
    const service = makeService();
    const before = hub.refreshCount();
    service.prime(aliceId, 'primed-token', new Date(Date.now() + 10 * 60_000));
    expect(await service.accessToken(aliceId)).toEqual({ kind: 'ok', accessToken: 'primed-token' });
    expect(hub.refreshCount()).toBe(before);
  });
});

describe('rotation: single-flight, advisory-lock re-read, encrypted write-back', () => {
  it('N concurrent demands on a stale token cost exactly ONE refresh POST', async () => {
    await staleStoredAccess();
    const service = makeService();
    hub.tokenDelayMs = 150; // hold the refresh so all racers pile up
    let results: Awaited<ReturnType<HubGrantService['accessToken']>>[];
    const before = hub.refreshCount();
    try {
      results = await Promise.all(Array.from({ length: 8 }, () => service.accessToken(aliceId)));
    } finally {
      hub.tokenDelayMs = 0;
    }
    expect(hub.refreshCount()).toBe(before + 1);
    const tokens = new Set(results.map((r) => (r.kind === 'ok' ? r.accessToken : r.kind)));
    expect(tokens.size).toBe(1); // everyone got the same fresh token
  });

  it('the rotation wrote back THROUGH the encryption: new ciphertext, decryptable, raw rt inside', async () => {
    const row = await grantRow();
    expect(row.refresh_token).toBeTruthy();
    // Never the raw secret at rest…
    expect(row.refresh_token!).not.toMatch(/^rt_/);
    // …but the raw secret under Better Auth's own primitive + key.
    const raw = await symmetricDecrypt({ key: AUTH_SECRET, data: row.refresh_token! });
    expect(raw).toMatch(/^rt_/);
    // And the access token round-trips the same way.
    const rawAccess = await symmetricDecrypt({ key: AUTH_SECRET, data: row.access_token! });
    expect(rawAccess.split('.')).toHaveLength(3);
  });

  it('a second replica waiting on the lock consumes the winner’s token — never a second rotation', async () => {
    await staleStoredAccess();
    const replicaA = makeService();
    const replicaB = makeService();
    hub.tokenDelayMs = 250;
    const before = hub.refreshCount();
    let a: Awaited<ReturnType<HubGrantService['accessToken']>>;
    let b: Awaited<ReturnType<HubGrantService['accessToken']>>;
    try {
      [a, b] = await Promise.all([replicaA.accessToken(aliceId), replicaB.accessToken(aliceId)]);
    } finally {
      hub.tokenDelayMs = 0;
    }
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    // ONE refresh total: the loser re-read the row after the lock and found
    // the winner's fresh access token. A second POST here would present the
    // rotated-out refresh token — the family-killing event.
    expect(hub.refreshCount()).toBe(before + 1);
  });

  it('presenting a rotated-out refresh token trips reuse detection and kills the FAMILY', async () => {
    // Capture the current ciphertext, rotate once (making it stale), then
    // put the stale ciphertext back — the split-brain/restored-backup shape
    // the advisory lock cannot cover.
    const staleRow = await grantRow();
    const service = makeService();
    await staleStoredAccess();
    const rotated = await service.refresh(aliceId);
    expect(rotated.kind).toBe('ok');
    const freshRow = await grantRow();
    expect(freshRow.refresh_token).not.toBe(staleRow.refresh_token);

    // The stale replica presents the rotated-out token…
    await app.db.pool.query(
      `UPDATE account SET refresh_token = $1, access_token_expires_at = now()
       WHERE provider_id = 'antasphere' AND user_id = $2`,
      [staleRow.refresh_token, aliceId]
    );
    const staleReplica = makeService();
    expect(await staleReplica.refresh(aliceId)).toEqual({ kind: 'grant_dead' });
    // …the row is dead-marked (refreshToken IS NULL)…
    const deadRow = await grantRow();
    expect(deadRow.refresh_token).toBeNull();
    expect(deadRow.access_token).toBeNull();

    // …and the WHOLE family died hub-side: even the freshest token is now
    // refused (restore it and try).
    await app.db.pool.query(
      `UPDATE account SET refresh_token = $1 WHERE provider_id = 'antasphere' AND user_id = $2`,
      [freshRow.refresh_token, aliceId]
    );
    expect(await makeService().refresh(aliceId)).toEqual({ kind: 'grant_dead' });
  });

  it('a browser SSO login re-seeds the dead grant and the service serves again', async () => {
    // (The family was killed above.) The login self-heals: better-auth
    // re-writes both tokens on the SAME account row.
    expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'grant_dead' });
    await sso.ssoLogin(app, hub, alice);
    const row = await grantRow();
    expect(row.refresh_token).toBeTruthy();
    const access = await makeService().accessToken(aliceId);
    expect(access.kind).toBe('ok');
  });
});

describe('the failure taxonomy', () => {
  it('invalid_client is TRANSIENT and loud — a misconfiguration never kills grants', async () => {
    await staleStoredAccess();
    const before = await grantRow();
    hub.tokenMode = 'invalid_client';
    try {
      expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    const after = await grantRow();
    expect(after.refresh_token).toBe(before.refresh_token); // untouched
  });

  it('network failures and 5xx are transient — nothing destroyed, recovery is immediate', async () => {
    await staleStoredAccess();
    hub.tokenMode = 'network';
    try {
      expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    hub.tokenMode = 'http500';
    try {
      expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    const recovered = await makeService().accessToken(aliceId);
    expect(recovered.kind).toBe('ok');
  });

  it('invalid_grant is DEFINITIVE: tokens nulled, callers get grant_dead until a re-login', async () => {
    await staleStoredAccess();
    hub.tokenMode = 'invalid_grant';
    try {
      expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'grant_dead' });
    } finally {
      hub.tokenMode = 'ok';
    }
    const row = await grantRow();
    expect(row.refresh_token).toBeNull();
    expect(row.access_token).toBeNull();
    // Dead marker read, no hub round-trip needed.
    const before = hub.refreshCount();
    expect(await makeService().accessToken(aliceId)).toEqual({ kind: 'grant_dead' });
    expect(hub.refreshCount()).toBe(before);
    // Heal for any later suites.
    await sso.ssoLogin(app, hub, alice);
  });

  it('a legacy PLAINTEXT refresh token still works (decrypt passes it through) and rotates into ciphertext', async () => {
    // Simulate a pre-encryption row: store the raw refresh token plaintext.
    const row = await grantRow();
    const raw = await symmetricDecrypt({ key: AUTH_SECRET, data: row.refresh_token! });
    await app.db.pool.query(
      `UPDATE account SET refresh_token = $1, access_token_expires_at = now()
       WHERE provider_id = 'antasphere' AND user_id = $2`,
      [raw, aliceId]
    );
    const access = await makeService().accessToken(aliceId);
    expect(access.kind).toBe('ok');
    // The write-back upgraded the row to ciphertext.
    const upgraded = await grantRow();
    expect(upgraded.refresh_token).not.toMatch(/^rt_/);
    await expect(symmetricDecrypt({ key: AUTH_SECRET, data: upgraded.refresh_token! })).resolves.toMatch(
      /^rt_/
    );
    // Sanity: our encrypt primitive matches better-auth's (same key path).
    const cipher = await symmetricEncrypt({ key: AUTH_SECRET, data: 'probe' });
    await expect(symmetricDecrypt({ key: AUTH_SECRET, data: cipher })).resolves.toBe('probe');
  });
});

describe('ambiguous outcomes: the presentation record + the RFC 7662 probe (PRDCT-1370)', () => {
  // Short timeouts: these cases wait for the client-side abort on purpose.
  const FAST = { tokenTimeoutMs: 400, introspectTimeoutMs: 400 };

  it('a timeout AFTER the hub rotated: the next demand probes, marks the grant dead, and never presents the rotated-out token — the family survives', async () => {
    await staleStoredAccess();
    const before = await grantRow();
    const presentations = hub.refreshCount();
    const probes = hub.introspectRequests.length;

    hub.tokenMode = 'commit_then_hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    // The hub consumed the token (one presentation) and the record survived
    // the transient outcome, naming the exact ciphertext presented.
    expect(hub.refreshCount()).toBe(presentations + 1);
    expect((await presentationRow())?.refresh_token).toBe(before.refresh_token);
    expect((await grantRow()).refresh_token).toBe(before.refresh_token); // untouched

    // Second demand: a probe, NOT a presentation.
    expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'grant_dead' });
    expect(hub.refreshCount()).toBe(presentations + 1);
    expect(hub.introspectRequests.length).toBe(probes + 1);
    expect(hub.introspectRequests.at(-1)?.hint).toBe('refresh_token');
    // The family was NOT torn down — the whole point (the CLI grant shares it).
    expect(hub.isFamilyDead(alice.sub)).toBe(false);
    // Dead-marked locally, record cleared.
    const dead = await grantRow();
    expect(dead.refresh_token).toBeNull();
    expect(await presentationRow()).toBeNull();
    // A browser login heals.
    await sso.ssoLogin(app, hub, alice);
    expect((await makeService().accessToken(aliceId)).kind).toBe('ok');
  });

  it('a timeout BEFORE the hub consumed the token: the probe says active and the next demand presents again — nothing destroyed', async () => {
    await staleStoredAccess();
    const before = await grantRow();
    const probes = hub.introspectRequests.length;
    hub.tokenMode = 'hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    expect((await presentationRow())?.refresh_token).toBe(before.refresh_token);

    const access = await makeService(FAST).accessToken(aliceId);
    expect(access.kind).toBe('ok');
    expect(hub.introspectRequests.length).toBe(probes + 1);
    expect((await grantRow()).refresh_token).not.toBe(before.refresh_token); // rotated
    expect(await presentationRow()).toBeNull();
  });

  it('a confirmed refresh clears the record: ordinary refreshes never probe', async () => {
    await staleStoredAccess();
    const probes = hub.introspectRequests.length;
    expect((await makeService().accessToken(aliceId)).kind).toBe('ok');
    expect(await presentationRow()).toBeNull();
    expect(hub.introspectRequests.length).toBe(probes);
  });

  it('the probe failing is transient — nothing destroyed, the record survives, recovery is immediate', async () => {
    await staleStoredAccess();
    const before = await grantRow();
    hub.tokenMode = 'hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    for (const mode of ['network', 'http500'] as const) {
      hub.introspectMode = mode;
      try {
        expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
      } finally {
        hub.introspectMode = 'ok';
      }
      expect((await grantRow()).refresh_token).toBe(before.refresh_token);
      expect((await presentationRow())?.refresh_token).toBe(before.refresh_token);
    }
    expect((await makeService(FAST).accessToken(aliceId)).kind).toBe('ok');
    expect(await presentationRow()).toBeNull();
  });

  it('a browser re-login makes a stale record inert by construction (different ciphertext): no probe', async () => {
    await staleStoredAccess();
    const probes = hub.introspectRequests.length;
    hub.tokenMode = 'hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    expect(await presentationRow()).not.toBeNull();
    await sso.ssoLogin(app, hub, alice); // re-seeds the row: new ciphertext
    await staleStoredAccess();
    expect((await makeService(FAST).accessToken(aliceId)).kind).toBe('ok');
    expect(hub.introspectRequests.length).toBe(probes);
    expect(await presentationRow()).toBeNull();
  });

  it('a probe answered 401 or a 200 without a boolean `active` is inconclusive — a probe is never the reason a grant dies', async () => {
    await staleStoredAccess();
    const before = await grantRow();
    hub.tokenMode = 'hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    for (const mode of ['invalid_client', 'malformed'] as const) {
      hub.introspectMode = mode;
      try {
        expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
      } finally {
        hub.introspectMode = 'ok';
      }
      expect((await grantRow()).refresh_token).toBe(before.refresh_token);
      expect((await presentationRow())?.refresh_token).toBe(before.refresh_token);
    }
    expect((await makeService(FAST).accessToken(aliceId)).kind).toBe('ok');
  });

  it('the lock watchdog outlives probe + presentation: a sibling replica never presents the same token', async () => {
    // The verifier's reproduction (PRDCT-1370): a short watchdog, a slow
    // probe and a slow presentation. Without the clamp the watchdog cut the
    // lock mid-refresh and replica B presented the token a second time —
    // reuse detection, family dead. With it, exactly one presentation.
    await staleStoredAccess();
    hub.tokenMode = 'hang';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    const presentations = hub.refreshCount();
    const dials = { tokenTimeoutMs: 3_000, introspectTimeoutMs: 3_000, lockWatchdogMs: 600 };
    const a = makeService(dials);
    const b = makeService(dials);
    expect(a.dials.lockWatchdogMs).toBe(3_000 + 3_000 + LOCK_WATCHDOG_HEADROOM_MS);
    hub.introspectDelayMs = 400;
    hub.tokenDelayMs = 500;
    try {
      const first = a.accessToken(aliceId);
      await new Promise((r) => setTimeout(r, 100));
      const second = b.accessToken(aliceId);
      const [ra, rb] = await Promise.all([first, second]);
      expect(ra.kind).toBe('ok');
      expect(rb.kind).toBe('ok');
    } finally {
      hub.introspectDelayMs = 0;
      hub.tokenDelayMs = 0;
    }
    expect(hub.refreshCount()).toBe(presentations + 1);
    expect(hub.isFamilyDead(alice.sub)).toBe(false);
  });

  it('invalid_client clears the record — the hub refused the client before consuming the token', async () => {
    await staleStoredAccess();
    hub.tokenMode = 'invalid_client';
    try {
      expect(await makeService(FAST).accessToken(aliceId)).toEqual({ kind: 'inconclusive' });
    } finally {
      hub.tokenMode = 'ok';
    }
    expect(await presentationRow()).toBeNull();
    expect((await makeService(FAST).accessToken(aliceId)).kind).toBe('ok');
  });
});
