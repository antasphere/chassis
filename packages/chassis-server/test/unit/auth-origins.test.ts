import { describe, expect, it } from 'vitest';
import { signInOriginRefused, trustedOriginsFor } from '@antasphere/chassis-server/identity';

/**
 * PRDCT-1352, the auth-layer second locks. The host gate keeps the auth
 * surface off the viewer hostname and the cross-site guard refuses the viewer
 * Origin before Better Auth ever runs — so these two arms are only reachable
 * once BOTH have regressed. That is exactly why they must be pinned on their
 * own: the verifier proved that with gate + guard bypassed, dropping the
 * sign-in arm turns a viewer-origin sign-in from 403 into 200 + Set-Cookie.
 */
const APP = 'https://app.example.com';
const VIEWER = 'https://decks.example.net';

describe('trustedOriginsFor', () => {
  it('trusts the public origin and the serving origin', () => {
    const fn = trustedOriginsFor(APP, []);
    expect(fn(new Request('http://localhost:5173/api/v1/auth/get-session'))).toEqual([
      APP,
      'http://localhost:5173'
    ]);
    expect(fn()).toEqual([APP]);
  });

  it('never returns the viewer origin, even when it is the serving origin', () => {
    const fn = trustedOriginsFor(APP, [VIEWER]);
    expect(fn(new Request(`${VIEWER}/api/v1/auth/sign-in/email`))).toEqual([APP]);
    // Served on the app origin, the serving origin is appended (a duplicate, harmless).
    expect(fn(new Request(`${APP}/api/v1/auth/sign-in/email`))).toEqual([APP, APP]);
  });

  it('would not even trust the viewer origin if it were the configured public origin', () => {
    // parseEnv refuses this shape; the filter is origin-blind on purpose.
    expect(trustedOriginsFor(VIEWER, [VIEWER])()).toEqual([]);
  });
});

describe('signInOriginRefused', () => {
  const trustedApp = (o: string) => o === APP;

  it('accepts the serving origin and any trusted origin', () => {
    expect(
      signInOriginRefused({
        origin: 'http://localhost:5173',
        servingOrigin: 'http://localhost:5173',
        untrustedOrigins: [VIEWER],
        isTrustedOrigin: trustedApp
      })
    ).toBe(false);
    expect(
      signInOriginRefused({
        origin: APP,
        servingOrigin: null,
        untrustedOrigins: [VIEWER],
        isTrustedOrigin: trustedApp
      })
    ).toBe(false);
  });

  it('refuses a foreign origin', () => {
    expect(
      signInOriginRefused({
        origin: 'https://evil.example',
        servingOrigin: APP,
        untrustedOrigins: [VIEWER],
        isTrustedOrigin: trustedApp
      })
    ).toBe(true);
  });

  it('refuses the viewer origin even as the serving origin AND even if the trusted list says yes', () => {
    expect(
      signInOriginRefused({
        origin: VIEWER,
        servingOrigin: VIEWER,
        untrustedOrigins: [VIEWER],
        isTrustedOrigin: () => true
      })
    ).toBe(true);
  });

  it('is unchanged when no viewer origin is configured', () => {
    expect(
      signInOriginRefused({
        origin: VIEWER,
        servingOrigin: VIEWER,
        untrustedOrigins: [],
        isTrustedOrigin: trustedApp
      })
    ).toBe(false);
  });
});
