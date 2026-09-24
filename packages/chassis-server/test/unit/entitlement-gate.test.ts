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
import {
  assertToolEntitlements,
  honoPath,
  registerEntitlementGate,
  type CreditCheckRequest,
  type CreditVerdict,
  type EntitlementCloud
} from '../../src/entitlements/index.js';
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
 * Phase 2 (PRDCT-2664): on a metered account the hub's credit check replaces
 * the local one (402 entitlement_denied with the top-up link, 403
 * account_suspended, 403 hub_unavailable), an upload that declares no size
 * meets 411 (PRDCT-2652), and the upgrade link is the hub's page for the
 * organization with the key and the required plan appended.
 */

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;

const TOOL: ToolEntitlements = {
  actions: [
    { key: 'things.make', creditsPerUnit: 10, unit: 'call', label: 'Make a thing' },
    { key: 'files.upload', creditsPerUnit: 5, unit: 'bytes', label: 'Upload' }
  ],
  limits: {
    'files.maxBytes': { oss: 100, free: 50, pro: 500 },
    'things.max': { oss: null, free: 2, pro: null },
    // A count limit with an operator's ceiling on oss (PRDCT-2702).
    'things.capped': { oss: 2, free: 1, pro: 2 }
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
  },
  // An anonymous surface whose hook fails (a lookup error): left to the route.
  {
    route: { method: 'post', path: '/exploding/{id}' },
    meter: {
      key: 'things.make',
      unit: 'call',
      actor: () => {
        throw new Error('lookup failed');
      }
    }
  },
  // An anonymous surface whose hook resolves nothing (an unknown secret).
  {
    route: { method: 'post', path: '/unknown/{id}' },
    meter: { key: 'things.make', unit: 'call', actor: () => null }
  },
  // An anonymous upload door: metered in bytes, no plan limit declared.
  {
    route: { method: 'post', path: '/owned-files/{id}' },
    meter: {
      key: 'files.upload',
      unit: 'bytes',
      quantity: auditedSizeBytes,
      actor: ownerActor
    }
  },
  // An anonymous surface behind a feature (none exists today; the shape is pinned).
  {
    route: { method: 'post', path: '/owned-premium/{id}' },
    feature: 'premium',
    meter: { key: 'things.make', unit: 'call', actor: ownerActor }
  },
  // A count limit read from the path: no meter, the body's size is not judged.
  {
    route: { method: 'post', path: '/count/{n}' },
    limit: { key: 'things.max', value: (ctx) => Number(ctx.params.n) }
  },
  // A size limit with no meter: the limit judges the declared length.
  {
    route: { method: 'post', path: '/sized' },
    limit: { key: 'files.maxBytes', value: declaredContentLength }
  },
  // An owner-attributed surface whose owner has no account (a cloud-local workspace).
  {
    route: { method: 'post', path: '/owned-local/{id}' },
    meter: {
      key: 'things.make',
      unit: 'call',
      actor: (ctx): ActorRef => ({ userId: null, workspaceId: `ws-of-${ctx.params.id}` })
    }
  },
  // ── PRDCT-2702: what a count limit and a conditional feature need ──
  // A count read from the BODY, asynchronously: the count after this action.
  {
    route: { method: 'post', path: '/counted' },
    limit: { key: 'things.max', value: countAfter }
  },
  // The same count against the operator's ceiling on oss.
  {
    route: { method: 'post', path: '/counted-capped' },
    limit: { key: 'things.capped', value: countAfter }
  },
  // A hook that says there is nothing to judge, or fails: the route answers.
  {
    route: { method: 'post', path: '/counted-maybe/{what}' },
    limit: {
      key: 'things.max',
      value: (ctx) => {
        if (ctx.params.what === 'throws') throw new Error('lookup failed');
        return ctx.params.what === 'none' ? null : 9;
      }
    }
  },
  // A feature the route needs only when the body sets a password.
  {
    route: { method: 'post', path: '/lockable' },
    feature: { key: 'premium', when: passwordSet }
  },
  // A feature on a metered route, conditional too (the mint of a share link).
  {
    route: { method: 'post', path: '/lockable-metered' },
    meter: { key: 'things.make', unit: 'call' },
    feature: { key: 'premium', when: passwordSet },
    limit: { key: 'things.max', value: countAfter }
  },
  // A public door with an entry-level actor and a count: the workspace the
  // door opens is judged, the caller is a viewer.
  {
    route: { method: 'post', path: '/door/{id}' },
    actor: ownerActor,
    limit: { key: 'things.max', value: countAfter }
  },
  // A public door whose feature is conditional, no meter.
  {
    route: { method: 'post', path: '/door-lockable/{id}' },
    actor: ownerActor,
    feature: { key: 'premium', when: passwordSet }
  }
]);

