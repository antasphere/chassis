import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineChassisContract, type ApiKeyInfoOf, type MeResponseOf, type ScopeOf } from '../src/index.js';
import { defineChassisRoutes } from '../src/routes/index.js';

/**
 * The factory is the one place the chassis meets a tool's scope vocabulary.
 * Proven here with scopes that are NOT any real tool's, so the chassis stays
 * honest about never spelling one.
 */
const a = defineChassisContract({ scopes: ['widgets:read', 'widgets:write'] });
const b = defineChassisContract({ scopes: ['gadgets:admin'] });

describe('defineChassisContract', () => {
  it('builds the scope enum from the scopes it is given, in order', () => {
    expect(a.scopeSchema.options).toEqual(['widgets:read', 'widgets:write']);
    expect(b.scopeSchema.options).toEqual(['gadgets:admin']);
  });

  it('types Scope as the union of the literals passed in', () => {
    expectTypeOf<ScopeOf<typeof a>>().toEqualTypeOf<'widgets:read' | 'widgets:write'>();
    expectTypeOf<ApiKeyInfoOf<typeof a>['scopes']>().toEqualTypeOf<Array<'widgets:read' | 'widgets:write'>>();
    expectTypeOf<MeResponseOf<typeof b>['scopes']>().toEqualTypeOf<Array<'gadgets:admin'> | null>();
  });

  it('threads the enum into every schema that carries scopes', () => {
    expect(a.apiKeyCreateSchema.safeParse({ name: 'k', scopes: ['widgets:read'] }).success).toBe(true);
    expect(a.apiKeyCreateSchema.safeParse({ name: 'k', scopes: ['gadgets:admin'] }).success).toBe(false);
    expect(b.apiKeyCreateSchema.safeParse({ name: 'k', scopes: ['gadgets:admin'] }).success).toBe(true);
    expect(a.cliAuthCompletedSchema.shape.apiKey).toBe(a.apiKeySchema);
    expect(a.meResponseSchema.shape.scopes.unwrap().element).toBe(a.scopeSchema);
  });

  it('holds no module-level state: two instantiations never share a schema', () => {
    expect(a.scopeSchema).not.toBe(b.scopeSchema);
    expect(a.apiKeySchema).not.toBe(b.apiKeySchema);
    expect(a.meResponseSchema).not.toBe(b.meResponseSchema);
  });
});

describe('defineChassisRoutes', () => {
  it('returns the six route contracts over the instantiated schemas', () => {
    const routes = defineChassisRoutes(a, { cliKeyScopesLabel: 'widgets:read+write' });
    expect(Object.entries(routes).map(([name, r]) => `${name} ${r.method} ${r.path}`)).toEqual([
      'meRoute get /me',
      'apiKeysListRoute get /api-keys',
      'apiKeyCreateRoute post /api-keys',
      'apiKeyRevokeRoute delete /api-keys/{id}',
      'cliAuthCompleteRoute post /cli/auth/complete',
      'ssoCliConnectRoute post /sso/cli-connect'
    ]);
    expect(routes.meRoute.responses[200].content['application/json'].schema).toBe(a.meResponseSchema);
  });
});
