import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import type { ScopeRoutes } from './scope-routes.js';
import { apiKeys, workspaceMembers, type ApiKey, type Db } from '@antasphere/chassis-db';
import { sql } from 'drizzle-orm';
import type { ApiKeyService } from '../apikeys/service.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import { requireAuth } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  keyId: k.keyId,
  scopes: k.scopes as string[],
  workspaceId: k.workspaceId,
  createdBy: k.createdBy,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  expiresAt: k.expiresAt?.toISOString() ?? null
});

/**
 * API keys are USER credentials (user-scoped credential model): the listing
 * and the revoke are keyed on the CREATOR, not on any workspace — a key acts
 * as its holder wherever their memberships reach, so "my keys" is the only
 * honest scope. Mint stays sessions-only and accepts an optional workspace
 * PIN (least privilege); revocation is creator-only (a workspace admin has
 * no standing over another user's credential).
 */
export function registerApiKeyRoutes(
  api: OpenAPIHono,
  db: Db,
  service: ApiKeyService,
  routes: Pick<ScopeRoutes, 'apiKeysListRoute' | 'apiKeyCreateRoute' | 'apiKeyRevokeRoute'>
): void {
  const { apiKeysListRoute, apiKeyCreateRoute, apiKeyRevokeRoute } = routes;
  api.use('/api-keys', requireAuth());
  api.use('/api-keys/*', requireAuth());

  api.openapi(apiKeysListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const cursorId = cursorRowId(cursor);
    const rows = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.createdBy, principal.userId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: apiKeys,
                  id: apiKeys.id,
                  createdAt: apiKeys.createdAt,
                  // The keyset scope column (see pagination.ts): the listing
                  // is creator-scoped, so a foreign user's cursor can never
                  // position inside this user's ordering.
                  workspaceId: apiKeys.createdBy,
                  cursorId,
                  workspace: principal.userId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return c.json({ apiKeys: page.map(toWire), nextCursor }, 200);
  });

  api.openapi(apiKeyCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    // Locked rule: a key never mints a key. Sessions only.
    if (principal.via !== 'session') {
      return c.json(err('sessions_only', 'API keys can only be created from a browser session'), 403);
    }
    const body = c.req.valid('json');
    // Optional PIN: an ACTIVE membership of the pinned workspace is required
    // — one uniform 403 whether the workspace does not exist or the caller
    // is not a member (no oracle about other workspaces).
    if (body.workspaceId) {
      const [member] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, principal.userId),
            eq(workspaceMembers.workspaceId, body.workspaceId),
            eq(workspaceMembers.isActive, true)
          )
        )
        .limit(1);
      if (!member) {
        return c.json(err('no_membership', 'This workspace is not available to this account'), 403);
      }
    }
    // The client sends a TTL in days; the server owns the absolute expiry.
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    const minted = await service.mint({
      workspaceId: body.workspaceId ?? null,
      createdBy: principal.userId,
      name: body.name,
      scopes: body.scopes,
      expiresAt
    });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, minted.id)).limit(1);
    c.set('audit', {
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: minted.id,
      metadata: {
        name: body.name,
        scopes: body.scopes,
        workspaceId: body.workspaceId ?? null,
        expiresAt: expiresAt?.toISOString() ?? null
      }
    });
    return c.json({ apiKey: toWire(row!), key: minted.key }, 201);
  });

  api.openapi(apiKeyRevokeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    // Creator-only: a key is its creator's credential. A foreign key answers
    // the same 404 as a nonexistent one (existence is not probeable).
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.createdBy, principal.userId)))
      .limit(1);
    if (!key) return c.json(err('not_found', 'API key not found'), 404);
    if (!key.revokedAt) {
      await db
        .update(apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(eq(apiKeys.id, key.id));
    }
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).limit(1);
    c.set('audit', { action: 'apikey.revoke', resourceType: 'api_key', resourceId: key.id });
    return c.json(toWire(updated!), 200);
  });
}
