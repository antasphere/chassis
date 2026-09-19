import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { randomUUID } from 'node:crypto';
import type { ByteRange, HeadResult, PutOptions, StorageDriver } from './driver.js';

/** A missing object — the only S3 error head()/exists() treats as "absent". */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export interface S3DriverConfig {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for MinIO and most S3-compatibles. */
  forcePathStyle: boolean;
}

/**
 * S3-compatible driver: MinIO self-hosted, AWS S3, Cloudflare R2 (and any
 * endpoint speaking the S3 API). Multi-replica safe — this is the Profile B
 * storage driver.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3DriverConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  async put(key: string, data: Readable, opts: PutOptions): Promise<void> {
    // lib-storage handles multipart for large bodies and backpressure.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: opts.contentType,
        ContentLength: opts.sizeBytes
      }
    });
    await upload.done();
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {})
      })
    );
    if (!res.Body) throw new Error('empty S3 response body');
    return res.Body as Readable;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0 };
    } catch (err) {
      // Only a genuine miss is `null`. A transport/permission error must
      // propagate — swallowing it made a broken bucket look like an empty one,
      // and exists() (upload dedup) would then re-put or 400 misleadingly.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject is idempotent (no error on a missing key); a real
    // failure propagates and the caller decides whether it is fatal.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async healthcheck(): Promise<void> {
    const probe = `.healthcheck/${randomUUID()}`;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: probe, Body: 'ok', ContentLength: 2 })
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: probe }));
  }
}
