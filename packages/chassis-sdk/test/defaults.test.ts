import { describe, expect, it } from 'vitest';
import { DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../src/index.js';

/**
 * The default deadlines, as literals (PRDCT-2530, verifier M19). The timeout
 * tests compare a call's signal against these same constants, so a changed
 * value moves with them; a number a person waits on is pinned by its value.
 */
describe('chassis client default deadlines', () => {
  it('30 s a request, 10 min a download', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBe(600_000);
  });
});
