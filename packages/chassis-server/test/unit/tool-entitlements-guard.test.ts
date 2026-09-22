import { describe, expect, it } from 'vitest';
import { declareRouteEntitlements } from '@antasphere/chassis-contract';
import { assertToolEntitlements, EMPTY_TOOL_ENTITLEMENTS } from '../../src/entitlements/index.js';

/**
 * The boot-time guard of the `entitlements` slot (slot 22) and the
 * contract's registry builder: a route that meters an action the price book
 * does not know, meters it in another unit, checks a limit no tier values
 * or needs a feature nobody declared stops the boot naming the route; a
 * route declared twice, or declaring nothing, fails at module load.
 */

const base = () => ({
  actions: [{ key: 'things.make', creditsPerUnit: 1, unit: 'call', label: 'Make' }],
  limits: { 'things.max': { oss: null, free: 2, pro: null } },
  features: { premium: { free: false, pro: true } }
});

describe('declareRouteEntitlements', () => {
  it('refuses a route declared twice, and a declaration that declares nothing', () => {
    expect(() =>
      declareRouteEntitlements([
        { route: { method: 'post', path: '/things' }, meter: { key: 'a', unit: 'call' } },
        { route: { method: 'POST', path: '/things' }, meter: { key: 'b', unit: 'call' } }
      ])
    ).toThrow(/declared twice: POST \/things/);
    expect(() => declareRouteEntitlements([{ route: { method: 'get', path: '/things' } }])).toThrow(
      /declares nothing/
    );
  });
});

describe('assertToolEntitlements', () => {
  it('accepts the empty slot and a coherent one', () => {
    expect(() => assertToolEntitlements(EMPTY_TOOL_ENTITLEMENTS)).not.toThrow();
    expect(() =>
      assertToolEntitlements({
        ...base(),
        routes: declareRouteEntitlements([
          {
            route: { method: 'post', path: '/things' },
            meter: { key: 'things.make', unit: 'call' },
            limit: { key: 'things.max', value: () => 1 },
            feature: 'premium'
          }
        ])
      })
    ).not.toThrow();
  });

  it('refuses a metered action the price book does not declare, and a unit that differs', () => {
    expect(() =>
      assertToolEntitlements({
        ...base(),
        routes: declareRouteEntitlements([
          { route: { method: 'post', path: '/x' }, meter: { key: 'nope', unit: 'call' } }
        ])
      })
    ).toThrow(/POST \/x meters "nope"/);
    expect(() =>
      assertToolEntitlements({
        ...base(),
        routes: declareRouteEntitlements([
          { route: { method: 'post', path: '/x' }, meter: { key: 'things.make', unit: 'bytes' } }
        ])
      })
    ).toThrow(/in bytes, the action is priced per call/);
  });

  it('refuses a limit or a feature no tier declares, and an action declared twice', () => {
    expect(() =>
      assertToolEntitlements({
        ...base(),
        routes: declareRouteEntitlements([
          { route: { method: 'post', path: '/x' }, limit: { key: 'ghost', value: () => 1 } }
        ])
      })
    ).toThrow(/checks the limit "ghost"/);
    expect(() =>
      assertToolEntitlements({
        ...base(),
        routes: declareRouteEntitlements([{ route: { method: 'post', path: '/x' }, feature: 'ghost' }])
      })
    ).toThrow(/needs the feature "ghost"/);
    expect(() =>
      assertToolEntitlements({
        ...base(),
        actions: [...base().actions, ...base().actions],
        routes: declareRouteEntitlements([])
      })
    ).toThrow(/declares things.make twice/);
  });
});
