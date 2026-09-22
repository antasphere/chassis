import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  declareRouteEntitlements,
  declaredContentLength,
  auditedSizeBytes,
  type ActorRef,
  type EntitlementDecision,
  type Principal,
  type ToolEntitlements,
  type UsageEvent
} from '@antasphere/chassis-contract';
import { honoPath, registerEntitlementGate, type EntitlementCloud } from '../../src/entitlements/index.js';
import { EntitlementProfiles, HubMachineToken } from '../../src/entitlements/index.js';
import type { Logger } from '../../src/logger.js';

/**
 * The one entitlement gate, on a bare Hono app (the billing rail, §7): the
 * order feature → limit → credits on cloud, the credit check first and the
 * oss value after it on oss, 403 `plan_required` with its details, 413
 * `entitlement_denied` byte for byte, the event's enrichment (the hub user,
 * the `via`, the resource the handler recorded, the stored size), no event
 * on a refusal, on a 4xx, on oss or on a cloud-local workspace, the `actor`
 * hook's shape, and the OpenAPI path spelled the way Hono registers it.
 */

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;

const TOOL: ToolEntitlements = {
  actions: [
    { key: 'things.make', creditsPerUnit: 10, unit: 'call', label: 'Make a thing' },
    { key: 'files.upload', creditsPerUnit: 5, unit: 'bytes', label: 'Upload' }
  ],
  limits: {
    'files.maxBytes': { oss: 100, free: 50, pro: 500 },
    'things.max': { oss: null, free: 2, pro: null }
  },
  features: { premium: { free: false, pro: true }, nowhere: { free: false, pro: false } }
};

const ROUTES = declareRouteEntitlements([
  { route: { method: 'post', path: '/things' }, meter: { key: 'things.make', unit: 'call' } },
  {
    route: { method: 'post', path: '/files' },
    meter: { key: 'files.upload', unit: 'bytes', quantity: auditedSizeBytes },
    limit: { key: 'files.maxBytes', value: declaredContentLength }
  },
  { route: { method: 'post', path: '/things/{id}/premium' }, feature: 'premium' },
  {
    route: { method: 'post', path: '/premium-files' },
    feature: 'premium',
    limit: { key: 'files.maxBytes', value: declaredContentLength }
  },
  { route: { method: 'post', path: '/things/{id}/nowhere' }, feature: 'nowhere' },
  {
    route: { method: 'post', path: '/owned/{id}' },
    meter: {
      key: 'things.make',
      unit: 'call',
      actor: (ctx): ActorRef => ({
        userId: null,
        workspaceId: `ws-of-${ctx.params.id}`,
        accountRef: 'acct-owner'
      })
    }
  }
]);

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    email: 'u@example.test',
    name: 'U',
    workspaceId: 'ws-1',
    role: 'member',
    origin: 'hub',
    via: 'session',
    scopes: null,
    accountRef: 'acct-1',
    ...over
  };
}

interface Fixture {
  app: OpenAPIHono;
  emitted: UsageEvent[];
  checks: Array<{ key: string; quantity: number; unit: string }>;
  hub: { profile: unknown; reads: number };
}

function fixture(opts: {
  cloud: boolean;
  principal: Principal | null;
  decision?: EntitlementDecision;
  hubProfile?: unknown;
  handler?: (c: Context) => Response | Promise<Response>;
}): Fixture {
  const app = new OpenAPIHono();
  const emitted: UsageEvent[] = [];
  const checks: Array<{ key: string; quantity: number; unit: string }> = [];
  const hub = { profile: opts.hubProfile ?? { plan: 'free' }, reads: 0 };
  app.use('*', async (c, next) => {
    c.set('principal', opts.principal);
    await next();
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes('/oauth2/token'))
      return Response.json({ access_token: 'mach', expires_in: 900 });
    hub.reads += 1;
    return Response.json(hub.profile);
  }) as typeof fetch;
  const token = new HubMachineToken({
    issuerUrl: 'https://hub.test',
    clientId: 'c',
    clientSecret: 's'.repeat(20),
    resource: 'https://hub.test/mcp',
    logger,
    fetchImpl
  });
  const cloud: EntitlementCloud | undefined = opts.cloud
    ? {
        profiles: new EntitlementProfiles({ issuerUrl: 'https://hub.test', token, logger, fetchImpl }),
        upgradeUrl: 'https://hub.test',
        hubSubject: async (userId) => (userId === 'user-1' ? 'hub-sub-1' : null)
      }
    : undefined;
  registerEntitlementGate(app, {
    declarations: ROUTES,
    tool: TOOL,
    entitlements: {
      check: async (_p, action) => {
        checks.push(action);
        return opts.decision ?? { allowed: true };
      },
      getRequestQuota: async () => ({ perMinute: 0, burstPerSecond: 0 })
    },
    usage: { emit: async (e) => void emitted.push(e) },
    cloud,
    source: async () => ({ instanceId: 'inst', edition: opts.cloud ? 'cloud' : 'oss', version: 'test' }),
    toolSlug: 'things',
    logger
  });
  const handler =
    opts.handler ??
    ((c) => {
      c.set('audit', {
        action: 'x',
        resourceType: 'thing',
        resourceId: 'thing-9',
        metadata: { sizeBytes: 7 }
      });
      return c.json({ ok: true }, 201);
    });
  app.post('/things', handler);
  app.post('/files', handler);
  app.post('/things/:id/premium', handler);
  app.post('/premium-files', handler);
  app.post('/things/:id/nowhere', handler);
  app.post('/owned/:id', handler);
  return { app, emitted, checks, hub };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** The wire's error body, typed for the assertions. */
