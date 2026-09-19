import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { SQL } from 'drizzle-orm';
import {
  fileDeleteRoute,
  fileGetRoute,
  filesListRoute,
  fileUploadRoute
} from '@antasphere/chassis-contract/routes';
import type { Principal } from '@antasphere/chassis-contract';
import type { DbConn, FileRow } from '@antasphere/chassis-db';
import { ulid } from 'ulid';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { FileService } from '../files/service.js';
import { FileTooLargeError } from '../files/spool.js';
import { serveBlob } from '../files/serve.js';
import type { StorageDriver } from '../storage/driver.js';
import { isUuid } from '../pagination.js';
import { requireAuth, requireNonGuest } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (f: FileRow) => ({
  id: f.id,
  sha256: f.sha256,
  sizeBytes: f.sizeBytes,
  contentType: f.contentType,
  originalName: f.originalName,
  createdBy: f.createdBy,
  createdAt: f.createdAt.toISOString()
});

export interface FileRouteDeps {
  service: FileService;
  storage: StorageDriver;
  registry: PlatformRegistry;
  env: Pick<Env, 'MAX_FILE_SIZE_MB' | 'EDITION' | 'APP_VERSION'>;
  logger: Logger;
  instanceId: () => Promise<string>;
  /**
   * ADR 011 blob-delete guard: true when the blob is referenced by a live
   * presentation version manifest — DELETE answers 409 file_in_use instead
   * of removing it. Runs inside the delete transaction (files module stays
   * presentation-agnostic; the wiring point injects the presentation check).
   */
  blobInUse: (tx: DbConn, workspaceId: string, sha256: string) => Promise<boolean>;
  /**
   * ADR 013 per-blob read scope (SL-B1): a WHERE predicate over the `files`
   * row, or `undefined` for the workspace admin/owner operator view. Injected
   * for the same reason as `blobInUse` — the files module stays
   * presentation-agnostic and the wiring point supplies the deck policy.
   */
  blobReadScope: (principal: Principal) => SQL | undefined;
}