/** The count after this action, read from the body: `{ count }` is the count before it. */
async function countAfter(ctx: { body: () => Promise<unknown> }): Promise<number | null> {
  const body = (await ctx.body()) as { count?: unknown } | undefined;
  return typeof body?.count === 'number' ? body.count + 1 : null;
}

/** Whether the body sets a password (a string; null is a removal, undefined is no change). */
async function passwordSet(ctx: { body: () => Promise<unknown> }): Promise<boolean> {
  const body = (await ctx.body()) as { password?: unknown } | undefined;
  return typeof body?.password === 'string';
}

/** How many times an anonymous hook ran (the oss case must never run it). */
const hookRuns = { count: 0 };
function ownerActor(ctx: { params: Record<string, string> }): ActorRef {
  hookRuns.count += 1;
  return { userId: null, workspaceId: `ws-of-${ctx.params.id}`, accountRef: 'acct-owner' };
}

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
  /** Every call of the hub's credit check (the stubbed `cloud.credits`). */
  creditChecks: CreditCheckRequest[];
  hub: { profile: unknown; reads: number };
}

/** The hub's upgrade page for the organization, as every hub since 0.11.0 sends it on the plan read. */
const HUB_UPGRADE_PAGE = 'https://hub.test/billing/upgrade?org=acct-1&tool=things&plan=free';

