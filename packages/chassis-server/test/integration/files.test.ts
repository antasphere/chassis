import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * Files module end-to-end (exit criterion 10): streamed upload, Range/206
 * download, safe-serving headers — against the local driver, then the same
 * core flow against MinIO through the s3 driver.
 */

const OWNER = { email: 'owner@files.test', name: 'Files Owner', password: 'files-owner-password-1' };
const PAYLOAD = 'The quick brown fox jumps over the lazy dog'; // 43 bytes

let container: StartedPostgreSqlContainer;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function setupApp(app: TestApp): Promise<string> {
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Files', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  return extractCookie(signIn);
}

async function uploadText(app: TestApp, cookie: string, name: string, text: string, contentType: string) {
  return app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': contentType, cookie },
    body: text
  });
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('local driver', () => {
  let app: TestApp;
  let cookie: string;
  let fileId: string;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'files_local'), { MAX_FILE_SIZE_MB: '1' });
    cookie = await setupApp(app);
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('uploads streamed bytes and returns the content address', async () => {
    const res = await uploadText(app, cookie, 'fox.txt', PAYLOAD, 'text/plain');
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.file.sizeBytes).toBe(43);
    expect(body.deduplicated).toBe(false);
    fileId = body.file.id;
  });

  it('re-uploading identical bytes deduplicates to the same row', async () => {
    const res = await uploadText(app, cookie, 'fox-again.txt', PAYLOAD, 'text/plain');
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.deduplicated).toBe(true);
    expect(body.file.id).toBe(fileId);
  });

  it('downloads in full with immutable caching and nosniff', async () => {
    const res = await app.app.request(`/api/v1/files/${fileId}/content`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAYLOAD);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/); // text/plain is passive
  });

  it('serves an exact 206 slice with Content-Range (exit criterion 10)', async () => {
    const res = await app.app.request(`/api/v1/files/${fileId}/content`, {
      headers: { cookie, range: 'bytes=4-8' }
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('quick');
    expect(res.headers.get('content-range')).toBe('bytes 4-8/43');
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('suffix and open ranges work (video-seek shapes)', async () => {
    const tail = await app.app.request(`/api/v1/files/${fileId}/content`, {
      headers: { cookie, range: 'bytes=-3' }
    });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe('dog');

    const open = await app.app.request(`/api/v1/files/${fileId}/content`, {
      headers: { cookie, range: 'bytes=40-' }
    });
    expect(open.status).toBe(206);
    expect(await open.text()).toBe('dog');
  });

  it('rejects unsatisfiable and multi-range with 416 + bytes */size', async () => {
    for (const range of ['bytes=100-', 'bytes=0-1,5-9']) {
      const res = await app.app.request(`/api/v1/files/${fileId}/content`, {
        headers: { cookie, range }
      });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */43');
    }
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await app.app.request(`/api/v1/files/${fileId}/content`, {
      method: 'HEAD',
      headers: { cookie }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('43');
    expect(await res.text()).toBe('');
  });

  it('serves 304 on a matching ETag (content-addressed: hash is the tag)', async () => {
    const first = await app.app.request(`/api/v1/files/${fileId}/content`, { headers: { cookie } });
    const etag = first.headers.get('etag')!;
    const res = await app.app.request(`/api/v1/files/${fileId}/content`, {
      headers: { cookie, 'if-none-match': etag }
    });
    expect(res.status).toBe(304);
  });

  it('forces attachment for browser-renderable uploads (html)', async () => {
    const up = await uploadText(app, cookie, 'evil.html', '<script>alert(1)</script>', 'text/html');
    const body = await readJson(up);
    const res = await app.app.request(`/api/v1/files/${body.file.id}/content`, { headers: { cookie } });
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('enforces the size cap mid-stream with 413', async () => {
    // Test app runs with MAX_FILE_SIZE_MB=1; send ~1.5MB without content-length honesty.
    const big = 'x'.repeat(1_500_000);
    const res = await uploadText(app, cookie, 'big.bin', big, 'application/octet-stream');
    expect(res.status).toBe(413);
  });

  it('scopes machine access: a read-scope key can stream, cannot upload', async () => {
    const mint = await app.app.request('/api/v1/api-keys', {
      ...json({ name: 'files-ro', scopes: [host.scopes.read] }),
      headers: { 'content-type': 'application/json', cookie }
    });
    const { key } = await readJson(mint);

    const read = await app.app.request(`/api/v1/files/${fileId}/content`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(read.status).toBe(200);

    const write = await app.app.request('/api/v1/files?name=x.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${key}` },
      body: 'nope'
    });
    expect(write.status).toBe(403);
  });

  it('delete removes metadata and the blob', async () => {
    const up = await uploadText(app, cookie, 'temp.txt', 'delete me', 'text/plain');
    const { file } = await readJson(up);
    const del = await app.app.request(`/api/v1/files/${file.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(del.status).toBe(200);
    const gone = await app.app.request(`/api/v1/files/${file.id}/content`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });

  it('answers a clean 404 when the metadata row exists but the blob is unreachable (never a truncated 200)', async () => {
    // The cross-replica local-storage situation (scale drill, I2): the shared
    // Postgres row exists, but THIS replica's private disk has no blob.
    // Simulated by deleting the blob file underneath a live row.
    const up = await uploadText(
      app,
      cookie,
      'ghost.txt',
      'bytes that vanish from this replica',
      'text/plain'
    );
    const { file } = await readJson(up);
    const { rows } = await app.db.pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM files WHERE id = $1',
      [file.id]
    );
    const blobPath = join(
      app.env.DATA_DIR,
      'storage',
      'blobs',
      'ws',
      rows[0]!.workspace_id,
      file.sha256.slice(0, 2),
      file.sha256
    );
    await rm(blobPath);

    // GET: a clean pre-body 404 with the error envelope — not 200 + headers
    // followed by a dead stream (the silent truncation the drill surfaced).
    const res = await app.app.request(`/api/v1/files/${file.id}/content`, { headers: { cookie } });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('not_found');

    // HEAD and Range take the same guard: no 2xx may promise unreachable bytes.
    const head = await app.app.request(`/api/v1/files/${file.id}/content`, {
      method: 'HEAD',
      headers: { cookie }
    });
    expect(head.status).toBe(404);
    const ranged = await app.app.request(`/api/v1/files/${file.id}/content`, {
      headers: { cookie, range: 'bytes=0-4' }
    });
    expect(ranged.status).toBe(404);

    // The metadata endpoint still serves the row — only the content is 404.
    const meta = await app.app.request(`/api/v1/files/${file.id}`, { headers: { cookie } });
    expect(meta.status).toBe(200);
  });
});

describe('s3 driver (MinIO)', () => {
  let minio: StartedTestContainer;
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    // MinIO's own registry, pinned: the Docker Hub repository `minio/minio` is
    // gone (404), so `:latest` there only resolved from a machine's local cache.
    minio = await new GenericContainer('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withExposedPorts(9000)
      .start();

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    // Create the bucket via the S3 API directly.
    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }
    });
    await client.send(new CreateBucketCommand({ Bucket: 'chassis-test' }));

    app = await createTestApp(await createDatabase(container, 'files_s3'), {
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'chassis-test',
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: 'minioadmin',
      S3_SECRET_ACCESS_KEY: 'minioadmin',
      S3_FORCE_PATH_STYLE: 'true'
    });
    cookie = await setupApp(app);
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    await minio?.stop();
  });

  it('uploads and Range-streams through MinIO identically', async () => {
    const up = await uploadText(app, cookie, 'fox-s3.txt', PAYLOAD, 'text/plain');
    expect(up.status).toBe(201);
    const { file } = await readJson(up);

    const res = await app.app.request(`/api/v1/files/${file.id}/content`, {
      headers: { cookie, range: 'bytes=4-8' }
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('quick');
    expect(res.headers.get('content-range')).toBe('bytes 4-8/43');

    const full = await app.app.request(`/api/v1/files/${file.id}/content`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(await full.text()).toBe(PAYLOAD);
  });
});
