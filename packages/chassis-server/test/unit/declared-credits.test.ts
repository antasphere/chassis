import { describe, expect, it } from 'vitest';
import { declaredCredits } from '@antasphere/chassis-contract';

/** The price an action declares is what a test can compute from the declaration (PRDCT-2627). */
describe('declaredCredits', () => {
  it('prices a quantity from the declaration: credits per `per` units, exact', () => {
    const MB = 1024 * 1024;
    const upload = { creditsPerUnit: 5, unit: 'bytes', per: MB };
    expect(declaredCredits(upload, 20 * MB)).toBe(100);
    expect(declaredCredits(upload, 43)).toBeCloseTo(0.000205, 6);
    expect(declaredCredits({ creditsPerUnit: 50 }, 1)).toBe(50);
  });
});
