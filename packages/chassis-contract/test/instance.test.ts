import { describe, expect, it } from 'vitest';
import { instanceInfoSchema } from '../src/index.js';

/** Discovery (`GET /api/v1/instance`): the docs address of PRDCT-4110, and its absence on an older instance. */
describe('instanceInfoSchema', () => {
  const info = {
    name: 'Your Tool',
    instanceId: null,
    edition: 'oss',
    version: '1.9.0',
    apiVersion: 'v1' as const,
    setupRequired: true,
    auth: { methods: ['password'], passwordReset: true, emailChange: true, twoFactor: true },
    features: { mcp: true, oauth: true, files: true }
  };

  it('carries the docs address, the tool section of the docs site the operator named', () => {
    const parsed = instanceInfoSchema.parse({
      ...info,
      docs: { url: 'https://handbook.antasphere.com/yourtool' }
    });
    expect(parsed.docs).toEqual({ url: 'https://handbook.antasphere.com/yourtool' });
  });

  it('parses an instance from before 1.9.0, which names no docs address', () => {
    expect(instanceInfoSchema.parse(info).docs).toBeUndefined();
  });

  it('refuses a docs address that is not a URL', () => {
    expect(instanceInfoSchema.safeParse({ ...info, docs: { url: 'yourtool' } }).success).toBe(false);
    expect(instanceInfoSchema.safeParse({ ...info, docs: {} }).success).toBe(false);
  });
});
