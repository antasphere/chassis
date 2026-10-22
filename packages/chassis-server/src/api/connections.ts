import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Principal } from '@antasphere/chassis-contract';
import {
  connectionConnectRoute,
  connectionDeliveriesRoute,
  connectionDisconnectRoute,
  connectionFieldsRoute,
  connectionGetRoute,
  connectionSecretRoute,
  connectionsListRoute,
  connectionTestRoute
} from '@antasphere/chassis-contract/routes';
import { requireAuth, requireNonGuest } from '../middleware/auth-context.js';
import { ConnectionRefusedError, type AnyConnectionService } from '../connections/index.js';

/**
 * The connection routes (PRDCT-3773), the same on both editions and never
 * hub-managed: a connection is the tool's, like a webhook. The reads (the
 * list, one source, the deliveries log) are every non-guest member's: the page shows every
 * member what the workspace is connected to, never a secret. The writes
 * (the URL, the secret, the fields, the test, the disconnect) are an OWNER's
 * or an ADMIN's act, checked inside each handler. A guest is refused flat; a
 * session a demo link opened is refused every write
 * (`DEMO_SESSION_REFUSED_API_ROUTES`); a machine principal needs the tool's
 * webhooks scope for a write (`middleware/scopes.ts`). An undeclared source
 * is 404.
 *
 * The receiving URL is answered ONCE, at its making and at a rotation; the
 * secret never; neither reaches the audit row.
 */
export interface ConnectionRouteDeps {
  service: AnyConnectionService;
}

const err = (code: string, message: string) => ({ error: { code, message } });
const FORBIDDEN = err('forbidden', 'Only an owner or an admin manages connections');

const canManage = (principal: Principal) => principal.role === 'owner' || principal.role === 'admin';

const statusOf = (code: ConnectionRefusedError['code']): 400 | 404 | 409 | 502 => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'not_inbound':
    case 'not_connected':
      return 409;
    case 'source_unavailable':
      return 502;
    default:
      return 400;
  }
};

export function registerConnectionRoutes(api: OpenAPIHono, deps: ConnectionRouteDeps): void {
  const { service } = deps;

  for (const path of ['/connections', '/connections/*']) {
    api.use(path, requireAuth());
    api.use(path, requireNonGuest());
  }

  /** A service refusal as a response; anything else is rethrown. The status is cast to the route's own set at each use. */
  const refused = (e: unknown) => {
    if (e instanceof ConnectionRefusedError)
      return { status: statusOf(e.code), body: err(e.code, e.message) };
    throw e;
  };

  api.openapi(connectionsListRoute, async (c) => {
    const principal = c.get('principal')!;
    return c.json({ connections: await service.list(principal.workspaceId) }, 200);
  });

  api.openapi(connectionGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { source } = c.req.valid('param');
    try {
      return c.json(await service.get(principal.workspaceId, source), 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 404);
    }
  });

  api.openapi(connectionConnectRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { source } = c.req.valid('param');
    try {
      const made = await service.connect(
        { workspaceId: principal.workspaceId, userId: principal.userId },
        source
      );
      // The audit row says a URL was made for the source; never the URL, whose token is the receiver's address.
      c.set('audit', { action: 'connection.connect', resourceType: 'connection', resourceId: source });
      return c.json(made, 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 404 | 409);
    }
  });

  api.openapi(connectionSecretRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { source } = c.req.valid('param');
    const { secret } = c.req.valid('json');
    try {
      const connection = await service.setSecret(
        { workspaceId: principal.workspaceId, userId: principal.userId },
        source,
        secret
      );
      // The audit row says the secret was set; never the secret.
      c.set('audit', { action: 'connection.secret', resourceType: 'connection', resourceId: source });
      return c.json(connection, 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status);
    }
  });

  api.openapi(connectionFieldsRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { source } = c.req.valid('param');
    const { fields } = c.req.valid('json');
    try {
      const connection = await service.setFields(
        { workspaceId: principal.workspaceId, userId: principal.userId },
        source,
        fields
      );
      c.set('audit', { action: 'connection.fields', resourceType: 'connection', resourceId: source });
      return c.json(connection, 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 400 | 404 | 409);
    }
  });

  api.openapi(connectionTestRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { source } = c.req.valid('param');
    try {
      const result = await service.test(
        { workspaceId: principal.workspaceId, userId: principal.userId },
        source
      );
      c.set('audit', { action: 'connection.test', resourceType: 'connection', resourceId: source });
      return c.json(result, 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 404 | 409);
    }
  });

  api.openapi(connectionDisconnectRoute, async (c) => {
    const principal = c.get('principal')!;
    if (!canManage(principal)) return c.json(FORBIDDEN, 403);
    const { source } = c.req.valid('param');
    try {
      const connection = await service.disconnect(
        { workspaceId: principal.workspaceId, userId: principal.userId },
        source
      );
      c.set('audit', { action: 'connection.disconnect', resourceType: 'connection', resourceId: source });
      return c.json(connection, 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 404);
    }
  });

  // The log is a read like the list: every non-guest member's (the page shows it to everyone).
  api.openapi(connectionDeliveriesRoute, async (c) => {
    const principal = c.get('principal')!;
    const { source } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    try {
      return c.json(await service.listDeliveries(principal.workspaceId, source, { cursor, limit }), 200);
    } catch (e) {
      const r = refused(e);
      return c.json(r.body, r.status as 404);
    }
  });
}
