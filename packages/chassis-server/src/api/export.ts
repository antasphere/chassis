import type { OpenAPIHono } from '@hono/zod-openapi';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { ZipFile } from 'yazl';
import {
  apiKeys,
  auditLog,
  files,
  instanceSettings,
  invitations,
  user as userTable,
  workspaceMembers,
  workspaces,
  type Db
} from '@antasphere/chassis-db';
import type { Env } from '../env.js';
import type { ScopeRoutes } from './scope-routes.js';
import type { Logger } from '../logger.js';
import type { AuditService } from '../audit/service.js';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import { requireAuth, requireNonGuest, requireRole } from '../middleware/auth-context.js';
import { rateLimit, type RateLimiters } from '../middleware/rate-limit.js';
import type { ClientIpFn } from '../middleware/rate-limit.js';

/**
 * GET /workspace/export — the GDPR/portability bundle: every workspace table
 * as JSON, the audit log as NDJSON, and every live blob, streamed as one zip
 * (yazl; modeled on the files-content streaming precedent in files.ts).
 * Secrets never leave: invitations drop tokenHash, api-keys drop secretHash.
 */

const AUDIT_BATCH = 500;

export interface ExportRouteDeps {
  db: Db;
  env: Pick<Env, 'EDITION' | 'APP_VERSION'>;
  storage: StorageDriver;
  audit: AuditService;
  limiters: RateLimiters;
  clientIp: ClientIpFn;
  logger: Logger;
  /** The export route the tool instantiated: its OpenAPI summary names the tool's export scope. */
  workspaceExportRoute: ScopeRoutes['workspaceExportRoute'];
}

/**
 * Zip-slip guard: entry names embed the user-supplied originalName, so strip
 * path separators (`/`, `\`) and control chars, and cap the length — an
 * uploaded name like `../../etc/cron.d/x` must never place an entry outside
 * the extraction directory.
 */
export function sanitizeEntryName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
  return (cleaned || 'file').slice(0, 150);
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Keyset walk of the audit log, one NDJSON line per row (never buffers the table). */
async function* auditNdjson(db: Db, workspaceId: string): AsyncGenerator<string> {
  let lastId = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), gt(auditLog.id, lastId)))
      .orderBy(asc(auditLog.id))
      .limit(AUDIT_BATCH);
    if (rows.length === 0) return;
    for (const row of rows) {
      yield JSON.stringify({ ...row, createdAt: row.createdAt.toISOString() }) + '\n';
      lastId = row.id;
    }
    if (rows.length < AUDIT_BATCH) return;
  }
}