function fixture(opts: {
  cloud: boolean;
  principal: Principal | null;
  decision?: EntitlementDecision;
  hubProfile?: unknown;
  handler?: (c: Context) => Response | Promise<Response>;
  /** A size refusal the cap deferred to the gate (PRDCT-2632), parked on every request. */
  deferredRefusal?: boolean;
  /** The hub's credit check verdict; allowed by the hub when absent. */
  credits?: (req: CreditCheckRequest) => CreditVerdict;
}): Fixture {
  const app = new OpenAPIHono();
  const emitted: UsageEvent[] = [];
  const checks: Array<{ key: string; quantity: number; unit: string }> = [];
  const creditChecks: CreditCheckRequest[] = [];
  const hub = { profile: opts.hubProfile ?? { plan: 'free' }, reads: 0 };
  app.use('*', async (c, next) => {
    c.set('principal', opts.principal);
    if (opts.deferredRefusal) {
      c.set('bodyRefusal', () => c.json({ error: { code: 'file_too_large', message: 'the cap' } }, 413));
    }
    await next();
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes('/oauth2/token'))
      return Response.json({ access_token: 'mach', expires_in: 900 });
    hub.reads += 1;
    // The hub's whole answer shape (the contract's copy, checked against the
    // hub's wire snapshot; `upgradeUrl` required since PRDCT-2677): the
    // test's `hubProfile` overrides its fields.
    return Response.json({
      accountRef: '77777777-aaaa-4bbb-8ccc-000000000001',
      planUntil: null,
      limits: {},
      features: [],
      upgradeUrl: HUB_UPGRADE_PAGE,
      ...(hub.profile as object)
    });
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
        credits: {
          check: async (req) => {
            creditChecks.push(req);
            return opts.credits?.(req) ?? { allowed: true, source: 'hub', check: null };
          }
        },
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
  app.post('/exploding/:id', handler);
  app.post('/unknown/:id', handler);
  app.post('/owned-files/:id', handler);
  app.post('/owned-premium/:id', handler);
  app.post('/things/:id/premium', handler);
  app.post('/premium-files', handler);
  app.post('/things/:id/nowhere', handler);
  app.post('/owned/:id', handler);
  app.post('/count/:n', handler);
  app.post('/sized', handler);
  app.post('/owned-local/:id', handler);
  app.post('/counted', handler);
  app.post('/counted-capped', handler);
  app.post('/counted-maybe/:what', handler);
  app.post('/lockable', handler);
  app.post('/lockable-metered', handler);
  app.post('/door/:id', handler);
  app.post('/door-lockable/:id', handler);
  return { app, emitted, checks, creditChecks, hub };
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
      source: { instanceId: 'inst', edition: 'cloud', version: 'test' }
    });
    // The body never names the tool: the hub takes it from the token (PRDCT-2629).
    expect(f.emitted[0]).not.toHaveProperty('toolSlug');
    expect(f.emitted[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The hub's check saw the DECLARED size, the emit the stored one; the
    // local check is not asked on a metered account (PRDCT-2653).
    expect(f.creditChecks).toEqual([
      { accountRef: 'acct-1', actionKey: 'files.upload', quantity: 40, unit: 'bytes' }
    ]);
    expect(f.checks).toEqual([]);
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
      upgradeUrl: `${HUB_UPGRADE_PAGE}&key=files.maxBytes&requiredPlan=pro`
    });
    expect(f.checks).toEqual([]);
    expect(f.creditChecks).toEqual([]);
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

  it('a short balance is 402 entitlement_denied with the price, the balance and the top-up link, and emits nothing', async () => {
    const topUpUrl = 'https://hub.test/billing/top-up?org=acct-1&credits=10&balance=3';
    const f = fixture({
      cloud: true,
      principal: principal(),
      credits: (req) => ({
        allowed: false,
        reason: 'insufficient_credits',
        source: 'hub',
        check: {
          accountRef: req.accountRef,
          actionKey: req.actionKey,
          quantity: req.quantity,
          allowed: false,
          credits: 10,
          balance: 3,
          unit: 'call',
          priced: true,
          plan: 'free',
          reason: 'insufficient_credits',
          topUpUrl
        }
      })
    });
    const res = await f.app.request('/things', { method: 'POST' });
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toEqual({
      error: {
        code: 'entitlement_denied',
        message: `This needs 10 credits and the organization holds 3; top up at ${topUpUrl}`,
        details: { credits: 10, balance: 3, topUpUrl }
      }
    });
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('a suspended organization is 403 account_suspended, an outage past the window 403 hub_unavailable, in the live gate’s words', async () => {
    const suspended = fixture({
      cloud: true,
      principal: principal(),
      credits: () => ({ allowed: false, reason: 'account_suspended', source: 'hub', check: null })
    });
    const s = await suspended.app.request('/things', { method: 'POST' });
    expect(s.status).toBe(403);
    expect(await errorOf(s)).toEqual({
      error: { code: 'account_suspended', message: 'This organization is suspended on Antasphere' }
    });
    const closed = fixture({
      cloud: true,
      principal: principal(),
      credits: () => ({ allowed: false, reason: 'hub_unavailable', source: 'closed', check: null })
    });
    const c = await closed.app.request('/things', { method: 'POST' });
    expect(c.status).toBe(403);
    expect(await errorOf(c)).toEqual({
      error: {
        code: 'hub_unavailable',
        message:
          'The Antasphere hub has been unreachable for too long; requests are refused until it recovers'
      }
    });
    await tick();
    expect(suspended.emitted).toEqual([]);
    expect(closed.emitted).toEqual([]);
  });

  it('a quantity the hub cannot price is 413 entitlement_denied with the price and the balance, no top-up link, and emits nothing (PRDCT-2677)', async () => {
    const topUpUrl = 'https://hub.test/billing/top-up?org=acct-1&credits=9007199254740991&balance=3';
    const f = fixture({
      cloud: true,
      principal: principal(),
      credits: (req) => ({
        allowed: false,
        reason: 'unpriceable',
        source: 'hub',
        check: {
          accountRef: req.accountRef,
          actionKey: req.actionKey,
          quantity: req.quantity,
          allowed: false,
          credits: Number.MAX_SAFE_INTEGER,
          balance: 3,
          unit: 'call',
          priced: true,
          plan: 'free',
          reason: 'unpriceable',
          topUpUrl
        }
      })
    });
    const res = await f.app.request('/things', { method: 'POST' });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({
      error: {
        code: 'entitlement_denied',
        message:
          'This quantity cannot be priced (9007199254740991 credits or more, the organization holds 3); nothing was charged',
        // No link: a top-up cannot cover it, and a link would draw the top-up card (verifier round 1).
        details: { credits: Number.MAX_SAFE_INTEGER, balance: 3 }
      }
    });
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('the local credit check is never asked on a metered account (PRDCT-2653): its refusal does not reach the request', async () => {
    const f = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'pro' },
      decision: { allowed: false, reason: 'file exceeds MAX_FILE_SIZE_MB (1MB)' }
    });
    const res = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '400' },
      body: 'x'.repeat(400)
    });
    expect(res.status).toBe(201);
    expect(f.checks).toEqual([]);
    expect(f.creditChecks).toHaveLength(1);
  });

  it('a metered upload that declares no size is 411 length_required before the handler, the check and the event (PRDCT-2652)', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const res = await f.app.request('/files', { method: 'POST', body: 'x'.repeat(40) });
    expect(res.status).toBe(411);
    expect(await errorOf(res)).toEqual({
      error: { code: 'length_required', message: 'A metered upload must declare its size (Content-Length)' }
    });
    expect(f.creditChecks).toEqual([]);
    await tick();
    expect(f.emitted).toEqual([]);
    // A declared zero is a declaration: it passes.
    expect(
      (await f.app.request('/files', { method: 'POST', headers: { 'content-length': '0' } })).status
    ).toBe(201);
    // A metered route without a limit does not judge a size: no 411.
    expect((await f.app.request('/things', { method: 'POST', body: 'x' })).status).toBe(201);
  });

  it('no 411 where no plan applies: oss, and a cloud-local workspace', async () => {
    const oss = fixture({ cloud: false, principal: localPrincipal() });
    expect((await oss.app.request('/files', { method: 'POST', body: 'x'.repeat(40) })).status).toBe(201);
    const local = fixture({ cloud: true, principal: localPrincipal() });
    expect((await local.app.request('/files', { method: 'POST', body: 'x'.repeat(40) })).status).toBe(201);
    expect(local.creditChecks).toEqual([]);
  });

  it('the upgrade link is the hub’s page for the organization with the key and the required plan appended', async () => {
    const page = 'https://hub.test/billing/upgrade?org=acct-1&tool=things&plan=free';
    const f = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'free', upgradeUrl: page }
    });
    const over = await f.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '60' },
      body: 'x'.repeat(60)
    });
    expect(over.status).toBe(403);
    expect((await errorOf(over)).error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: `${page}&key=files.maxBytes&requiredPlan=pro`
    });
    // No plan has the feature: the key alone is appended.
    const nowhere = await f.app.request('/things/9/nowhere', { method: 'POST' });
    expect((await errorOf(nowhere)).error.details).toMatchObject({
      requiredPlan: null,
      upgradeUrl: `${page}&key=nowhere`
    });
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
    // The owner's account is the one the hub is asked to charge.
    expect(f.creditChecks[0]).toMatchObject({
      accountRef: 'acct-owner',
      actionKey: 'things.make',
      quantity: 1
    });
    expect((await f.app.request('/things', { method: 'POST' })).status).toBe(201);
    await tick();
    expect(f.emitted[1]).toMatchObject({ userId: null, workspaceId: 'ws-1', accountRef: 'acct-1' });
  });

  it('a deferred size refusal fires AFTER the plan check on a metered account: over the plan is 403 with the upgrade link, within the plan is the cap’s 413, and nothing is checked or emitted', async () => {
    // Over the free cap (50): the plan refusal, not the cap's.
    const free = fixture({ cloud: true, principal: principal(), deferredRefusal: true });
    const over = await free.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '60' },
      body: 'x'.repeat(60)
    });
    expect(over.status).toBe(403);
    expect((await errorOf(over)).error.details).toMatchObject({ key: 'files.maxBytes', requiredPlan: 'pro' });
    // The plan allows it (pro, 500): the instance's hard ceiling answers.
    const pro = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'pro' },
      deferredRefusal: true
    });
    const capped = await pro.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '400' },
      body: 'x'.repeat(400)
    });
    expect(capped.status).toBe(413);
    expect((await errorOf(capped)).error.code).toBe('file_too_large');
    expect(pro.checks).toEqual([]);
    expect(pro.creditChecks).toEqual([]);
    await tick();
    expect(pro.emitted).toEqual([]);
  });

  it('an OAuth bearer reports via oauth', async () => {
    const f = fixture({ cloud: true, principal: principal({ via: 'oauth' }) });
    await f.app.request('/things', { method: 'POST' });
    await tick();
    expect(f.emitted[0]).toMatchObject({ via: 'oauth' });
  });

  it('a deferred size refusal fires before anything else when no plan applies: no principal, or a cloud-local workspace', async () => {
    const anonymous = fixture({ cloud: true, principal: null, deferredRefusal: true });
    const res = await anonymous.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '9' },
      body: 'x'.repeat(9)
    });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).error.code).toBe('file_too_large');
    const local = fixture({ cloud: true, principal: localPrincipal(), deferredRefusal: true });
    const localRes = await local.app.request('/files', {
      method: 'POST',
      headers: { 'content-length': '9' },
      body: 'x'.repeat(9)
    });
    expect(localRes.status).toBe(413);
    expect(local.checks).toEqual([]);
    expect(local.hub.reads).toBe(0);
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

