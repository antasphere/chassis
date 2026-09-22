import { describe, expect, it } from 'vitest';
import {
  declareRouteEntitlements,
  declaredContentLength,
  declaredCredits
} from '@antasphere/chassis-contract';
import { declaredLimitRouteMatcher } from '../../src/api/create-api.js';

/**
 * The size cap's deferral is keyed on the routes that declare a plan limit
 * (PRDCT-2632): the matcher reads the tool's declarations as Hono registers
 * them under /api/v1. And the price an action declares is what a test can
 * compute from the declaration (PRDCT-2627).
 */
describe('declaredLimitRouteMatcher', () => {
  const routes = declareRouteEntitlements([
    {
      route: { method: 'post', path: '/things/assets' },
      limit: { key: 'things.maxBytes', value: declaredContentLength }
    },
    {
      route: { method: 'put', path: '/things/{id}/cover' },
      meter: { key: 'things.cover', unit: 'bytes' },
      limit: { key: 'things.maxBytes', value: declaredContentLength }
    },
    { route: { method: 'post', path: '/things' }, meter: { key: 'things.make', unit: 'call' } }
  ]);
  const matches = declaredLimitRouteMatcher(routes);

  it('matches a declared-limit route by method and path, params as one segment', () => {
    expect(matches('POST', '/api/v1/things/assets')).toBe(true);
    expect(matches('post', '/api/v1/things/assets')).toBe(true);
    expect(matches('PUT', '/api/v1/things/abc-123/cover')).toBe(true);
  });

  it('never matches a route without a limit, another method, a prefix or a longer path', () => {
    expect(matches('POST', '/api/v1/things')).toBe(false); // metered, no limit
    expect(matches('GET', '/api/v1/things/assets')).toBe(false);
    expect(matches('POST', '/api/v1/things/assets/x')).toBe(false);
    expect(matches('POST', '/things/assets')).toBe(false);
    expect(matches('PUT', '/api/v1/things/a/b/cover')).toBe(false);
  });
});

describe('declaredCredits', () => {
  it('prices a quantity from the declaration: credits per `per` units, exact', () => {
    const MB = 1024 * 1024;
    const upload = { creditsPerUnit: 5, unit: 'bytes', per: MB };
    expect(declaredCredits(upload, 20 * MB)).toBe(100);
    expect(declaredCredits(upload, 43)).toBeCloseTo(0.000205, 6);
    expect(declaredCredits({ creditsPerUnit: 50 }, 1)).toBe(50);
  });
});
