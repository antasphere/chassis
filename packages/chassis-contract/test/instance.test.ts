import { describe, expect, it } from 'vitest';
import { instanceInfoSchema } from '../src/index.js';

/** Discovery (`GET /api/v1/instance`): the docs address of PRDCT-4110, the hub a cloud site names, and their absence on an older instance. */
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

  it('carries the hub a cloud site federates to, in auth', () => {
    const parsed = instanceInfoSchema.parse({
      ...info,
      edition: 'cloud',
      auth: { ...info.auth, hub: 'https://hub.example.com' }
    });
    expect(parsed.auth.hub).toBe('https://hub.example.com');
  });

  it('parses an instance that names no hub: the oss edition, or a site from before it', () => {
    expect(instanceInfoSchema.parse(info).auth.hub).toBeUndefined();
  });

  it('refuses a docs address that is not a URL', () => {
    expect(instanceInfoSchema.safeParse({ ...info, docs: { url: 'yourtool' } }).success).toBe(false);
    expect(instanceInfoSchema.safeParse({ ...info, docs: {} }).success).toBe(false);
  });
});
