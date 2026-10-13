import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Principal } from '@antasphere/chassis-contract';
import {
  webhookCatalogRoute,
  webhookCreateRoute,
  webhookDeleteRoute,
  webhookDeliveriesListRoute,
  webhookDeliveryGetRoute,
  webhookGetRoute,
  webhookRedeliverRoute,
  webhookRotateSecretRoute,
  webhooksListRoute,
  webhookTestRoute,
  webhookUpdateRoute
} from '@antasphere/chassis-contract/routes';
import { requireAuth, requireNonGuest } from '../middleware/auth-context.js';
import { catalogToWire, WebhookRefusedError, type WebhookService } from '../webhooks/index.js';

/**
 * The webhook routes (PRDCT-3482), the same on both editions and never
 * hub-managed: a webhook is the tool's, on a self-hosted instance and on
 * the cloud alike (Romain's rule of 27 September 2026).
 *
 * A webhook is a standing read of the workspace to a URL of the caller's
 * choice, so the whole family, reads included, is an OWNER's or an ADMIN's
 * act, checked inside each handler (never a path-pattern `requireRole`, the
 * `/thing/:id` trap: the catalog lives under the same prefix and is every
 * non-guest member's). A guest is refused flat; a session a demo link
 * opened is refused every write (`DEMO_SESSION_REFUSED_API_ROUTES`); a
 * machine principal needs the tool's dedicated scope (`middleware/scopes.ts`).
 * An endpoint of another workspace reads as absent: 404, never 403.
 *
 * The secret is answered ONCE, at creation and at rotation, and never
 * written to the audit row.
 */
export interface WebhookRouteDeps {
  service: WebhookService;
}

const err = (code: string, message: string) => ({ error: { code, message } });
const FORBIDDEN = err('forbidden', 'Only an owner or an admin manages webhooks');
const NOT_FOUND = err('not_found', 'Webhook not found');
const DELIVERY_NOT_FOUND = err('not_found', 'Delivery not found');

const canManage = (principal: Principal) => principal.role === 'owner' || principal.role === 'admin';

export function registerWebhookRoutes(api: OpenAPIHono, deps: WebhookRouteDeps): void {
  const { service } = deps;

  for (const path of ['/webhooks', '/webhooks/*']) {
    api.use(path, requireAuth());
    api.use(path, requireNonGuest());
  }

  // The catalog BEFORE the `{id}` routes: `events` is not an id. Every
  // non-guest member reads it (an agent discovers the types with a read key).
  api.openapi(webhookCatalogRoute, async (c) => c.json(catalogToWire(service.catalog), 200));

  api.openapi(webhooksListRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { cursor, limit } = c.req.valid('query');
    return c.json(await service.list(principal.workspaceId, cursor, limit), 200);
  });

  api.openapi(webhookCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const body = c.req.valid('json');
    let created: Awaited<ReturnType<WebhookService['create']>>;
    try {
      created = await service.create(principal.workspaceId, principal.userId, body);
    } catch (e) {
      if (e instanceof WebhookRefusedError && e.code === 'url_refused')
        return c.json(err('url_refused', e.message), 400);
      throw e;
    }
    c.set('audit', {
      action: 'webhook.create',
      resourceType: 'webhook',
      resourceId: created.endpoint.id,
      metadata: {
        url: created.endpoint.url,
        events: created.endpoint.events,
        filters: created.endpoint.filters
      }
    });
    return c.json({ ...created.endpoint, secret: created.secret }, 201);
  });

  api.openapi(webhookGetRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const endpoint = await service.get(principal.workspaceId, id);
    return endpoint ? c.json(endpoint, 200) : c.json(NOT_FOUND, 404);
  });

  api.openapi(webhookUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    let updated: Awaited<ReturnType<WebhookService['update']>>;
    try {
      updated = await service.update(principal.workspaceId, id, body);
    } catch (e) {
      if (e instanceof WebhookRefusedError && e.code === 'url_refused')
        return c.json(err('url_refused', e.message), 400);
      throw e;
    }
    if (!updated) return c.json(NOT_FOUND, 404);
    c.set('audit', {
      action: 'webhook.update',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { fields: Object.keys(body) }
    });
    return c.json(updated, 200);
  });

  api.openapi(webhookDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const removed = await service.remove(principal.workspaceId, id);
    if (!removed) return c.json(NOT_FOUND, 404);
    c.set('audit', {
      action: 'webhook.delete',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { url: removed.url }
    });
    return c.json(removed, 200);
  });

  api.openapi(webhookRotateSecretRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const rotated = await service.rotateSecret(principal.workspaceId, id);
    if (!rotated) return c.json(NOT_FOUND, 404);
    c.set('audit', {
      action: 'webhook.rotate_secret',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { previousSecretExpiresAt: rotated.previousSecretExpiresAt }
    });
    return c.json(
      {
        ...rotated.endpoint,
        secret: rotated.secret,
        previousSecretExpiresAt: rotated.previousSecretExpiresAt
      },
      200
    );
  });

  api.openapi(webhookTestRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const delivery = await service.test(principal.workspaceId, id, principal.userId);
    if (!delivery) return c.json(NOT_FOUND, 404);
    c.set('audit', {
      action: 'webhook.test',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { deliveryId: delivery.id, status: delivery.status, lastStatusCode: delivery.lastStatusCode }
    });
    return c.json({ delivery }, 200);
  });

  api.openapi(webhookDeliveriesListRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id } = c.req.valid('param');
    const { cursor, limit, status } = c.req.valid('query');
    const page = await service.listDeliveries(principal.workspaceId, id, { cursor, limit, status });
    return page ? c.json(page, 200) : c.json(NOT_FOUND, 404);
  });

  api.openapi(webhookDeliveryGetRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id, deliveryId } = c.req.valid('param');
    const delivery = await service.getDelivery(principal.workspaceId, id, deliveryId);
    return delivery ? c.json(delivery, 200) : c.json(DELIVERY_NOT_FOUND, 404);
  });

  api.openapi(webhookRedeliverRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { id, deliveryId } = c.req.valid('param');
    const delivery = await service.redeliver(principal.workspaceId, id, deliveryId);
    if (!delivery) return c.json(DELIVERY_NOT_FOUND, 404);
    c.set('audit', {
      action: 'webhook.redeliver',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { deliveryId: delivery.id, eventId: delivery.eventId, eventType: delivery.eventType }
    });
    return c.json(delivery, 201);
  });
}
