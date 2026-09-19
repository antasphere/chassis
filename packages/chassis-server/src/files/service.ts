import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { fileUploaders, files, type Db, type DbConn, type FileRow } from '@antasphere/chassis-db';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import type { Logger } from '../logger.js';
import { FileTooLargeError, spoolUpload } from './spool.js';

export { FileTooLargeError };

/**
 * Through-app streamed uploads: the body is spooled to DATA_DIR/tmp while
 * sha256 + size accumulate (never buffered in memory), the size cap enforced
 * mid-stream, then the spool streams into the driver under the
 * content-addressed key. Upload of bytes that already exist for the
 * workspace is idempotent — same row comes back.
 */
export class FileService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly spoolDir: string,
    private readonly logger: Logger
  ) {}

  async upload(opts: {
    workspaceId: string;
    createdBy: string;
    originalName: string;
    contentType: string;
    body: Readable;
    maxBytes: number;
  }): Promise<{ file: FileRow; deduplicated: boolean }> {
    const spool = await spoolUpload(opts.body, opts.maxBytes, this.spoolDir);
    const spoolPath = spool.path;
    const size = spool.sizeBytes;
    const sha256 = spool.sha256;

    try {
      // Idempotent per (workspace, sha): reuse (and revive) an existing row.
      const [existing] = await this.db
        .select()
        .from(files)
        .where(and(eq(files.workspaceId, opts.workspaceId), eq(files.sha256, sha256)))
        .limit(1);
      const key = blobKey(opts.workspaceId, sha256);

      if (existing) {
        if (!(await this.storage.exists(key))) {
          await this.storage.put(key, createReadStream(spoolPath), {
            contentType: existing.contentType,
            sizeBytes: size
          });
        }
        if (existing.deletedAt) {
          await this.db.update(files).set({ deletedAt: null }).where(eq(files.id, existing.id));
          existing.deletedAt = null;
        }
        await this.recordUploader(existing.id, opts.createdBy);
        return { file: existing, deduplicated: true };
      }

      await this.storage.put(key, createReadStream(spoolPath), {
        contentType: opts.contentType,
        sizeBytes: size
      });
      const [row] = await this.db
        .insert(files)
        .values({
          workspaceId: opts.workspaceId,
          sha256,
          sizeBytes: size,
          contentType: opts.contentType,
          originalName: opts.originalName,
          createdBy: opts.createdBy
        })
        .returning();
      await this.recordUploader(row!.id, opts.createdBy);
      return { file: row!, deduplicated: false };
    } finally {
      await spool.cleanup();
    }
  }

  /**
   * Records that this user pushed these exact bytes — on the fresh-insert AND
   * the dedupe path. `files.created_by` only ever names the FIRST uploader,
   * so it cannot answer "does this principal hold these bytes" once blob
   * reads are per-deck authorized (SL-B1); this join table can. Idempotent.
   */
  private async recordUploader(fileId: string, userId: string): Promise<void> {
    await this.db.insert(fileUploaders).values({ fileId, userId }).onConflictDoNothing();
  }

  /** Content-addressed lookup — the presentation asset pull path. */
  async getBySha(workspaceId: string, sha256: string): Promise<FileRow | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.sha256, sha256)))
      .limit(1);
    if (!row || row.deletedAt) return null;
    return row;
  }

  /**
   * `visibility` is the caller's per-blob authorization predicate over the
   * `files` row (SL-B1): the files module stays presentation-agnostic, so the
   * wiring point injects the ADR 013 scope. `undefined` = the operator view
   * (workspace admin/owner), which sees every blob in the workspace. An
   * unauthorized blob is indistinguishable from a missing one — the handlers
   * answer 404, never 403 (ADR 013's not-probeable posture).
   */
  async get(workspaceId: string, id: string, visibility?: SQL | undefined): Promise<FileRow | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspaceId, workspaceId), ...(visibility ? [visibility] : [])))
      .limit(1);
    if (!row || row.deletedAt) return null;
    return row;
  }

  async list(
    workspaceId: string,
    opts: { cursor?: string; limit: number; visibility?: SQL | undefined }
  ): Promise<{ files: FileRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    // The soft-delete filter MUST be SQL-side: a JS filter after the fetch
    // would shrink pages below the limit and break cursor correctness. Same
    // reason the ADR 013 visibility scope is a WHERE clause, not a post-filter.
    const rows = await this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          isNull(files.deletedAt),
          ...(opts.visibility ? [opts.visibility] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: files,
                  id: files.id,
                  createdAt: files.createdAt,
                  workspaceId: files.workspaceId,
                  cursorId,
                  workspace: workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { files: page, nextCursor };
  }

  /**
   * Soft-deletes the row and removes the blob (one row per (ws, sha) by
   * constraint). `inUse` is the ADR 011 blob-delete guard: it runs INSIDE the
   * delete transaction with the files row locked FOR UPDATE, so it serializes
   * against version commits (which lock referenced rows FOR SHARE) — a blob
   * can never be deleted and referenced concurrently. Returns 'in_use'
   * without touching anything when the guard refuses.
   */
  async delete(
    row: FileRow,
    inUse?: (tx: DbConn, row: FileRow) => Promise<boolean>
  ): Promise<'deleted' | 'in_use'> {
    const outcome = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: files.id, deletedAt: files.deletedAt })
        .from(files)
        .where(eq(files.id, row.id))
        .for('update')
        .limit(1);
      // Already gone (raced another delete): idempotent success.
      if (!locked || locked.deletedAt) return 'deleted' as const;
      if (inUse && (await inUse(tx, row))) return 'in_use' as const;
      await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, row.id));
      return 'deleted' as const;
    });
    if (outcome === 'in_use') return outcome;
    // The soft-delete is authoritative; blob removal is best-effort cleanup —
    // a storage failure must not fail the request (a re-upload self-heals via
    // content addressing). Now that the driver surfaces real transport errors,
    // swallow them here rather than in the driver.
    try {
      await this.storage.delete(blobKey(row.workspaceId, row.sha256));
    } catch (err) {
      this.logger.error({ err, fileId: row.id }, 'blob delete failed — row soft-deleted, blob orphaned');
    }
    return 'deleted';
  }

  async spoolDirUsable(): Promise<boolean> {
    try {
      await mkdir(this.spoolDir, { recursive: true });
      const s = await stat(this.spoolDir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}
