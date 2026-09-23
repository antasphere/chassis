import { describe, expect, it } from 'vitest';
import { declareRouteEntitlements } from '@antasphere/chassis-contract';
import {
  assertToolEntitlements,
  EMPTY_TOOL_ENTITLEMENTS,
  type ToolEntitlementDeclaration
} from '../../src/entitlements/index.js';

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

describe('assertToolEntitlements: the shape of the lists and the instance ceiling (PRDCT-2653)', () => {
  const MB = 1024 * 1024;
  const withLimits = (limits: unknown): ToolEntitlementDeclaration => ({
    ...base(),
    limits: limits as ToolEntitlementDeclaration['limits'],
    routes: declareRouteEntitlements([])
  });

  it('refuses a limit key with a missing tier, naming its path', () => {
    expect(() => assertToolEntitlements(withLimits({ 'things.max': { oss: 10, free: 10 } }))).toThrow(
      /entitlements declaration is malformed: limits\.things\.max\.pro: /
    );
  });

  it('refuses a feature with a missing tier, naming its path', () => {
    expect(() =>
      assertToolEntitlements({
        ...base(),
        features: { premium: { free: false } } as unknown as ToolEntitlementDeclaration['features'],
        routes: declareRouteEntitlements([])
      })
    ).toThrow(/entitlements declaration is malformed: features\.premium\.pro: /);
  });

  it('refuses a tier above a numeric oss, with the ceiling message', () => {
    expect(() =>
      assertToolEntitlements(withLimits({ 'files.maxBytes': { oss: 100, free: 20, pro: 500 } }))
    ).toThrow(
      'tool definition: entitlements.limits.files.maxBytes.pro (500) is above the instance ceiling (oss 100): a plan value the instance cannot serve must not be advertised'
    );
  });

  it('refuses an unlimited (null) tier under a numeric oss', () => {
    expect(() =>
      assertToolEntitlements(withLimits({ 'files.maxBytes': { oss: 100, free: null, pro: 100 } }))
    ).toThrow(
      'tool definition: entitlements.limits.files.maxBytes.free (null) is above the instance ceiling (oss 100): a plan value the instance cannot serve must not be advertised'
    );
  });

  it('accepts any tier value under a null oss (no ceiling)', () => {
    expect(() =>
      assertToolEntitlements(withLimits({ 'workspace.members': { oss: null, free: 3, pro: null } }))
    ).not.toThrow();
    expect(() =>
      assertToolEntitlements(withLimits({ 'links.perDeck': { oss: null, free: 10, pro: 1e9 } }))
    ).not.toThrow();
  });

  for (const cap of [100 * MB, 500 * MB]) {
    it(`accepts the two real declarations' shapes at cap = ${cap / MB} MB`, () => {
      // packages/chassis-server/test/host/minimal-tool.ts
      expect(() =>
        assertToolEntitlements(
          withLimits({ 'files.maxBytes': { oss: cap, free: Math.floor(cap / 5), pro: cap } })
        )
      ).not.toThrow();
      // apps/server/src/tool.ts
      expect(() =>
        assertToolEntitlements(
          withLimits({
            'files.maxBytes': { oss: cap, free: Math.min(100 * MB, cap), pro: cap },
            'workspace.members': { oss: null, free: 3, pro: null },
            'links.perDeck': { oss: null, free: 10, pro: null }
          })
        )
      ).not.toThrow();
    });
  }
});
