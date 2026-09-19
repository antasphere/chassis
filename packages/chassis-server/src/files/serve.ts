import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { isValidMediaType } from '@antasphere/chassis-contract';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import type { Logger } from '../logger.js';
import { contentDispositionFor, parseRangeHeader } from './http.js';

export interface ServeBlobOptions {
  storage: StorageDriver;
  logger: Logger;
  workspaceId: string;
  sha256: string;
  /**
   * The blob's storage key when it is NOT a content-addressed workspace
   * file (a form upload lives under its own key, forms/uploads.ts). Unset =
   * `blobKey(workspaceId, sha256)`. The ETag stays the sha either way.
   */
  storageKey?: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
  headOnly: boolean;
  /**
   * Full Content-Disposition override. Default (unset) = the safe-serving
   * policy (`contentDispositionFor`: active types attachment). ONLY the
   * public viewer (ADR 012) passes `inline; …` — legitimate solely because
   * every viewer response is locked under `CSP: sandbox` (opaque origin);
   * never override this on an app-origin surface without that regime.
   */
  contentDisposition?: string;
  /**
   * Headers merged over the defaults (viewer: the ADR 012 sandbox CSP,
   * `Referrer-Policy: no-referrer`, and a revalidating Cache-Control — the
   * viewer URL is not content-addressed, so `immutable` would be wrong
   * there). Applied to every status this helper emits, 304 included.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Stream one content-addressed blob: immutable ETag (= the sha), 304, single
 * Range (206/416), safe-serving disposition + nosniff (docs/security/security.md —
 * user content never renders on the app origin). Shared by the files content
 * route and the presentation asset download; both resolve METADATA first and
 * only then hand the bytes question here.
 */
export async function serveBlob(c: Context, opts: ServeBlobOptions): Promise<Response> {
  // Content-addressed: the ETag IS the content hash, immutable forever.
  const etag = `"${opts.sha256}"`;
  // Defensive sanitization at the header set (PLT-5, PRDCT-1358): the
  // contract now refuses a non-RFC-7231 contentType at commit, but versions
  // are IMMUTABLE — a value committed before that gate (or through any
  // future path that skips it) would make the `Headers` constructor throw on
  // every serve of the asset, an unrepairable anonymous 500. An invalid
  // stored value degrades to octet-stream instead of poisoning the route.
  const contentType = isValidMediaType(opts.contentType) ? opts.contentType : 'application/octet-stream';
  const baseHeaders: Record<string, string> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-disposition': opts.contentDisposition ?? contentDispositionFor(contentType, opts.filename),
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, max-age=31536000, immutable',
    ...(opts.extraHeaders ?? {})
  };

  if (c.req.header('if-none-match') === etag) {
    return c.body(null, 304, baseHeaders);
  }

  // The metadata row is shared (Postgres) but the blob must be reachable
  // from THIS replica before any status line is committed: with local
  // storage behind a multi-replica load balancer the bytes live on another
  // replica's private disk, and streaming ahead sent 200 + headers, then
  // died mid-body — silent truncation the client cannot distinguish from
  // the real file (scale drill, I2). The clean 404 is a safety net, not a
  // supported topology: multi-replica requires shared storage
  // (STORAGE_DRIVER=s3), docs/self-hosting/deployment-profiles.md.
  const key = opts.storageKey ?? blobKey(opts.workspaceId, opts.sha256);
  if (!(await opts.storage.exists(key))) {
    opts.logger.error(
      { key, driver: opts.storage.name },
      'blob unreachable: metadata row exists but storage has no bytes (local storage behind multiple replicas?)'
    );
    return c.json({ error: { code: 'not_found', message: 'File content not available' } }, 404);
  }

  const parsed = parseRangeHeader(c.req.header('range'), opts.sizeBytes);
  if (parsed.kind === 'unsatisfiable') {
    return c.body(null, 416, { ...baseHeaders, 'content-range': `bytes */${opts.sizeBytes}` });
  }

  const isPartial = parsed.kind === 'range';
  const start = isPartial ? parsed.range.start : 0;
  const end = isPartial ? parsed.range.end : opts.sizeBytes - 1;
  const length = opts.sizeBytes === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    ...baseHeaders,
    'content-length': String(length),
    ...(isPartial ? { 'content-range': `bytes ${start}-${end}/${opts.sizeBytes}` } : {})
  };
  const status = isPartial ? 206 : 200;

  if (opts.headOnly || opts.sizeBytes === 0) {
    return c.body(null, status, headers);
  }

  const nodeStream = await opts.storage.getStream(key, isPartial ? parsed.range : undefined);
  // Backpressure rides Readable.toWeb; a client abort must destroy the
  // source or every seek-away leaks a descriptor/S3 socket.
  c.req.raw.signal.addEventListener('abort', () => nodeStream.destroy());
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return c.body(web, status, headers);
}
