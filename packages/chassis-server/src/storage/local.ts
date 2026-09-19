import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ByteRange, HeadResult, PutOptions, StorageDriver } from './driver.js';

/** A missing file — the only fs error head()/delete() treats as "absent". */
function isEnoent(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT';
}

/**
 * Filesystem driver: blobs under `<root>/blobs`, writes staged in
 * `<root>/.tmp` and renamed into place (atomic on one filesystem — both live
 * under the same mount). Single-replica only, which is Profile A.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly blobRoot: string;
  private readonly tmpRoot: string;

  constructor(root: string) {
    this.blobRoot = join(root, 'blobs');
    this.tmpRoot = join(root, '.tmp');
  }

  private pathFor(key: string): string {
    const path = normalize(join(this.blobRoot, key));
    if (!path.startsWith(this.blobRoot + sep)) throw new Error('key escapes storage root');
    return path;
  }

  async put(key: string, data: Readable, _opts: PutOptions): Promise<void> {
    const finalPath = this.pathFor(key);
    const tmpPath = join(this.tmpRoot, randomUUID());
    await mkdir(this.tmpRoot, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await pipeline(data, createWriteStream(tmpPath, { flags: 'wx' }));
      await rename(tmpPath, finalPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.pathFor(key);
    // Open eagerly: a missing blob must reject HERE, at the await — before
    // the caller commits response headers — not as a late 'error' event on a
    // lazily-opening createReadStream after a 200 is already on the wire
    // (the s3 driver's GetObject await fails eagerly too; this matches it).
    const handle = await open(path, 'r');
    // autoClose (default) hands fd ownership to the stream: closed on end,
    // error, and destroy — including the route's client-abort destroy().
    return handle.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const s = await stat(this.pathFor(key));
      return { sizeBytes: s.size };
    } catch (err) {
      // A missing file is `null`; any other stat error (permissions, I/O)
      // propagates rather than masquerading as "absent".
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // Deleting an already-gone blob is a no-op; real errors propagate and the
    // caller decides whether they are fatal.
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  async healthcheck(): Promise<void> {
    await mkdir(this.tmpRoot, { recursive: true });
    const probe = join(this.tmpRoot, `.healthcheck-${randomUUID()}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
  }
}
