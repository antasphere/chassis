import type { Readable } from 'node:stream';

/**
 * The storage seam. Postgres never holds file bytes; every write goes
 * through a driver. `local` (default) writes under DATA_DIR — valid for
 * single-replica deployments; `s3` covers MinIO self-hosted and AWS/R2/GCS
 * interop in cloud. Presigned-URL methods are deliberately reserved for a
 * later revision (through-app streaming is the v1 contract).
 */
export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

export interface PutOptions {
  contentType: string;
  sizeBytes: number;
}

export interface HeadResult {
  sizeBytes: number;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, data: Readable, opts: PutOptions): Promise<void>;
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
  /** Boot probe: throw when the backing store is not writable. */
  healthcheck(): Promise<void>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Content-addressed key layout: `ws/<workspaceId>/<ab>/<sha256>`. The sha is
 * validated against a strict hex pattern, so a key can never smuggle path
 * traversal; the two-char shard keeps directories small at the 200GB target.
 */
export function blobKey(workspaceId: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error('invalid sha256');
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error('invalid workspace id');
  return `ws/${workspaceId}/${sha256.slice(0, 2)}/${sha256}`;
}