export function registerFileRoutes(api: OpenAPIHono, deps: FileRouteDeps): void {
  const { service, storage, registry, env, logger } = deps;
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;

  api.use('/files', requireAuth());
  api.use('/files/*', requireAuth());
  // Guest capability limit (D2, both editions): the generic files surface is
  // a WORKSPACE-level surface (ADR 006) — an inventory of the tenant's blobs
  // with a delete on it. Its READS are now per-deck authorized like every
  // other content read (SL-B1: `deps.blobReadScope`, ADR 013), but the
  // surface as a whole still belongs to the workspace, and an external guest
  // has no business there: they were invited to ONE deck, not to the host
  // tenant's file cabinet. Guests push and pull deck bytes through the ADR
  // 013-gated presentation routes instead (/presentations/assets,
  // /presentations/{id}/assets/{sha256}).
  api.use('/files', requireNonGuest());
  api.use('/files/*', requireNonGuest());

  api.openapi(filesListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const { files: rows, nextCursor } = await service.list(principal.workspaceId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
      // ADR 013 (SL-B1): a plain member pages the blobs they uploaded plus
      // those referenced by decks they can read; admins/owners keep the
      // whole-workspace operator view.
      visibility: deps.blobReadScope(principal)
    });
    return c.json({ files: rows.map(toWire), nextCursor }, 200);
  });

  api.openapi(fileUploadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { name } = c.req.valid('query');
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';

    // Entitlement gate first (declared size), hard cap enforced mid-stream too.
    const declared = Number(c.req.header('content-length') ?? '0');
    const decision = await registry.entitlements.check(principal, {
      key: 'files.upload',
      quantity: declared,
      unit: 'bytes'
    });
    if (!decision.allowed) {
      return c.json(err('entitlement_denied', decision.reason), 413);
    }
    if (!c.req.raw.body) {
      return c.json(err('empty_body', 'Request body required'), 400);
    }

    try {
      const { file, deduplicated } = await service.upload({
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        originalName: name,
        contentType,
        body: Readable.fromWeb(c.req.raw.body as WebReadableStream),
        maxBytes
      });

      c.set('audit', {
        action: 'file.upload',
        resourceType: 'file',
        resourceId: file.id,
        metadata: { name, sizeBytes: file.sizeBytes, deduplicated }
      });
      registry.events.emit('file.uploaded', {
        workspaceId: principal.workspaceId,
        fileId: file.id,
        sizeBytes: file.sizeBytes
      });
      void registry.usage.emit({
        id: ulid(),
        meter: 'files.upload',
        quantity: file.sizeBytes,
        unit: 'bytes',
        occurredAt: new Date().toISOString(),
        workspaceId: principal.workspaceId,
        ...(principal.accountRef ? { accountRef: principal.accountRef } : {}),
        source: { instanceId: await deps.instanceId(), edition: env.EDITION, version: env.APP_VERSION }
      });

      return c.json({ file: toWire(file), deduplicated }, 201);
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        return c.json(err('file_too_large', e.message), 413);
      }
      logger.error({ err: e }, 'file upload failed');
      return c.json(err('upload_failed', 'Upload failed'), 400);
    }
  });

  api.openapi(fileGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    // 404, never 403, when the scope excludes the blob (ADR 013): a blob a
    // principal cannot read must not be probeable by id either.
    const file = await service.get(principal.workspaceId, id, deps.blobReadScope(principal));
    if (!file) return c.json(err('not_found', 'File not found'), 404);
    return c.json(toWire(file), 200);
  });

  api.openapi(fileDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    // Same scope on the mutation: a member must not be able to delete (or
    // probe) a blob they may not read.
    const file = await service.get(principal.workspaceId, id, deps.blobReadScope(principal));
    if (!file) return c.json(err('not_found', 'File not found'), 404);
    const outcome = await service.delete(file, (tx, row) => deps.blobInUse(tx, row.workspaceId, row.sha256));
    if (outcome === 'in_use') {
      return c.json(
        err(
          'file_in_use',
          'This file is referenced by a presentation version — delete the presentation first'
        ),
        409
      );
    }
    c.set('audit', { action: 'file.delete', resourceType: 'file', resourceId: file.id });
    return c.json(toWire(file), 200);
  });

  // ── Content: streamed, Range-capable. Registered as plain Hono routes (a
  // byte endpoint, not part of the JSON OpenAPI surface); guarded by the
  // same requireAuth + scope machinery as everything else under /files.
  // The streaming machinery itself (ETag/304/Range/safe-serving) is shared
  // with the presentation asset download — files/serve.ts.
  const contentHandler = async (c: Context, headOnly: boolean) => {
    const principal = c.get('principal')!;
    const id = c.req.param('id') ?? '';
    // Plain Hono route (no contract param schema): reject a non-UUID id here
    // or it reaches Postgres' uuid cast and surfaces as a sanitized 500.
    if (!isUuid(id)) return c.json(err('not_found', 'File not found'), 404);
    // The byte route carries the ADR 013 scope too (SL-B1) — this was the
    // whole-tenant read: `workspace_id` alone served ANY deck's content to
    // any member and to any presentations:read key.
    const file = await service.get(principal.workspaceId, id, deps.blobReadScope(principal));
    if (!file) return c.json(err('not_found', 'File not found'), 404);

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: file.workspaceId,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      filename: file.originalName,
      headOnly
    });
  };

  // ONE registration for both verbs. Hono rewrites HEAD to GET before routing
  // (verified against the pinned version: a HEAD request runs the GET handler
  // and the HEAD registration never fires), so a separate `api.on('HEAD', …)`
  // is dead code and every HEAD would silently stream the whole body. Read
  // the verb off the request instead — that is the only signal that survives
  // the rewrite. Never add an `api.on('HEAD', …)` route on this app.
  api.get('/files/:id/content', (c) => contentHandler(c, c.req.method === 'HEAD'));
}
