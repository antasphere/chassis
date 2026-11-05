import { describe, expect, it, vi } from 'vitest';
import type { RateLimiterMemory } from 'rate-limiter-flexible';
import { buildEnvSchema } from '../../src/env.js';
import { createRateLimiters } from '../../src/middleware/rate-limit.js';
import type { Logger } from '../../src/logger.js';

/**
 * The docs source's configuration (PRDCT-4098, verifier round 1, F4 and F6):
 * the token's minimum length, the blank-means-unset rule, and the wall's own
 * bucket, distinct from the connection door's.
 */

const schema = buildEnvSchema({ version: '0.0.0-test' });
const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('DOCS_SOURCE_TOKEN', () => {
  it('needs at least 32 characters', () => {
    const short = schema.safeParse({ ...BASE, DOCS_SOURCE_TOKEN: 'a'.repeat(31) });
    expect(short.success).toBe(false);
    if (!short.success)
      expect(short.error.issues.map((i) => i.path.join('.'))).toContain('DOCS_SOURCE_TOKEN');
    const ok = schema.parse({ ...BASE, DOCS_SOURCE_TOKEN: 'a'.repeat(32) });
    expect(ok.DOCS_SOURCE_TOKEN).toBe('a'.repeat(32));
  });

  it('blank or absent means off', () => {
    expect(schema.parse({ ...BASE, DOCS_SOURCE_TOKEN: '' }).DOCS_SOURCE_TOKEN).toBeUndefined();
    expect(schema.parse({ ...BASE, DOCS_SOURCE_TOKEN: '   ' }).DOCS_SOURCE_TOKEN).toBeUndefined();
    expect(schema.parse(BASE).DOCS_SOURCE_TOKEN).toBeUndefined();
  });

  it('DOCS_DIR is a plain optional path, blank means unset', () => {
    expect(schema.parse({ ...BASE, DOCS_DIR: '' }).DOCS_DIR).toBeUndefined();
    expect(schema.parse({ ...BASE, DOCS_DIR: '/app/docs' }).DOCS_DIR).toBe('/app/docs');
  });
});

describe('the docs source bucket', () => {
  it('is the chassis bucket named docsSource, its own key prefix, apart from the connection door', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const limiters = await createRateLimiters({ REDIS_URL: undefined }, logger);
    const docs = limiters.docsSource as RateLimiterMemory;
    const door = limiters.connectionDoor as RateLimiterMemory;
    expect(docs.keyPrefix).toBe('rl:docs-source');
    expect(docs.keyPrefix).not.toBe(door.keyPrefix);
    expect(docs).not.toBe(door);
    // A tool's bucket may not take the chassis bucket's name: the type refuses it, and the
    // factory builds the tool's after the chassis's so it never overwrites one.
    const withTool = await createRateLimiters({ REDIS_URL: undefined }, logger, {
      mine: { prefix: 'tool-mine', points: 5, durationSec: 60 }
    });
    expect((withTool.docsSource as RateLimiterMemory).keyPrefix).toBe('rl:docs-source');
    expect((withTool.mine as RateLimiterMemory).keyPrefix).toBe('rl:tool-mine');
  });
});
