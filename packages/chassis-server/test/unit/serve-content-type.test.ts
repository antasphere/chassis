import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { serveBlob } from '@antasphere/chassis-server/files';
import type { StorageDriver } from '@antasphere/chassis-server/storage';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * PLT-5 backstop: versions are immutable, so a manifest `contentType`
 * committed before the contract's media-type gate (or through any path that
 * skips it) lives forever. Serving it verbatim made the `Headers` constructor
 * throw — a permanent anonymous 500 on that asset. The serve helper degrades
 * an invalid stored value to application/octet-stream instead.
 */

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {}
} as unknown as Logger;

function storageWith(bytes: Buffer): StorageDriver {
  return {
    name: 'test',
    exists: async () => true,
    getStream: async () => Readable.from([bytes]),
    put: async () => {
      throw new Error('unused');
    },
    delete: async () => {
      throw new Error('unused');
    }
  } as unknown as StorageDriver;
}

async function serve(contentType: string): Promise<Response> {
  const bytes = Buffer.from('hello');
  const app = new Hono();
  app.get('/blob', (c) =>
    serveBlob(c, {
      storage: storageWith(bytes),
      logger: noopLogger,
      workspaceId: '00000000-0000-4000-8000-000000000000',
      sha256: 'a'.repeat(64),
      sizeBytes: bytes.length,
      contentType,
      filename: 'file.bin',
      headOnly: false
    })
  );
  return app.request('/blob');
}

describe('serveBlob content-type sanitization (PLT-5)', () => {
  it('serves a valid stored media type verbatim', async () => {
    const res = await serve('text/plain; charset=utf-8');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('degrades an invalid stored value to octet-stream instead of throwing', async () => {
    // Includes a value that passes the RFC 7231 grammar but carries a code
    // point above Latin-1 in a quoted parameter (charset="€") — the real
    // ByteString trap the serve backstop must also catch, not just the
    // grammar violations (PLT-5, verifier round-2 coverage note).
    for (const bad of ['text/html; charset="€"', 'text/héml', 'not a type', 'text/html\r\nx-evil: 1']) {
      const res = await serve(bad);
      expect(res.status, bad).toBe(200);
      expect(res.headers.get('content-type'), bad).toBe('application/octet-stream');
      expect(res.headers.get('x-evil')).toBeNull();
    }
  });
});