describe('the gate on an anonymous surface: the route’s actor hook runs with no principal (PRDCT-2634)', () => {
  it('cloud: the owner the hook resolves pays and is reported, the viewer is never a principal', async () => {
    const f = fixture({ cloud: true, principal: null });
    const res = await f.app.request('/owned/deck-7', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f.creditChecks).toEqual([
      { accountRef: 'acct-owner', actionKey: 'things.make', quantity: 1, unit: 'call' }
    ]);
    expect(f.checks).toEqual([]); // the local check is never asked on a metered account
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({
      actionKey: 'things.make',
      accountRef: 'acct-owner',
      workspaceId: 'ws-of-deck-7',
      userId: null,
      via: 'session'
    });
  });

  it('cloud: a credit refusal on an anonymous surface is a NEUTRAL 402: the code, one sentence, no details, no link', async () => {
    const f = fixture({
      cloud: true,
      principal: null,
      credits: () => ({
        allowed: false,
        reason: 'insufficient_credits',
        source: 'hub',
        check: {
          accountRef: '77777777-aaaa-4bbb-8ccc-000000000001',
          actionKey: 'things.make',
          quantity: 1,
          allowed: false,
          credits: 10,
          balance: 0,
          unit: 'call',
          priced: true,
          plan: 'free',
          reason: 'insufficient_credits',
          topUpUrl: 'https://hub.test/billing/top-up?org=secret-org'
        }
      })
    });
    const res = await f.app.request('/owned/deck-7', { method: 'POST' });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe('entitlement_denied');
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).not.toContain('hub.test');
    expect(body.error.message).not.toContain('10');
    expect(body.error.message).not.toContain('secret-org');
    expect(f.emitted).toEqual([]);
  });

  it('a hook that resolves nothing, or throws, leaves the route to its own handling: nothing checked, nothing emitted', async () => {
    for (const path of ['/unknown/x', '/exploding/x']) {
      const f = fixture({ cloud: true, principal: null });
      const res = await f.app.request(path, { method: 'POST' });
      expect(res.status, path).toBe(201);
      expect(f.creditChecks, path).toEqual([]);
      expect(f.emitted, path).toEqual([]);
    }
  });

  it('a route with no actor and no principal is untouched: the route’s own auth answers', async () => {
    const f = fixture({ cloud: true, principal: null });
    const res = await f.app.request('/things', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f.creditChecks).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it('oss: the owner resolves with no account, the surface is unmetered byte for byte', async () => {
    const f = fixture({ cloud: false, principal: null });
    const res = await f.app.request('/owned/deck-7', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f.checks).toEqual([]);
    expect(f.emitted).toEqual([]);
  });
});

describe('the anonymous surface, round 3 of the verifier', () => {
  it('an anonymous upload door metered in bytes refuses a body with no declared size: 411, no check, nothing emitted', async () => {
    const f = fixture({ cloud: true, principal: null });
    const res = await f.app.request('/owned-files/deck-7', { method: 'POST', body: 'x'.repeat(54) });
    expect(res.status).toBe(411);
    expect(f.creditChecks).toEqual([]);
    expect(f.emitted).toEqual([]);
    const ok = await f.app.request('/owned-files/deck-7', {
      method: 'POST',
      headers: { 'content-length': '54' },
      body: 'x'.repeat(54)
    });
    expect(ok.status).toBe(201);
    expect(f.creditChecks).toEqual([
      { accountRef: 'acct-owner', actionKey: 'files.upload', quantity: 54, unit: 'bytes' }
    ]);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({ actionKey: 'files.upload', quantity: 7, accountRef: 'acct-owner' });
  });

  it('a suspended owner, or a closed hub, reads the same neutral 402 to a viewer: no status, no wording of the hub', async () => {
    for (const reason of ['account_suspended', 'hub_unavailable'] as const) {
      const f = fixture({
        cloud: true,
        principal: null,
        credits: () => ({ allowed: false, reason, source: 'hub', check: null })
      });
      const res = await f.app.request('/owned/deck-7', { method: 'POST' });
      expect(res.status, reason).toBe(402);
      const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
      expect(body.error.code, reason).toBe('entitlement_denied');
      expect(body.error.details, reason).toBeUndefined();
      expect(body.error.message, reason).not.toMatch(/suspend|Antasphere|hub/i);
      expect(f.emitted, reason).toEqual([]);
    }
  });

  it('an unpriceable quantity reads the same neutral 402 to a viewer: no figure, no link (PRDCT-2677)', async () => {
    const f = fixture({
      cloud: true,
      principal: null,
      credits: () => ({
        allowed: false,
        reason: 'unpriceable',
        source: 'hub',
        check: {
          accountRef: '77777777-aaaa-4bbb-8ccc-000000000001',
          actionKey: 'things.make',
          quantity: 1,
          allowed: false,
          credits: Number.MAX_SAFE_INTEGER,
          balance: 0,
          unit: 'call',
          priced: true,
          plan: 'free',
          reason: 'unpriceable',
          topUpUrl: 'https://hub.test/billing/top-up?org=secret-org'
        }
      })
    });
    const res = await f.app.request('/owned/deck-7', { method: 'POST' });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe('entitlement_denied');
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe('The owner of this content cannot take this action right now');
    await tick();
    expect(f.emitted).toEqual([]);
  });

  it('a plan refusal on an anonymous surface is neutral too: no key, no plan, no upgrade link', async () => {
    const f = fixture({ cloud: true, principal: null, hubProfile: { plan: 'free' } });
    const res = await f.app.request('/owned-premium/deck-7', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).not.toMatch(/premium|free|pro|hub\.test/);
    expect(f.emitted).toEqual([]);
  });

  it('oss never runs the hook: no lookup for a self-hosted viewer', async () => {
    hookRuns.count = 0;
    const f = fixture({ cloud: false, principal: null });
    const res = await f.app.request('/owned-files/deck-7', {
      method: 'POST',
      headers: { 'content-length': '3' },
      body: 'abc'
    });
    expect(res.status).toBe(201);
    expect(hookRuns.count).toBe(0);
    expect(f.emitted).toEqual([]);
  });

  it('a meter-only route reads no plan: the hub is not asked for the profile', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const res = await f.app.request('/things', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f.hub.reads).toBe(0);
    expect(f.creditChecks).toHaveLength(1);
  });
});

