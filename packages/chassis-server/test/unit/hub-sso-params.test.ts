import { describe, expect, it } from 'vitest';
import { ssoAuthorizationUrlParams } from '@antasphere/chassis-server/identity';

/**
 * The SL-1 authorize-params whitelist: the ONLY thing the caller-controlled
 * `additionalData` blob may ever contribute to the hub authorize URL is the
 * literal `prompt=none` pair (the dashboard's silent auto-connect). Every
 * other value, key, and shape is dropped — an attacker-shaped sign-in body
 * can never smuggle params (prompt=consent re-prompts, login_hint,
 * request_uri, …) into the hub redirect.
 */
describe('ssoAuthorizationUrlParams (strict whitelist)', () => {
  it("passes exactly { prompt: 'none' } for additionalData.prompt === 'none'", () => {
    expect(ssoAuthorizationUrlParams({ additionalData: { prompt: 'none' } })).toEqual({ prompt: 'none' });
  });

  it('drops every other prompt value', () => {
    for (const prompt of ['consent', 'login', 'select_account', 'NONE', 'none ', '', 0, true, null]) {
      expect(ssoAuthorizationUrlParams({ additionalData: { prompt } }), String(prompt)).toEqual({});
    }
  });

  it('never forwards extra additionalData keys — even next to a valid prompt', () => {
    expect(
      ssoAuthorizationUrlParams({
        additionalData: { prompt: 'none', login_hint: 'a@b.c', request_uri: 'https://evil.example' }
      })
    ).toEqual({ prompt: 'none' });
  });

  it('answers {} for absent/malformed bodies (plain sign-ins stay param-free)', () => {
    expect(ssoAuthorizationUrlParams(undefined)).toEqual({});
    expect(ssoAuthorizationUrlParams(null)).toEqual({});
    expect(ssoAuthorizationUrlParams({})).toEqual({});
    expect(ssoAuthorizationUrlParams({ additionalData: null })).toEqual({});
    expect(ssoAuthorizationUrlParams({ additionalData: 'none' })).toEqual({});
    expect(ssoAuthorizationUrlParams({ additionalData: ['none'] })).toEqual({});
  });
});
