import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from '@antasphere/chassis-server/storage';

/**
 * The local driver must fail a missing blob at the getStream() await — never
 * as a late 'error' event on an already-returned stream. The content route
 * commits its status line right after that await, so a lazy open turned a
 * missing blob into a 200 + truncated body (scale drill, I2).
 */
describe('LocalStorageDriver.getStream', () => {
  let root: string;
  let driver: LocalStorageDriver;
  const KEY = 'ws/ab/cd/blob';
  const PAYLOAD = 'The quick brown fox jumps over the lazy dog';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-local-test-'));
    driver = new LocalStorageDriver(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects at the await (ENOENT) when the blob is missing', async () => {
    await expect(driver.getStream('ws/ab/cd/missing')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('streams a stored blob back, in full and by range', async () => {
    await driver.put(KEY, Readable.from(PAYLOAD), {
      contentType: 'text/plain',
      sizeBytes: PAYLOAD.length
    });
    expect(await driver.exists(KEY)).toBe(true);

    const full = await driver.getStream(KEY);
    expect(await text(full)).toBe(PAYLOAD);

    const slice = await driver.getStream(KEY, { start: 4, end: 8 });
    expect(await text(slice)).toBe('quick');
  });

  it('rejects at the await after the blob is deleted underneath a live key', async () => {
    await driver.delete(KEY);
    expect(await driver.exists(KEY)).toBe(false);
    await expect(driver.getStream(KEY)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
