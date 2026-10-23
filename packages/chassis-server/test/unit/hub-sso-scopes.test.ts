import { describe, expect, it } from 'vitest';
import { HUB_SSO_CONNECT_SCOPE, HUB_SSO_SCOPES, HubSsoService } from '../../src/identity/hub-sso.js';

/**
 * What a tool asks the hub at sign-in (PRDCT-3774): the fixed list, plus the
 * sibling connect scope ONLY when the boot hands it over (a tool that
 * declares a sibling source). The constant stays pure, the provider config
 * carries exactly the service's list, and a duplicate is folded.
 */
const base = {
  db: {} as never,
  logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  issuerUrl: 'https://hub.example',
  clientId: 'tool-things',
  clientSecret: 'secret-0123456789abcdef',
  resourceUrl: 'https://things.example/mcp',
  tokenResource: 'https://hub.example/mcp',
  publicBaseUrl: 'https://things.example'
};

describe('HubSsoService.scopes', () => {
  it('a tool without a sibling source asks the fixed list and nothing more', () => {
    const service = new HubSsoService(base);
    expect(service.scopes()).toEqual([...HUB_SSO_SCOPES]);
    expect(service.scopes()).not.toContain(HUB_SSO_CONNECT_SCOPE);
    expect(service.providerConfig().scopes).toEqual([...HUB_SSO_SCOPES]);
  });

  it('a tool that declares a sibling source asks sso:connect too, once', () => {
    const service = new HubSsoService({
      ...base,
      extraScopes: [HUB_SSO_CONNECT_SCOPE, HUB_SSO_CONNECT_SCOPE, 'openid']
    });
    expect(service.scopes()).toEqual([...HUB_SSO_SCOPES, HUB_SSO_CONNECT_SCOPE]);
    expect(service.providerConfig().scopes).toEqual([...HUB_SSO_SCOPES, HUB_SSO_CONNECT_SCOPE]);
  });

  it('the constant itself never carries the connect scope', () => {
    expect([...HUB_SSO_SCOPES]).not.toContain('sso:connect');
    expect(HUB_SSO_CONNECT_SCOPE).toBe('sso:connect');
  });
});
