import { describe, expect, it } from 'vitest';
import { ApiToolError, jsonText, wrapToolErrors } from '@antasphere/chassis-server/mcp';
import { isPublicOauthPath } from '@antasphere/chassis-server/middleware';

describe('mcp error → hint mapping', () => {
  it('attaches an actionable hint for known API codes', () => {
    const err = new ApiToolError(
      403,
      'insufficient_scope',
      'This credential was not granted "presentations:write"'
    );
    const text = err.toUserFacingText();
    expect(text).toContain('HTTP 403');
    expect(text).toContain('insufficient_scope');
    expect(text).toContain('consent screen');
  });

  it('degrades gracefully for unknown codes', () => {
    const err = new ApiToolError(422, 'weird_domain_thing', 'nope');
    const text = err.toUserFacingText();
    expect(text).toContain('weird_domain_thing');
    expect(text).not.toContain('undefined');
  });

  it('wrapToolErrors turns ApiToolError into an isError tool result', async () => {
    const result = await wrapToolErrors(async () => {
      throw new ApiToolError(401, 'invalid_token', 'expired');
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid_token');
  });

  it('wrapToolErrors passes successes through untouched', async () => {
    const result = await wrapToolErrors(async () => jsonText({ ok: true }));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ ok: true });
  });

  it('wrapToolErrors lets non-API errors propagate to the SDK', async () => {
    await expect(
      wrapToolErrors(async () => {
        throw new Error('bug');
      })
    ).rejects.toThrow('bug');
  });
});

describe('public OAuth path matcher', () => {
  it('covers exactly the cookie-less endpoints', () => {
    expect(isPublicOauthPath('/api/v1/auth/oauth2/token')).toBe(true);
    expect(isPublicOauthPath('/api/v1/auth/oauth2/register')).toBe(true);
    expect(isPublicOauthPath('/api/v1/auth/oauth2/introspect')).toBe(true);
    expect(isPublicOauthPath('/api/v1/auth/oauth2/revoke')).toBe(true);
    expect(isPublicOauthPath('/api/v1/auth/jwks')).toBe(true);
    expect(isPublicOauthPath('/api/v1/auth/.well-known/openid-configuration')).toBe(true);
  });

  it('never exempts cookie-bearing endpoints', () => {
    expect(isPublicOauthPath('/api/v1/auth/oauth2/authorize')).toBe(false);
    expect(isPublicOauthPath('/api/v1/auth/oauth2/consent')).toBe(false);
    expect(isPublicOauthPath('/api/v1/auth/sign-in/email')).toBe(false);
    expect(isPublicOauthPath('/api/v1/auth/get-session')).toBe(false);
  });
});
