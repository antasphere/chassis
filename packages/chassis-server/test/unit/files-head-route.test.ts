import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Readable } from 'node:stream';
import { pino } from 'pino';
import type { Principal } from '@antasphere/chassis-contract';
import { registerFileRoutes } from '@antasphere/chassis-server/api';
import type { FileService } from '@antasphere/chassis-server/files';
import type { PlatformRegistry } from '@antasphere/chassis-server/platform';
import type { StorageDriver } from '@antasphere/chassis-server/storage';

/**
 * PLT-39, the half that actually matters: the REGISTERED ROUTE must answer a
 * HEAD with metadata and no body.
 *
 * `head-rewrite.test.ts` pins Hono's rewrite and greps for the dead
 * `api.on('HEAD', …)` idiom, but neither of those touches `api/files.ts` — a
 * mutation that hardcodes `headOnly` to `false` leaves both of them green
 * while every HEAD silently streams the whole blob again. This test drives the
 * real handler, so the `c.req.method === 'HEAD'` derivation is covered by
 * something that fails when it is removed.
 */
const WORKSPACE = '11111111-2222-3333-4444-555555555555';
const SHA = 'a'.repeat(64);
const BODY = 'hello head';

const principal = {
  userId: 'u1',
  workspaceId: WORKSPACE,
  role: 'owner',
  origin: 'member',
  via: 'session',
  scopes: null
} as unknown as Principal;

function app(): OpenAPIHono {
  const api = new OpenAPIHono();
  api.use('*', async (c, next) => {
    c.set('principal', principal);
    return next();
  });

  const storage: StorageDriver = {
    name: 'local',
    put: async () => {},
    getStream: async () => Readable.from([Buffer.from(BODY)]),
    exists: async () => true,
    head: async () => ({ sizeBytes: BODY.length }),
    delete: async () => {},
    healthcheck: async () => {}
  } as unknown as StorageDriver;

  const service = {
    get: async () => ({
      id: '99999999-8888-7777-6666-555555555555',
      workspaceId: WORKSPACE,
      sha256: SHA,
      sizeBytes: BODY.length,
      contentType: 'text/plain',
      originalName: 'head-probe.txt',
      createdBy: 'u1',
      createdAt: new Date()
    })
  } as unknown as FileService;

  registerFileRoutes(api, {
    service,
    storage,
    registry: { entitlements: { check: async () => ({ allowed: true }) } } as unknown as PlatformRegistry,
    env: { MAX_FILE_SIZE_MB: 100, EDITION: 'oss', APP_VERSION: 'test' },
    logger: pino({ level: 'silent' }),
    instanceId: async () => 'inst',
    // PRDCT-1343 made per-deck scoping a required dep. This suite exercises the
    // HEAD route shape (PLT-39), not authorization, so it takes the operator
    // view: undefined = unscoped, exactly what an admin/owner principal gets.
    blobReadScope: () => undefined,
    blobInUse: async () => false,
    fileInUse: {
      message: 'This file is referenced by a thing',
      openApi: 'file_in_use: referenced by a thing'
    }
  });
  return api;
}

const CONTENT_PATH = '/files/99999999-8888-7777-6666-555555555555/content';

describe('GET/HEAD /files/:id/content (one registration, verb read off the request)', () => {
  it('answers HEAD with the metadata headers and NO body', async () => {
    const res = await app().request(CONTENT_PATH, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(BODY.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe(`"${SHA}"`);
    // The whole point: no bytes were read out of storage for a HEAD.
    expect(await res.text()).toBe('');
  });

  it('still streams the bytes on GET — the shared handler did not go headOnly for everyone', async () => {
    const res = await app().request(CONTENT_PATH);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  it('never opens the blob stream for a HEAD', async () => {
    let streamOpened = 0;
    const api = new OpenAPIHono();
    api.use('*', async (c, next) => {
      c.set('principal', principal);
      return next();
    });
    registerFileRoutes(api, {
      service: {
        get: async () => ({
          id: '99999999-8888-7777-6666-555555555555',
          workspaceId: WORKSPACE,
          sha256: SHA,
          sizeBytes: BODY.length,
          contentType: 'text/plain',
          originalName: 'head-probe.txt',
          createdBy: 'u1',
          createdAt: new Date()
        })
      } as unknown as FileService,
      storage: {
        name: 'local',
        exists: async () => true,
        getStream: async () => {
          streamOpened++;
          return Readable.from([Buffer.from(BODY)]);
        }
      } as unknown as StorageDriver,
      registry: { entitlements: { check: async () => ({ allowed: true }) } } as unknown as PlatformRegistry,
      env: { MAX_FILE_SIZE_MB: 100, EDITION: 'oss', APP_VERSION: 'test' },
      logger: pino({ level: 'silent' }),
      instanceId: async () => 'inst',
      // PRDCT-1343 made per-deck scoping a required dep. This suite exercises the
      // HEAD route shape (PLT-39), not authorization, so it takes the operator
      // view: undefined = unscoped, exactly what an admin/owner principal gets.
      blobReadScope: () => undefined,
      blobInUse: async () => false,
      fileInUse: {
        message: 'This file is referenced by a thing',
        openApi: 'file_in_use: referenced by a thing'
      }
    });

    await api.request(CONTENT_PATH, { method: 'HEAD' });
    expect(streamOpened).toBe(0);
    const get = await api.request(CONTENT_PATH);
    await get.text();
    expect(streamOpened).toBe(1);
  });
});