const errorOf = (res: Response) =>
  res.json() as Promise<{ error: { code: string; message: string; details?: unknown } }>;

/** A principal of a cloud-LOCAL (or oss) workspace: no account behind it. */
function localPrincipal(over: Partial<Principal> = {}): Principal {
  const p = principal({ origin: 'local', ...over });
  delete (p as Partial<Principal>).accountRef;
  return p;
}

describe('honoPath', () => {
  it('spells the OpenAPI path the way Hono registers it', () => {
    expect(honoPath('/things/{id}/versions/{version}')).toBe('/things/:id/versions/:version');
    expect(honoPath('/files')).toBe('/files');
  });
});

describe('the gate on cloud, a hub-projected workspace', () => {
  it('emits one enriched event after a 2xx: the hub user, the via, the resource, the stored size', async () => {
    const f = fixture({ cloud: true, principal: principal({ via: 'api_key' }) });
    const res = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '40' },
      body: 'x'.repeat(40)
    });
    expect(res.status).toBe(201);
    await tick();
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({
      meter: 'files.upload',
      actionKey: 'files.upload',
      quantity: 7,
      unit: 'bytes',
      workspaceId: 'ws-1',
      accountRef: 'acct-1',
      userId: 'hub-sub-1',
      via: 'api_key',
      resourceType: 'thing',
      resourceId: 'thing-9',
      toolSlug: 'things',
      source: { instanceId: 'inst', edition: 'cloud', version: 'test' }
    });
    expect(f.emitted[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The check saw the DECLARED size, the emit the stored one.
    expect(f.checks).toEqual([{ key: 'files.upload', quantity: 40, unit: 'bytes' }]);
    expect(f.hub.reads).toBe(1);
  });

  it('refuses a limit over the tier value with 403 plan_required and the details, before the credit check, and emits nothing', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const res = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '60' },
      body: 'x'.repeat(60)
    });
    expect(res.status).toBe(403);
    const body = await errorOf(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: 'https://hub.test'
    });
    expect(f.checks).toEqual([]);
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('the feature is judged before the limit: a request refused on both names the feature', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const res = await f.app.request('/premium-files', {
      method: 'POST',
      headers: { 'content-length': '60' },
      body: 'x'.repeat(60)
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error.details).toMatchObject({ key: 'premium', requiredPlan: 'pro' });
    // A pro account passes the feature and is then held to the pro limit.
    const pro = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'pro' } });
    const over = await pro.app.request('/premium-files', {
      method: 'POST',
      headers: { 'content-length': '600' },
      body: 'x'.repeat(600)
    });
    expect((await errorOf(over)).error.details).toMatchObject({
      key: 'files.maxBytes',
      plan: 'pro',
      requiredPlan: null
    });
  });

  it('a feature the plan lacks is 403 plan_required naming the plan that has it; one no plan has says so', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const premium = await f.app.request('/things/9/premium', { method: 'POST' });
    expect(premium.status).toBe(403);
    expect((await errorOf(premium)).error.details).toMatchObject({
      key: 'premium',
      plan: 'free',
      requiredPlan: 'pro'
    });
    const nowhere = await f.app.request('/things/9/nowhere', { method: 'POST' });
    expect(nowhere.status).toBe(403);
    expect((await errorOf(nowhere)).error.details).toMatchObject({ key: 'nowhere', requiredPlan: null });
  });

  it('the hub’s plan and overrides decide: a pro account passes the feature and the wider limit', async () => {
    const f = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'pro' } });
    expect((await f.app.request('/things/9/premium', { method: 'POST' })).status).toBe(201);
    expect(
      (
        await f.app.request('/files', {
          method: 'POST',
          headers: { 'content-length': '400' },
          body: 'x'.repeat(400)
        })
      ).status
    ).toBe(201);
    const over = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'free', limits: { 'files.maxBytes': 70 } }
    });
    expect(
      (
        await over.app.request('/files', {
          method: 'POST',
          headers: { 'content-length': '60' },
          body: 'x'.repeat(60)
        })
      ).status
    ).toBe(201);
  });

  it('the credit check refuses with 413 entitlement_denied and its reason, after the plan checks', async () => {
    const f = fixture({
      cloud: true,
      principal: principal(),
      decision: { allowed: false, reason: 'no credits' }
    });
    const res = await f.app.request('/things', { method: 'POST' });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({ error: { code: 'entitlement_denied', message: 'no credits' } });
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('a handler refusal (4xx) emits nothing', async () => {
    const f = fixture({ cloud: true, principal: principal(), handler: (c) => c.json({ error: {} }, 409) });
    expect((await f.app.request('/things', { method: 'POST' })).status).toBe(409);
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('a cloud-LOCAL workspace (no account) is unmetered: no plan, no hub read, no event, the oss value applies', async () => {
    const f = fixture({ cloud: true, principal: localPrincipal() });
    expect(
      (
        await f.app.request('/files', {
          method: 'POST',
          headers: { 'content-length': '60' },
          body: 'x'.repeat(60)
        })
      ).status
    ).toBe(201);
    expect(f.hub.reads).toBe(0);
    await tick();
    expect(f.emitted).toEqual([]);
    const over = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '101' },
      body: 'x'.repeat(101)
    });
    expect(over.status).toBe(413);
    expect((await errorOf(over)).error.code).toBe('entitlement_denied');
  });

  it('a user with no hub link reports null, and the actor hook resolves the owner’s workspace and account', async () => {
    const f = fixture({ cloud: true, principal: principal({ userId: 'local-only' }) });
    expect((await f.app.request('/owned/42', { method: 'POST' })).status).toBe(201);
    await tick();
    expect(f.emitted[0]).toMatchObject({ userId: null, workspaceId: 'ws-of-42', accountRef: 'acct-owner' });
    expect((await f.app.request('/things', { method: 'POST' })).status).toBe(201);
    await tick();
    expect(f.emitted[1]).toMatchObject({ userId: null, workspaceId: 'ws-1', accountRef: 'acct-1' });
  });

  it('an OAuth bearer reports via oauth', async () => {
    const f = fixture({ cloud: true, principal: principal({ via: 'oauth' }) });
    await f.app.request('/things', { method: 'POST' });
    await tick();
    expect(f.emitted[0]).toMatchObject({ via: 'oauth' });
  });

  it('a request with no principal is left to the route’s own auth', async () => {
    const f = fixture({ cloud: true, principal: null });
    expect((await f.app.request('/things', { method: 'POST' })).status).toBe(201);
    expect(f.checks).toEqual([]);
    await tick();
    expect(f.emitted).toEqual([]);
  });
});

