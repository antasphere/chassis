import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class FileTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`file exceeds the ${limitBytes}-byte limit`);
  }
}

export interface SpooledUpload {
  /** The spool file, to stream into the driver. The caller MUST `cleanup()` in a finally. */
  path: string;
  sizeBytes: number;
  sha256: string;
  cleanup: () => Promise<void>;
}

/**
 * Spool a request body to `spoolDir/<uuid>` while sha256 + size accumulate
 * (never buffered in memory), the size cap enforced MID-STREAM — a body that
 * lies about its Content-Length is cut at `maxBytes + 1`, and the partial
 * spool file is removed before the error surfaces. Shared by the workspace
 * file upload (files/service.ts) and the form file upload (forms/uploads.ts).
 */
export async function spoolUpload(
  body: Readable,
  maxBytes: number,
  spoolDir: string
): Promise<SpooledUpload> {
  await mkdir(spoolDir, { recursive: true });
  const path = join(spoolDir, randomUUID());
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new FileTooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    }
  });
  const cleanup = () => rm(path, { force: true });
  try {
    await pipeline(body, meter, createWriteStream(path, { flags: 'wx' }));
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { path, sizeBytes: size, sha256: hash.digest('hex'), cleanup };
}