describe('a signed-in holder of a share link is a viewer too (the code review)', () => {
  it('the owner pays and is reported, via session, whatever the viewer signed in with; the refusal is neutral', async () => {
    const f = fixture({
      cloud: true,
      principal: principal({ via: 'api_key', accountRef: 'acct-viewer', workspaceId: 'ws-viewer' }),
      credits: () => ({ allowed: false, reason: 'insufficient_credits', source: 'hub', check: null })
    });
    const res = await f.app.request('/owned/deck-7', { method: 'POST' });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string; details?: unknown } };
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).not.toContain('acct');
    expect(f.creditChecks).toEqual([
      { accountRef: 'acct-owner', actionKey: 'things.make', quantity: 1, unit: 'call' }
    ]);
    const ok = fixture({ cloud: true, principal: principal({ via: 'api_key', accountRef: 'acct-viewer' }) });
    expect((await ok.app.request('/owned/deck-7', { method: 'POST' })).status).toBe(201);
    expect(ok.emitted[0]).toMatchObject({ accountRef: 'acct-owner', via: 'session', userId: null });
  });

  it('a hook that resolves nothing never falls back to the signed-in viewer: the route answers, nothing is checked', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    for (const path of ['/unknown/x', '/exploding/x']) {
      const res = await f.app.request(path, { method: 'POST' });
      expect(res.status, path).toBe(201);
    }
    expect(f.creditChecks).toEqual([]);
    expect(f.checks).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it('a count limit on a JSON route does not demand a Content-Length: only a body-judging limit or a bytes meter does', async () => {
    const f = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'free' } });
    const res = await f.app.request('/count/1', { method: 'POST', body: '{}' });
    expect(res.status).toBe(201);
    expect(f.creditChecks).toEqual([]);
    // The limit is still judged: free allows 2.
    const over = await f.app.request('/count/3', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: '{}'
    });
    expect(over.status).toBe(403);
    expect((await errorOf(over)).error.code).toBe('plan_required');
  });

  it('a size limit with no bytes meter still demands the declared size: 411 on an undeclared body', async () => {
    const f = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'pro' } });
    const res = await f.app.request('/sized', { method: 'POST', body: 'x'.repeat(10) });
    expect(res.status).toBe(411);
    expect((await errorOf(res)).error.code).toBe('length_required');
    const ok = await f.app.request('/sized', {
      method: 'POST',
      headers: { 'content-length': '10' },
      body: 'x'.repeat(10)
    });
    expect(ok.status).toBe(201);
  });

  it('a feature refusal to a signed-in holder of the link is neutral too: no key, no plan, no upgrade link', async () => {
    const f = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'free' } });
    const res = await f.app.request('/owned-premium/1', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await errorOf(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe('The owner of this content cannot take this action right now');
    expect(body.error.message).not.toContain('premium');
    expect(body.error.message).not.toContain('free');
    expect(body.error.message).not.toContain('http');
    expect(f.emitted).toEqual([]);
  });

  it('an owner with no account behind the link: nothing is checked for the signed-in holder, not even the local credit service', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const res = await f.app.request('/owned-local/1', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f.checks).toEqual([]);
    expect(f.creditChecks).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it('oss never runs the hook for a signed-in holder either', async () => {
    hookRuns.count = 0;
    const f = fixture({ cloud: false, principal: principal() });
    // `/owned-premium` resolves through `ownerActor`, the counted hook.
    const res = await f.app.request('/owned-premium/1', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(hookRuns.count).toBe(0);
    expect(f.checks).toEqual([]);
    expect(f.emitted).toEqual([]);
  });
});

