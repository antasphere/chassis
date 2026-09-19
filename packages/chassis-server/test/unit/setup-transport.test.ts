import { describe, expect, it } from 'vitest';
import { isSecureSetupOrigin } from '@antasphere/chassis-server/util';
import { INSECURE_SETUP_ORIGINS, SECURE_SETUP_ORIGINS } from '@antasphere/chassis-server/testing';

/**
 * PLT-10: the documented no-domain install path used to open port 3000 to the
 * world and tell the operator to complete the first-boot wizard over
 * plaintext HTTP. That request carries the owner password and the setup
 * token, and it is the one request that decides who owns the instance.
 *
 * The URL table lives in src/testing/setup-origins.ts because the shell
 * twin of this rule (dr_origin_is_secure, which setup.sh uses to warn the
 * operator up front) is driven from the same list — see
 * apps/server/test/unit/dr-lib.test.ts. One table, two implementations, no drift.
 */
describe('isSecureSetupOrigin', () => {
  it.each(SECURE_SETUP_ORIGINS)('accepts %s', (url) => {
    expect(isSecureSetupOrigin(url)).toBe(true);
  });

  it.each(INSECURE_SETUP_ORIGINS)('REFUSES %s', (url) => {
    expect(isSecureSetupOrigin(url)).toBe(false);
  });

  it('fails closed on anything it cannot parse', () => {
    expect(isSecureSetupOrigin('not a url')).toBe(false);
    expect(isSecureSetupOrigin('')).toBe(false);
  });
});
