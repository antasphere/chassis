import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { UsageEvent } from '@antasphere/chassis-contract';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The billing rail's phase 1 on the chassis (PRDCT-2626), end to end on the
 * host's one metered route, the generic files upload, against the stub hub
 * that speaks lane A's wire contract (PRDCT-2625):
 *
 *  - oss: discovery shows the declared slot with the operator's cap as the
 *    oss and free values; an upload under the cap answers as before; one
 *    over the declared size answers 413 entitlement_denied with today's
 *    message, byte for byte; no event leaves the instance (the downstream
 *    is asked nothing).
 *  - cloud: the operator's cloud-local workspace is unmetered; a hub user's
 *    upload lands in the hub's usage_events per user and per organization,
 *    with the hub user's sub, the via of each credential, the file it
 *    created, and the machine token minted once for the whole run; a plan
 *    refusal answers 403 plan_required with the upgrade link and posts
 *    nothing; a 404 from an older hub is retried until it lands, never
 *    lost; a dead machine token is minted again once.
 *  - cloud, phase 2 (PRDCT-2664): a priced action is checked at the hub
 *    with the machine token and debited at ingest; a short balance is 402
 *    entitlement_denied with the hub's top-up link and posts nothing; the
 *    plan limit, not the instance cap, is a metered account's ceiling
 *    (PRDCT-2653) and its refusal links the hub's upgrade page with the key
 *    and the required plan; an upload with no declared size is 411
 *    (PRDCT-2652); a hub that does not answer the check fails open, on
 *    /metrics.
 *
 * The suite runs twice (the minimal host, then the Slideless composition):
 * what the two declare differently (the free upload value) is read from
 * discovery, never assumed.
 */

const OWNER = { email: 'owner@ent.test', name: 'Ent Owner', password: 'ent-owner-password-1' };
const OPERATOR = { email: 'operator@ent.test', name: 'Operator', password: 'operator-ent-pass-1' };
const ORG_A = '77777777-aaaa-4bbb-8ccc-00000000e001';
const ORG_B = '77777777-aaaa-4bbb-8ccc-00000000e002';
const HUB_SECRET = 'integration-test-hub-secret-ent';
const PAYLOAD = 'The quick brown fox jumps over the lazy dog'; // 43 bytes
const MB = 1024 * 1024;

let container: StartedPostgreSqlContainer;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp(), ...headers },
  body: JSON.stringify(body)
});

