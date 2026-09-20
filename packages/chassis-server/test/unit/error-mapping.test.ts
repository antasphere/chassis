import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pino } from 'pino';
import { createApp, postgresErrorCode } from '@antasphere/chassis-server';
import { createRuntimeState } from '@antasphere/chassis-server/util';

/**
 * SL-B4 / SL-B5: a NUL byte reaching Postgres (SQLSTATE 22021) and a
 * stringify-breaking payload (RangeError) both surfaced as anonymous 500s —
 * and the 22021 path logged the failing statement together with its bound
 * parameters. Both are client input; both must answer 4xx, quietly.
 */
class PgError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

async function appThrowing(error: unknown) {
  const lines: string[] = [];
  const logger = pino({ level: 'error' }, { write: (chunk: string) => lines.push(chunk) });
  const api = new OpenAPIHono();
  api.get('/boom', () => {
    throw error;
  });
  const app = await createApp({
    logger,
    state: createRuntimeState(),
    publicDir: '/nonexistent-public-dir',
    displayName: 'Things',
    api
  });
  return { app, lines };
}

describe('postgresErrorCode', () => {
  it('reads the SQLSTATE off a driver error and nothing else', () => {
    expect(postgresErrorCode(new PgError('22021', 'invalid byte sequence'))).toBe('22021');
    expect(postgresErrorCode(new Error('plain'))).toBeUndefined();
    expect(postgresErrorCode(null)).toBeUndefined();
    expect(postgresErrorCode({ code: 42 })).toBeUndefined();
  });
});

describe('app.onError client-input mappings', () => {
  it('maps Postgres 22021 (NUL byte in text) to a quiet 400', async () => {
    const { app, lines } = await appThrowing(
      new PgError('22021', 'invalid byte sequence for encoding "UTF8": 0x00')
    );
    const res = await app.request('/api/v1/boom');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_characters' } });
    // The pg error object carries the statement AND its bound parameters.
    expect(lines.join('')).toBe('');
  });

  it('maps 22P05 (untranslatable character) the same way', async () => {
    const { app } = await appThrowing(new PgError('22P05', 'untranslatable character'));
    expect((await app.request('/api/v1/boom')).status).toBe(400);
  });

  it('maps a stringify stack overflow to 400, not 500', async () => {
    const { app } = await appThrowing(new RangeError('Maximum call stack size exceeded'));
    const res = await app.request('/api/v1/boom');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'payload_too_deep' } });
  });

  it('maps "Invalid string length" the same way', async () => {
    const { app } = await appThrowing(new RangeError('Invalid string length'));
    expect((await app.request('/api/v1/boom')).status).toBe(400);
  });

  it('keeps a genuine server fault a logged 500', async () => {
    const { app, lines } = await appThrowing(new Error('database is on fire'));
    const res = await app.request('/api/v1/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal' } });
    expect(lines.join('')).toContain('unhandled error');
  });

  it('keeps an unrelated RangeError a 500 — narrow on the two known messages', async () => {
    const { app } = await appThrowing(new RangeError('toFixed() digits argument must be between 0 and 100'));
    expect((await app.request('/api/v1/boom')).status).toBe(500);
  });
});
