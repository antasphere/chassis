import type { OpenAPIHono } from '@hono/zod-openapi';
import { count, eq, lt, desc } from 'drizzle-orm';
import { auditListRoute } from '@antasphere/chassis-contract/routes';
import { auditLog, user as userTable, type Db } from '@antasphere/chassis-db';
import { requireRole } from '../middleware/auth-context.js';
import { auditFilterConditions, auditWhere, cursorId } from '../audit/filters.js';

export function registerAuditRoutes(api: OpenAPIHono, db: Db): void {
  api.use('/audit', requireRole('admin'));
  api.openapi(auditListRoute, async (c) => {
    const principal = c.get('principal')!;
    const query = c.req.valid('query');
    const { limit } = query;

    // SECURITY: the scope is the caller's workspace and nothing in the
    // query can widen it; every filter narrows within it, as a bound
    // parameter (audit/filters.ts). The cursor stays the last row id, so
    // a page is "the next `limit` rows older than the cursor that match
    // the same filters": a client that changes a filter starts over.
    const scope = eq(auditLog.workspaceId, principal.workspaceId);
    const filters = auditFilterConditions(query);
    const cursor = cursorId(query.cursor);
    const where = auditWhere(scope, filters, cursor !== null ? lt(auditLog.id, cursor) : null);

    const rows = await db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorEmail: userTable.email,
        actorVia: auditLog.actorVia,
        apiKeyId: auditLog.apiKeyId,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        requestId: auditLog.requestId,
        ip: auditLog.ip,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt
      })
      .from(auditLog)
      .leftJoin(userTable, eq(auditLog.actorUserId, userTable.id))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);

    // The total is counted once per listing, on the first page: the count
    // walks the same join and WHERE without the cursor, and a client keeps
    // the figure while it loads the pages after.
    let total: number | null = null;
    if (cursor === null) {
      const [counted] = await db
        .select({ n: count() })
        .from(auditLog)
        .leftJoin(userTable, eq(auditLog.actorUserId, userTable.id))
        .where(auditWhere(scope, filters, null));
      total = counted?.n ?? 0;
    }

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page[page.length - 1]?.id ?? '') : null;
    return c.json(
      {
        entries: page.map((r) => ({
          id: r.id,
          actorUserId: r.actorUserId,
          actorEmail: r.actorEmail,
          actorVia: r.actorVia,
          apiKeyId: r.apiKeyId,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          requestId: r.requestId,
          ip: r.ip,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString()
        })),
        nextCursor,
        total
      },
      200
    );
  });
}