export function registerExportRoutes(api: OpenAPIHono, deps: ExportRouteDeps): void {
  const { db, env, storage, audit, limiters, clientIp, logger } = deps;

  // Gates, in order: rate limit (IP AND user — exports are expensive) →
  // authenticated → admin+. Machine principals additionally passed the
  // fail-closed export-scope gate in authContext before landing here.
  api.use(
    '/workspace/export',
    rateLimit(limiters.workspaceExport, clientIp, async (c) => {
      const principal = c.get('principal');
      return principal ? [`u:${principal.userId}`] : [];
    })
  );
  api.use('/workspace/export', requireAuth());
  // Guest capability limit (D2): the whole-workspace export is the named
  // workspace-scope surface guests must never reach. Defense in depth in
  // front of the admin gate — a guest is minted role 'member' and the role
  // is locked (api/members.ts), but export is exactly the surface where a
  // second, origin-keyed wall is cheap and the failure catastrophic.
  api.use('/workspace/export', requireNonGuest());
  api.use('/workspace/export', requireRole('admin'));

  api.openapi(deps.workspaceExportRoute, async (c) => {
    const principal = c.get('principal')!;
    const workspaceId = principal.workspaceId;

    const [instance] = await db.select().from(instanceSettings).limit(1);
    const [{ liveFiles }] = (await db
      .select({ liveFiles: sql<number>`count(*)::int` })
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), isNull(files.deletedAt)))) as [{ liveFiles: number }];

    // Exactly one audit row either way: machine reads are audited by the
    // middleware (it picks this up from c.set), session GETs are not
    // (audit/service.ts) — so sessions write directly here.
    const auditInfo = {
      action: 'workspace.export',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { files: liveFiles }
    };
    c.set('audit', auditInfo);
    if (principal.via === 'session') {
      await audit.write({
        workspaceId,
        principal,
        ...auditInfo,
        requestId: c.get('requestId'),
        ip: clientIp(c)
      });
    }

    const zip = new ZipFile();
    // @types/yazl types outputStream as the legacy NodeJS.ReadableStream; at
    // runtime it is a real Readable (a PassThrough), which destroy/toWeb need.
    const output = zip.outputStream as Readable;

    // A client abort must tear down the source stream and the zip output or
    // every cancelled download leaks a descriptor/S3 socket (files.ts rule).
    let currentBlobStream: Readable | null = null;
    c.req.raw.signal.addEventListener('abort', () => {
      currentBlobStream?.destroy();
      output.destroy(new Error('client aborted the export download'));
    });

    // Sequential pump, started before returning: entries are added in a
    // fixed order while the output already streams. An error mid-pump
    // destroys the output stream → the client sees a truncated (invalid)
    // zip rather than a silently incomplete "valid" one — accepted: HTTP has
    // no way to fail a 200 that already started streaming.
    void (async () => {
      // 1. Manifest first (no skip list here — it is not known yet; the
      //    skips land in skipped-blobs.json, written last).
      zip.addBuffer(
        jsonBuffer({
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          instance: {
            instanceId: instance?.instanceId ?? null,
            name: instance?.name ?? null,
            edition: env.EDITION,
            version: env.APP_VERSION
          },
          workspaceId
        }),
        'manifest.json'
      );

      // 2. The small bounded tables. Secrets are excluded by SELECTION, not
      //    by post-filtering: invitations.tokenHash and apiKeys.secretHash
      //    are simply never queried.
      const [workspace] = await db
        .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      zip.addBuffer(jsonBuffer(workspace ?? null), 'workspace.json');

      const memberRows = await db
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          email: userTable.email,
          name: userTable.name,
          role: workspaceMembers.role,
          isActive: workspaceMembers.isActive,
          createdAt: workspaceMembers.createdAt,
          lastSeenAt: workspaceMembers.lastSeenAt
        })
        .from(workspaceMembers)
        .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id));
      zip.addBuffer(jsonBuffer(memberRows), 'members.json');

      const invitationRows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          invitedBy: invitations.invitedBy,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          createdAt: invitations.createdAt
        })
        .from(invitations)
        .where(eq(invitations.workspaceId, workspaceId))
        .orderBy(asc(invitations.createdAt), asc(invitations.id));
      zip.addBuffer(jsonBuffer(invitationRows), 'invitations.json');

      // PINNED keys only (workspace_id = this workspace): keys are USER
      // credentials under the user-scoped model — an unpinned key belongs
      // to its holder, not to any one workspace's export.
      const apiKeyRows = await db
        .select({
          id: apiKeys.id,
          keyId: apiKeys.keyId,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          createdBy: apiKeys.createdBy,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          expiresAt: apiKeys.expiresAt
        })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, workspaceId))
        .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
      zip.addBuffer(jsonBuffer(apiKeyRows), 'api-keys.json');

      // 3. Audit log as NDJSON, keyset-batched (this table is unbounded).
      zip.addReadStream(Readable.from(auditNdjson(db, workspaceId)), 'audit-log.ndjson');

      // 4. Files metadata — ALL rows including soft-deleted (deletedAt set;
      //    createdBy may be null after an account delete).
      const fileRows = await db
        .select()
        .from(files)
        .where(eq(files.workspaceId, workspaceId))
        .orderBy(asc(files.createdAt), asc(files.id));
      zip.addBuffer(
        jsonBuffer(
          fileRows.map((f) => ({
            id: f.id,
            sha256: f.sha256,
            sizeBytes: f.sizeBytes,
            contentType: f.contentType,
            originalName: f.originalName,
            createdBy: f.createdBy,
            createdAt: f.createdAt.toISOString(),
            deletedAt: f.deletedAt?.toISOString() ?? null
          }))
        ),
        'files.json'
      );

      // 5. Blobs, strictly one at a time: await each stream's end before
      //    opening the next so file descriptors / S3 sockets never pile up
      //    (yazl keeps accepting entries while piping until end()).
      const skipped: Array<{ fileId: string; sha256: string; reason: string }> = [];
      for (const f of fileRows) {
        // Destroying yazl's output does NOT stop the pump: the ZipFile only
        // latches errors emitted on itself, so entries added after an abort
        // are still opened and fully drained. Check the signal explicitly or
        // a cancelled multi-GB export keeps consuming disk/S3 bandwidth.
        if (c.req.raw.signal.aborted) throw new Error('client aborted the export download');
        if (f.deletedAt) {
          skipped.push({ fileId: f.id, sha256: f.sha256, reason: 'soft-deleted' });
          continue;
        }
        const key = blobKey(f.workspaceId, f.sha256);
        if (!(await storage.exists(key))) {
          skipped.push({ fileId: f.id, sha256: f.sha256, reason: 'blob-missing' });
          continue;
        }
        const stream = await storage.getStream(key);
        currentBlobStream = stream;
        // compress: false — media/binary blobs don't deflate; JSON entries
        // above keep yazl's default compression.
        zip.addReadStream(stream, `files/${f.id}-${sanitizeEntryName(f.originalName)}`, {
          compress: false
        });
        await finished(stream);
        currentBlobStream = null;
      }

      // 6. The skip list last (this is why the manifest carries none).
      zip.addBuffer(jsonBuffer(skipped), 'skipped-blobs.json');
      zip.end();
    })().catch((err: unknown) => {
      // A client cancel is routine, not an operational error.
      if (c.req.raw.signal.aborted) {
        logger.info({ workspaceId }, 'workspace export cancelled by the client');
      } else {
        logger.error({ err, workspaceId }, 'workspace export pump failed — download truncated');
      }
      currentBlobStream?.destroy();
      output.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return c.body(Readable.toWeb(output) as unknown as ReadableStream, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="export-${instance?.instanceId ?? 'instance'}-${stamp}.zip"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
  });
}