describe('a count limit and a conditional feature (PRDCT-2702)', () => {
  const jsonPost = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

  it('cloud: a count read from the body is judged after the action: over the tier value is 403 plan_required naming the plan that allows it, at the value it passes', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const over = await f.app.request('/counted', jsonPost({ count: 2 }));
    expect(over.status).toBe(403);
    const body = await errorOf(over);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.message).toBe('things.max is limited to 2 on the free plan; the pro plan allows it');
    expect(body.error.details).toEqual({
      key: 'things.max',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: `${HUB_UPGRADE_PAGE}&key=things.max&requiredPlan=pro`
    });
    const at = await f.app.request('/counted', jsonPost({ count: 1 }));
    expect(at.status).toBe(201);
  });

  it('the gate’s read of the body is the handler’s: the handler still reads the same JSON after the check', async () => {
    const f = fixture({
      cloud: true,
      principal: principal(),
      handler: async (c) => c.json({ echoed: await c.req.json() }, 201)
    });
    const res = await f.app.request('/counted', jsonPost({ count: 0, name: 'x' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echoed: { count: 0, name: 'x' } });
  });

  it('a body that is not JSON, or none, reads as nothing to count: the route answers, never the gate', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const text = await f.app.request('/counted', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json'
    });
    expect(text.status).toBe(201);
    const none = await f.app.request('/counted', { method: 'POST' });
    expect(none.status).toBe(201);
  });

  it('a count hook never demands a Content-Length on a metered account: a body with no declared size is judged on its count, not 411', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    // `app.request` with a body and no header sends none (the 411 suite's own reproduction).
    const over = await f.app.request('/counted', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 5 })
    });
    expect(over.status).toBe(403);
    expect((await errorOf(over)).error.code).toBe('plan_required');
  });

  it('the hub’s override and the pro plan decide the count too', async () => {
    const wide = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'free', limits: { 'things.max': 10 } }
    });
    expect((await wide.app.request('/counted', jsonPost({ count: 9 }))).status).toBe(201);
    const pro = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'pro' } });
    expect((await pro.app.request('/counted', jsonPost({ count: 999 }))).status).toBe(201);
  });

  it('a hook that resolves null, or throws, leaves the route alone: no plan refusal on a lookup that found nothing', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    expect((await f.app.request('/counted-maybe/none', { method: 'POST' })).status).toBe(201);
    expect((await f.app.request('/counted-maybe/throws', { method: 'POST' })).status).toBe(201);
    // The same hook with a number over the value is refused: the null is the difference.
    expect((await f.app.request('/counted-maybe/some', { method: 'POST' })).status).toBe(403);
  });

  it('oss: the count is judged against the operator’s ceiling, 413 entitlement_denied byte for byte; a null ceiling never runs the hook', async () => {
    const f = fixture({ cloud: false, principal: localPrincipal() });
    const over = await f.app.request('/counted-capped', jsonPost({ count: 2 }));
    expect(over.status).toBe(413);
    expect(await errorOf(over)).toEqual({
      error: { code: 'entitlement_denied', message: 'things.capped: 3 exceeds the instance limit (2)' }
    });
    expect((await f.app.request('/counted-capped', jsonPost({ count: 1 }))).status).toBe(201);
    // `things.max` has no oss ceiling: a count that would be over the free
    // value passes on oss, and the handler still reads the body untouched.
    const g = fixture({
      cloud: false,
      principal: localPrincipal(),
      handler: async (c) => c.json({ echoed: await c.req.json() }, 201)
    });
    const res = await g.app.request('/counted', jsonPost({ count: 50 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echoed: { count: 50 } });
    expect(f.emitted).toEqual([]);
    expect(g.emitted).toEqual([]);
  });

  it('a conditional feature refuses the ACT, never the route: setting a password on free is 403 plan_required, no password or a removal passes, pro passes with one', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const locked = await f.app.request('/lockable', jsonPost({ password: 'hunter22' }));
    expect(locked.status).toBe(403);
    const body = await errorOf(locked);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toEqual({
      key: 'premium',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: `${HUB_UPGRADE_PAGE}&key=premium&requiredPlan=pro`
    });
    expect((await f.app.request('/lockable', jsonPost({ name: 'open' }))).status).toBe(201);
    expect((await f.app.request('/lockable', jsonPost({ password: null }))).status).toBe(201);
    expect((await f.app.request('/lockable', { method: 'POST' })).status).toBe(201);
    const pro = fixture({ cloud: true, principal: principal(), hubProfile: { plan: 'pro' } });
    expect((await pro.app.request('/lockable', jsonPost({ password: 'hunter22' }))).status).toBe(201);
    // A hub answer that lists the feature for a free account passes too.
    const listed = fixture({
      cloud: true,
      principal: principal(),
      hubProfile: { plan: 'free', limits: { 'things.max': 2 }, features: ['premium'] }
    });
    expect((await listed.app.request('/lockable', jsonPost({ password: 'hunter22' }))).status).toBe(201);
  });

  it('on a metered route the conditional feature is judged before the count, the count before the credits, and a refusal emits nothing', async () => {
    const f = fixture({ cloud: true, principal: principal() });
    const both = await f.app.request('/lockable-metered', jsonPost({ password: 'p4ss', count: 9 }));
    expect((await errorOf(both)).error.details).toMatchObject({ key: 'premium' });
    const count = await f.app.request('/lockable-metered', jsonPost({ count: 9 }));
    expect((await errorOf(count)).error.details).toMatchObject({ key: 'things.max' });
    expect(f.creditChecks).toEqual([]);
    expect(f.emitted).toEqual([]);
    const ok = await f.app.request('/lockable-metered', jsonPost({ count: 0 }));
    expect(ok.status).toBe(201);
    expect(f.creditChecks).toHaveLength(1);
    await tick();
    expect(f.emitted).toHaveLength(1);
  });

  it('oss: a conditional feature is never judged (a self-hosted instance has every feature)', async () => {
    const f = fixture({ cloud: false, principal: localPrincipal() });
    expect((await f.app.request('/lockable', jsonPost({ password: 'hunter22' }))).status).toBe(201);
  });

  it('a public door with an entry-level actor: the workspace the door opens is judged on the count, and the caller reads the neutral refusal, with or without a session', async () => {
    hookRuns.count = 0;
    const anonymous = fixture({ cloud: true, principal: null });
    const over = await anonymous.app.request('/door/7', jsonPost({ count: 2 }));
    expect(over.status).toBe(403);
    const body = await errorOf(over);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe('The owner of this content cannot take this action right now');
    expect(hookRuns.count).toBe(1);
    expect((await anonymous.app.request('/door/7', jsonPost({ count: 1 }))).status).toBe(201);
    // A signed-in person of another workspace at the same door is a viewer too.
    const signedIn = fixture({
      cloud: true,
      principal: principal({ workspaceId: 'ws-other', accountRef: 'acct-other' })
    });
    const res = await signedIn.app.request('/door/7', jsonPost({ count: 2 }));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error.details).toBeUndefined();
    expect(anonymous.emitted).toEqual([]);
    expect(signedIn.emitted).toEqual([]);
  });

  it('a public door behind a conditional feature reads the same neutral sentence, and passes without the act', async () => {
    const f = fixture({ cloud: true, principal: null });
    const locked = await f.app.request('/door-lockable/7', jsonPost({ password: 'p4ss' }));
    expect(locked.status).toBe(403);
    expect((await errorOf(locked)).error.details).toBeUndefined();
    expect((await f.app.request('/door-lockable/7', jsonPost({ name: 'x' }))).status).toBe(201);
  });

  it('oss never runs an entry-level hook: the door is unmetered and unjudged', async () => {
    hookRuns.count = 0;
    const f = fixture({ cloud: false, principal: null });
    expect((await f.app.request('/door/7', jsonPost({ count: 50 }))).status).toBe(201);
    expect(hookRuns.count).toBe(0);
  });

  it('the slot guard reads a conditional feature’s key: an undeclared one stops the boot naming the route', () => {
    // A slot of its own: the fixture's `files.maxBytes` advertises a pro
    // value above its oss ceiling on purpose (the gate's tests), which the
    // guard refuses first.
    const slot = { actions: [], limits: {}, features: TOOL.features };
    expect(() =>
      assertToolEntitlements({
        ...slot,
        routes: declareRouteEntitlements([
          { route: { method: 'post', path: '/x' }, feature: { key: 'nothing.declared', when: () => true } }
        ])
      })
    ).toThrow('route POST /x needs the feature "nothing.declared"');
    expect(() =>
      assertToolEntitlements({
        ...slot,
        routes: declareRouteEntitlements([
          { route: { method: 'post', path: '/x' }, feature: { key: 'premium' } }
        ])
      })
    ).not.toThrow();
  });
});
