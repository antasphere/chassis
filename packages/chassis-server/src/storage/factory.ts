import { join } from 'node:path';
import type { Env } from '../env.js';
import type { StorageDriver } from './driver.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';

export function createStorageDriver(
  env: Pick<
    Env,
    | 'STORAGE_DRIVER'
    | 'DATA_DIR'
    | 'S3_BUCKET'
    | 'S3_REGION'
    | 'S3_ENDPOINT'
    | 'S3_ACCESS_KEY_ID'
    | 'S3_SECRET_ACCESS_KEY'
    | 'S3_FORCE_PATH_STYLE'
  >
): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    }
    return new S3StorageDriver({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE
    });
  }
  return new LocalStorageDriver(join(env.DATA_DIR, 'storage'));
}