describe('the gate on oss', () => {
  it('runs the credit check first (today’s refusal byte for byte), then the oss value, and emits nothing', async () => {
    const refused = fixture({
      cloud: false,
      principal: localPrincipal(),
      decision: { allowed: false, reason: 'file exceeds MAX_FILE_SIZE_MB (1MB)' }
    });
    const res = await refused.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '60' },
      body: 'x'.repeat(60)
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({
      error: { code: 'entitlement_denied', message: 'file exceeds MAX_FILE_SIZE_MB (1MB)' }
    });

    const f = fixture({ cloud: false, principal: localPrincipal() });
    expect(
      (
        await f.app.request('/files', {
          method: 'POST',
          headers: { 'content-length': '60' },
          body: 'x'.repeat(60)
        })
      ).status
    ).toBe(201);
    const over = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '101' },
      body: 'x'.repeat(101)
    });
    expect(over.status).toBe(413);
    expect((await errorOf(over)).error).toEqual({
      code: 'entitlement_denied',
      message: 'files.maxBytes: 101 exceeds the instance limit (100)'
    });
    // Features have no tier on oss: every feature route passes.
    expect((await f.app.request('/things/9/premium', { method: 'POST' })).status).toBe(201);
    await tick();
    expect(f.emitted).toEqual([]);
    expect(f.hub.reads).toBe(0);
  });
});