/** An upload as a client sends it on the wire: the bytes with their Content-Length (a header passed in wins). */
function upload(app: TestApp, headers: Record<string, string>, text: string) {
  return app.app.request(`/api/v1/files?name=${encodeURIComponent('fox.txt')}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'content-length': String(Buffer.byteLength(text)),
      'x-forwarded-for': sso.nextIp(),
      ...headers
    },
    body: text
  });
}

const landed = (hub: FakeHub, fileId: string) =>
  [...hub.usageEvents.values()].some((e) => e.resourceId === fileId);

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('oss: unmetered by construction, the cap byte for byte', () => {
  let app: TestApp;
  let cookie: string;
  const downstream: UsageEvent[] = [];

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'ent_oss'),
      { MAX_FILE_SIZE_MB: '1' },
      { usageDownstream: { emit: async (e) => void downstream.push(e) } }
    );
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Ent', owner: OWNER })
    );
    cookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('discovery shows the declared slot: the upload action, the cap as the oss and pro values, the free value at or below it', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.entitlements.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'files.upload', unit: 'bytes' })])
    );
    // What discovery advertises is what the instance serves (PRDCT-2653):
    // the paid tier's value is the operator's cap, like the oss value.
    expect(info.entitlements.limits['files.maxBytes']).toMatchObject({ oss: MB, pro: MB });
    // The minimal host declares free as a fifth of the cap; Slideless as
    // 100 MB or the cap when smaller (the cap, at 1 MiB).
    expect([Math.floor(MB / 5), MB]).toContain(info.entitlements.limits['files.maxBytes'].free);
  });

  it('an upload under the cap answers 201 and no event leaves the instance', async () => {
    const res = await upload(app, { cookie }, PAYLOAD);
    expect(res.status).toBe(201);
    expect((await readJson(res)).file.sizeBytes).toBe(43);
    await new Promise((r) => setTimeout(r, 2_500)); // longer than the queue's poll
    expect(downstream).toEqual([]);
  });

  it('an upload over the declared size answers 413 entitlement_denied with today’s message', async () => {
    const res = upload(app, { cookie, 'content-length': String(MB + 1) }, 'x'.repeat(MB + 1));
    const out = await res;
    expect(out.status).toBe(413);
    expect(await readJson(out)).toEqual({
      error: { code: 'entitlement_denied', message: 'file exceeds MAX_FILE_SIZE_MB (1MB)' }
    });
  });
});

describe('cloud: every metered action of a hub organization lands in the hub', () => {
  let hub: FakeHub;
  let app: TestApp;
  let operatorCookie: string;
  let hubUserCookie: string;
  let hubUserId: string;
  let projectedWorkspaceId: string;
  let projectedKey: string;
  const METRICS_TOKEN = 'integration-metrics-token-ent';

  const metric = async (name: string): Promise<number> => {
    const res = await app.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    const line = (await res.text())
      .split('\n')
      .find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
    return line ? Number(line.split(' ').at(-1)) : 0;
  };

  const hubUser: HubUserFixture = {
    sub: 'hub-user-ent',
    email: 'hub-user@ent.test',
    name: 'Hub User',
    workspaceId: ORG_A,
    role: 'owner',
    workspaceName: 'Org A'
  };
  const hubUserB: HubUserFixture = {
    sub: 'hub-user-ent-b',
    email: 'hub-user-b@ent.test',
    name: 'Hub User B',
    workspaceId: ORG_B,
    role: 'owner',
    workspaceName: 'Org B'
  };

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET });
    app = await createTestApp(
      await createDatabase(container, 'ent_cloud'),
      {
        EDITION: 'cloud',
        HUB_ISSUER_URL: hub.issuer,
        HUB_CLIENT_ID: host.hubClientId,
        HUB_CLIENT_SECRET: HUB_SECRET,
        MAX_FILE_SIZE_MB: '1',
        METRICS_TOKEN
      },
      {
        usageRetry: { limit: 4, delaySeconds: 1 },
        entitlementDials: { ttlMs: 60_000 },
        // Every metered request asks the hub's check (no reuse), so each
        // test below sees its own check at the fake.
        // No cache and no hold after a failed call: every upload reaches the
        // fake's check, and the outage case heals on the very next request.
        entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0, outageHoldMs: 0 }
      }
    );
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Ent Cloud', owner: OPERATOR })
    );
    await sso.seedLocalWorkspace(app, 'Ent Cloud', OPERATOR.email);
    operatorCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OPERATOR.email, password: OPERATOR.password })
      )
    );
    hubUserCookie = await sso.ssoLogin(app, hub, hubUser);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: hubUserCookie } }));
    projectedWorkspaceId = me.activeWorkspaceId;
    hubUserId = me.user.id;
    expect(me.workspace.hubOrigin).toBe(true);
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json(
          {
            name: 'ent-key',
            scopes: [host.scopes.read, host.scopes.write],
            workspaceId: projectedWorkspaceId
          },
          { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId }
        )
      )
    );
    projectedKey = minted.key;
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    await hub?.stop();
  });

  it('the operator’s cloud-local workspace is unmetered: no hub read, no event', async () => {
    const res = await upload(app, { cookie: operatorCookie }, PAYLOAD);
    expect(res.status).toBe(201);
    expect(hub.entitlementsRequests).toEqual([]);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageEvents.size).toBe(0);
    expect(hub.usageRequests).toEqual([]);
  });

  it('a hub user’s upload lands in the hub: the hub sub, via session, the file it created, one machine token', async () => {
    const res = await upload(app, { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId }, PAYLOAD);
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    await until(
      () => hub.usageEvents.size,
      (n) => n >= 1
    );
    expect(hub.usageEvents.size).toBe(1);
    const [event] = [...hub.usageEvents.values()];
    expect(event).toMatchObject({
      actionKey: 'files.upload',
      meter: 'files.upload',
      quantity: 43,
      unit: 'bytes',
      workspaceId: projectedWorkspaceId,
      accountRef: ORG_A,
      userId: hubUser.sub,
      via: 'session',
      resourceType: 'file',
      resourceId: fileId,
      // The hub records the token's registry slug; the body never named the tool (PRDCT-2629).
      toolSlug: hub.toolSlug,
      source: { edition: 'cloud' }
    });
    expect(hub.toolSlug).not.toBe(host.identity.slug);
    const posted = (hub.usageRequests[0]!.body as { events: Array<Record<string, unknown>> }).events;
    expect(posted.every((e) => !('toolSlug' in e))).toBe(true);
    expect(event!.userId).not.toBe(hubUserId); // the hub's sub, never the tool's local id
    // The machine channel: one client_credentials token, minted once, on every hub call.
    expect(hub.machineTokenMints).toBe(1);
    expect(hub.usageRequests[0]!.auth).toMatch(/^Bearer mach_/);
    expect(hub.entitlementsRequests).toEqual([
      { accountRef: ORG_A, auth: expect.stringMatching(/^Bearer mach_/) }
    ]);
  });

  it('the same action through an API key reports via api_key, and the plan is read once per TTL', async () => {
    const res = await upload(app, { authorization: `Bearer ${projectedKey}` }, PAYLOAD + '!');
    expect(res.status).toBe(201);
    await until(
      () => hub.usageEvents.size,
      (n) => n >= 2
    );
    const events = [...hub.usageEvents.values()];
    expect(events.map((e) => e.via).sort()).toEqual(['api_key', 'session']);
    expect(events.every((e) => e.userId === hubUser.sub && e.accountRef === ORG_A)).toBe(true);
    expect(hub.entitlementsRequests).toHaveLength(1);
    expect(hub.machineTokenMints).toBe(1);
  });

  it('a plan refusal answers 403 plan_required with the upgrade link, the hub’s organization page, and posts nothing', async () => {
    hub.setEntitlements(ORG_B, { plan: 'free', limits: { 'files.maxBytes': 10 } });
    const cookieB = await sso.ssoLogin(app, hub, hubUserB);
    const meB = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: cookieB } }));
    const before = hub.usageRequests.length;
    const res = await upload(app, { cookie: cookieB, 'x-workspace-id': meB.activeWorkspaceId }, PAYLOAD);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    // The hub's upgrade page for the organization, the key and the required plan appended.
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: `${hub.issuer}/billing/upgrade?org=${ORG_B}&tool=${hub.toolSlug}&plan=free&key=files.maxBytes&requiredPlan=pro`
    });
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageRequests).toHaveLength(before);
    expect(hub.usageEvents.size).toBe(2);
  });

  it('an older hub (404) is retried until the ingest exists; nothing is lost', async () => {
    hub.usageMode = 'http404';
    const posts = hub.usageRequests.length;
    const res = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId },
      PAYLOAD + '??'
    );
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    await until(
      () => hub.usageRequests.length,
      (n) => n > posts
    );
    expect(hub.usageEvents.size).toBe(2);
    hub.usageMode = 'ok';
    await until(
      () => landed(hub, fileId),
      (ok) => ok,
      30_000
    );
    const event = [...hub.usageEvents.values()].find((e) => e.resourceId === fileId);
    expect(event).toMatchObject({ actionKey: 'files.upload', quantity: 45 });
  }, 60_000);

  it('a dead machine token is minted again once and the batch lands', async () => {
    hub.usageMode = 'http401_once';
    const mints = hub.machineTokenMints;
    const res = await upload(app, { authorization: `Bearer ${projectedKey}` }, PAYLOAD + '???');
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    await until(
      () => landed(hub, fileId),
      (ok) => ok,
      30_000
    );
    const seen = hub.usageRequests.map((r) => ({
      auth: r.auth?.slice(0, 12),
      files: (r.body as { events?: Array<{ resourceId?: string }> } | null)?.events?.map((e) => e.resourceId)
    }));
    expect(landed(hub, fileId), JSON.stringify({ fileId, seen, mints: hub.machineTokenMints })).toBe(true);
    expect(hub.machineTokenMints).toBe(mints + 1);
  }, 60_000);

  it('the fake hub judges a body as the real hub does (PRDCT-2629): a stamped slug is tool_mismatch, a non-uuid account is invalid_event, a long unit is invalid_event', async () => {
    const mint = await fetch(`${hub.issuer}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${host.hubClientId}:${HUB_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'usage:write',
        resource: hub.apiResource
      })
    });
    const { access_token } = (await mint.json()) as { access_token: string };
    const base = [...hub.usageEvents.values()][0]!;
    const post = async (events: unknown[]) => {
      const res = await fetch(`${hub.issuer}/api/v1/usage/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
        body: JSON.stringify({ events })
      });
      expect(res.status).toBe(200);
      return (
        (await res.json()) as { results: Array<{ id: string | null; status: string; reason?: string }> }
      ).results;
    };
    // The registry slug is the client id without its prefix — under either host.
    expect(hub.toolSlug).toBe(host.hubClientId.replace(/^tool-/, ''));
    const [stamped, own, notUuid, longUnit] = await post([
      { ...base, id: '01JZZZZZZZZZZZZZZZZZZZZZZ1', toolSlug: 'not-the-registry-slug' },
      { ...base, id: '01JZZZZZZZZZZZZZZZZZZZZZZ2', toolSlug: hub.toolSlug },
      { ...base, id: '01JZZZZZZZZZZZZZZZZZZZZZZ3', accountRef: 'acct-1' },
      { ...base, id: '01JZZZZZZZZZZZZZZZZZZZZZZ4', unit: 'x'.repeat(41) }
    ]);
    expect(stamped).toMatchObject({ status: 'rejected', reason: 'tool_mismatch' });
    expect(own).toMatchObject({ status: 'accepted' });
    expect(notUuid).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
    expect(longUnit).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
    // And the plan read of a non-uuid account is 400, as the real hub's query validator answers.
    const bad = await fetch(`${hub.issuer}/api/v1/usage/entitlements?accountRef=acct-1`, {
      headers: { authorization: `Bearer ${access_token}` }
    });
    expect(bad.status).toBe(400);
  });

  it('the upload over the operator’s cap on a free cloud account meets the plan refusal, not the cap’s 413', async () => {
    // The free value is at or below the cap (1 MiB here): the limit refuses
    // first, as the spec orders — with the plan refusal and its upgrade link.
    const res = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId, 'content-length': String(MB + 1) },
      'x'.repeat(MB + 1)
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('plan_required');
  });

  it('a priced action is checked at the hub with the machine token, and debited at ingest by the event’s credits', async () => {
    hub.setPrice('files.upload', { creditsPerUnit: 5, unit: 'bytes', per: 1048576 });
    const balance = hub.balanceOf(ORG_A);
    const checks = hub.checkRequests.length;
    const res = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId },
      PAYLOAD + '#'
    );
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    expect(hub.checkRequests).toHaveLength(checks + 1);
    expect(hub.checkRequests.at(-1)).toEqual({
      auth: expect.stringMatching(/^Bearer mach_/),
      body: { accountRef: ORG_A, actionKey: 'files.upload', quantity: 44, unit: 'bytes' }
    });
    await until(
      () => landed(hub, fileId),
      (ok) => ok,
      30_000
    );
    const [eventId] = [...hub.usageEvents.entries()].find(([, e]) => e.resourceId === fileId)!;
    // 44 bytes at 5 credits per MiB, rounded up to the MiB: 5 credits.
    expect(hub.balanceOf(ORG_A)).toBe(balance - 5);
    const debits = hub.ledger.filter((l) => l.kind === 'debit');
    expect(debits).toEqual([{ accountRef: ORG_A, kind: 'debit', amount: -5, sourceRef: eventId }]);
  }, 60_000);

  it('a balance below the price is 402 entitlement_denied with the hub’s top-up link, and nothing is posted', async () => {
    hub.setBalance(ORG_A, 2);
    const posts = hub.usageRequests.length;
    const res = await upload(app, { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId }, PAYLOAD);
    expect(res.status).toBe(402);
    const body = await readJson(res);
    expect(body.error.code).toBe('entitlement_denied');
    expect(body.error.details).toEqual({
      credits: 5,
      balance: 2,
      topUpUrl: `${hub.issuer}/billing/top-up?org=${ORG_A}&credits=5&balance=2&tool=${hub.toolSlug}&action=files.upload`
    });
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageRequests).toHaveLength(posts);
    expect(hub.balanceOf(ORG_A)).toBe(2);
    hub.setBalance(ORG_A, 5_000);
  });

  it('the plan limit is a metered account’s ceiling (PRDCT-2653): pro uploads above the free value, free meets plan_required with the hub’s upgrade page', async (ctx) => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    const { free, pro } = info.entitlements.limits['files.maxBytes'] as { free: number; pro: number };
    // A host whose free value IS the cap at this size (Slideless at 1 MiB)
    // has no size between the two to upload: its own metering suite pins it.
    if (!(free < pro)) return ctx.skip();
    const size = free + Math.floor((pro - free) / 2);
    const ORG_PRO = '77777777-aaaa-4bbb-8ccc-00000000e004';
    hub.setEntitlements(ORG_PRO, { plan: 'pro' });
    const proCookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-user-ent-pro',
      email: 'hub-user-pro@ent.test',
      name: 'Hub User Pro',
      workspaceId: ORG_PRO,
      role: 'owner',
      workspaceName: 'Org Pro'
    });
    const mePro = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: proCookie } }));
    const ok = await upload(
      app,
      { cookie: proCookie, 'x-workspace-id': mePro.activeWorkspaceId },
      'p'.repeat(size)
    );
    expect(ok.status).toBe(201);
    // Its event lands before the next test counts the posts.
    const proFileId = (await readJson(ok)).file.id as string;
    await until(
      () => landed(hub, proFileId),
      (landedYet) => landedYet,
      30_000
    );
    const refused = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId },
      'f'.repeat(size)
    );
    expect(refused.status).toBe(403);
    const body = await readJson(refused);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details.upgradeUrl.startsWith(`${hub.issuer}/billing/upgrade?`)).toBe(true);
    expect(body.error.details.upgradeUrl).toContain('key=files.maxBytes&requiredPlan=pro');
  }, 60_000);

  it('a metered upload that declares no size is 411 length_required: no file, no check, no event (PRDCT-2652)', async () => {
    const headers = { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId };
    const count = async () =>
      ((await readJson(await app.app.request('/api/v1/files', { headers }))).files as unknown[]).length;
    const files = await count();
    const checks = hub.checkRequests.length;
    const posts = hub.usageRequests.length;
    const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent('silent.txt')}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', 'x-forwarded-for': sso.nextIp() },
      body: PAYLOAD
    });
    expect(res.status).toBe(411);
    expect((await readJson(res)).error.code).toBe('length_required');
    expect(await count()).toBe(files);
    expect(hub.checkRequests).toHaveLength(checks);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageRequests).toHaveLength(posts);
  });

  it('a hub that does not answer the check fails open, on /metrics; its return clears the posture', async () => {
    hub.checkMode = 'network';
    const down = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId },
      PAYLOAD + '%'
    );
    expect(down.status).toBe(201);
    expect(await metric('usage_check_posture')).toBe(1);
    expect(await metric('usage_check_total{outcome="fail_open"}')).toBeGreaterThanOrEqual(1);
    hub.checkMode = 'ok';
    const up = await upload(
      app,
      { cookie: hubUserCookie, 'x-workspace-id': projectedWorkspaceId },
      PAYLOAD + '%%'
    );
    expect(up.status).toBe(201);
    expect(await metric('usage_check_posture')).toBe(0);
    expect(await metric('usage_check_failing_since_seconds')).toBe(0);
  });
});

describe('cloud: the retry budget’s end is a hold, never a loss (PRDCT-2635)', () => {
  let hub: FakeHub;
  let app: TestApp;
  let cookie: string;
  let workspaceId: string;
  const METRICS_TOKEN = 'integration-metrics-token-1';
  const ORG_HELD = '77777777-aaaa-4bbb-8ccc-00000000e003';

  const metric = async (name: string): Promise<number> => {
    const res = await app.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    const line = (await res.text())
      .split('\n')
      .find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
    return line ? Number(line.split(' ').at(-1)) : 0;
  };

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: host.hubClientId, clientSecret: HUB_SECRET });
    app = await createTestApp(
      await createDatabase(container, 'ent_held'),
      {
        EDITION: 'cloud',
        HUB_ISSUER_URL: hub.issuer,
        HUB_CLIENT_ID: host.hubClientId,
        HUB_CLIENT_SECRET: HUB_SECRET,
        METRICS_TOKEN
      },
      // One retry a second later, then held; a held event comes back a second after.
      { usageRetry: { limit: 1, delaySeconds: 1, heldDelaySeconds: 1 }, entitlementDials: { ttlMs: 60_000 } }
    );
    await app.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Ent Held', owner: OPERATOR })
    );
    cookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-user-held',
      email: 'held@ent.test',
      name: 'Held User',
      workspaceId: ORG_HELD,
      role: 'owner',
      workspaceName: 'Org Held'
    });
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    workspaceId = me.activeWorkspaceId;
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    await hub?.stop();
  });

  it('an outage that outlasts the budget holds the event, counts it on /metrics, and re-drives it until the hub takes it', async () => {
    hub.usageMode = 'network';
    const res = await upload(app, { cookie, 'x-workspace-id': workspaceId }, PAYLOAD + '!');
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    // The budget runs out (one attempt, one retry), the batch is held and counted.
    await until(
      () => metric('usage_events_held_total'),
      (n) => n >= 1,
      60_000
    );
    expect(await metric('usage_events_held_total')).toBe(1);
    expect(hub.usageEvents.size).toBe(0);
    // The hub comes back: the held event comes round again and lands, exactly once.
    hub.usageMode = 'ok';
    await until(
      () => landed(hub, fileId),
      (ok) => ok,
      60_000
    );
    expect([...hub.usageEvents.values()].filter((e) => e.resourceId === fileId)).toHaveLength(1);
    // The poster's outcomes are on /metrics too: the retried batches, then the accepted event.
    expect(await metric('usage_poster_batches_total{outcome="retried"}')).toBeGreaterThanOrEqual(2);
    await until(
      () => metric('usage_poster_events_total{outcome="accepted"}'),
      (n) => n >= 1
    );
  }, 120_000);
});
