import { describe, expect, it } from 'vitest';
import { defineChassisContract } from '@antasphere/chassis-contract';
import * as chassisRoutes from '@antasphere/chassis-contract/routes';
import { ChassisClient } from '../src/index.js';

/**
 * Chassis client ↔ chassis contract drift guard, the generic half of the
 * tool SDK's own route-coverage test. Request/response SHAPES already fail
 * typecheck; this closes the remaining gap: the method + path string literals
 * inside each client method.
 *
 * The scope-carrying routes are instantiated with scopes that are NOT any real
 * tool's (`things:*`), so the chassis stays honest about never spelling one.
 *
 * Better Auth wrapper methods (session/signInEmail/signOut) call /auth/* and
 * are intentionally NOT in the contract; they are excluded below.
 */

const contract = defineChassisContract({ scopes: ['things:read', 'things:write'] });
const scopedRoutes = chassisRoutes.defineChassisRoutes(
  contract,
  { cliKeyScopesLabel: 'things:read+write', scopes: { dataExport: 'things:export' } },
  { fileInUseOpenApi: 'file_in_use: referenced by a thing' }
);
type ThingsScope = 'things:read' | 'things:write';
type Client = ChassisClient<ThingsScope>;

const SAMPLE_ID = '11111111-1111-1111-1111-111111111111';
const SAMPLE_TOKEN = 'x'.repeat(24);

/** contract route → a client call. Keyed by `METHOD path` (contract shape). */
const INVOKERS: Record<string, (c: Client) => Promise<unknown>> = {
  'GET /instance': (c) => c.instance(),
  'POST /setup': (c) =>
    c.setup({
      instanceName: 'X',
      owner: { email: 'a@b.co', name: 'A', password: 'x'.repeat(12) }
    }),
  'GET /me': (c) => c.me(),
  'POST /me/onboarding/dismiss': (c) => c.dismissOnboarding(),
  'POST /workspaces': (c) => c.createWorkspace('Second'),
  'POST /sso/logout': (c) => c.ssoLogout(),
  'POST /cli/auth/request': (c) => c.cliAuthRequest({ email: 'a@b.co' }),
  'POST /cli/auth/complete': (c) => c.cliAuthComplete({ email: 'a@b.co', otp: '123456' }),
  'DELETE /cli/auth/key': (c) => c.cliAuthRevoke(),
  'POST /sso/cli-connect': (c) => c.ssoCliConnect({ token: SAMPLE_TOKEN }),
  'GET /members': (c) => c.members(),
  'PATCH /members/{id}': (c) => c.updateMember(SAMPLE_ID, { role: 'admin' }),
  'DELETE /members/{id}': (c) => c.deleteMember(SAMPLE_ID),
  'POST /members/{id}/reset-link': (c) => c.createMemberResetLink(SAMPLE_ID),
  'POST /members/{id}/change-email-link': (c) =>
    c.createMemberChangeEmailLink(SAMPLE_ID, { newEmail: 'a@b.co' }),
  'GET /api-keys': (c) => c.apiKeys(),
  'POST /api-keys': (c) => c.createApiKey({ name: 'k', scopes: ['things:read'] }),
  'DELETE /api-keys/{id}': (c) => c.revokeApiKey(SAMPLE_ID),
  'PATCH /workspace': (c) => c.updateWorkspace({ name: 'Acme' }),
  'GET /invitations': (c) => c.invitations(),
  'POST /invitations': (c) => c.createInvitation({ email: 'a@b.co', role: 'member' }),
  'DELETE /invitations/{id}': (c) => c.revokeInvitation(SAMPLE_ID),
  'GET /invitations/lookup': (c) => c.lookupInvitation(SAMPLE_TOKEN),
  'POST /invitations/accept': (c) => c.acceptInvitation({ token: SAMPLE_TOKEN }),
  'POST /admin/break-glass/claim-ownership': (c) => c.breakGlassClaimOwnership(),
  'POST /admin/break-glass/reset-2fa': (c) => c.breakGlassResetTwoFactor({ userId: SAMPLE_ID }),
  'GET /audit': (c) => c.audit(),
  'GET /workspace/export': (c) => c.downloadExport(),
  'GET /files': (c) => c.files(),
  'GET /files/{id}': (c) => c.file(SAMPLE_ID),
  'POST /files': (c) => c.uploadFile('n.txt', new Uint8Array([1])),
  'DELETE /files/{id}': (c) => c.deleteFile(SAMPLE_ID)
};

interface ContractRoute {
  method: string;
  path: string;
}

function contractRoutes(): Array<{ key: string; method: string; path: string }> {
  // Both halves of the chassis routes: the static ones, then the ones
  // instantiated with the test tool's scopes.
  return [
    ...Object.values(chassisRoutes as Record<string, unknown>),
    ...Object.values(scopedRoutes as Record<string, unknown>)
  ]
    .filter((r): r is ContractRoute => {
      const o = r as Partial<ContractRoute>;
      return typeof o?.method === 'string' && typeof o?.path === 'string';
    })
    .map((r) => ({
      key: `${r.method.toUpperCase()} ${r.path}`,
      method: r.method.toUpperCase(),
      path: r.path
    }));
}

/** Records the (method, pathname) of the single request a client call makes. */
function recordingClient(): { client: Client; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { client: new ChassisClient<ThingsScope>({ fetch }), calls };
}

/** The contract path with every param substituted, to compare against the client's real path. */
function expectedPath(contractPath: string): string {
  return `/api/v1${contractPath.replace('{id}', SAMPLE_ID)}`;
}

describe('chassis client route coverage (contract drift guard)', () => {
  const all = contractRoutes();

  it('sees both halves of the chassis routes', () => {
    expect(all.length).toBe(Object.keys(INVOKERS).length);
    expect(all.map((r) => r.key)).toContain('GET /me');
    expect(all.map((r) => r.key)).toContain('GET /instance');
  });

  it('maps every chassis route to a client method', () => {
    const missing = all.filter((r) => !(r.key in INVOKERS)).map((r) => r.key);
    expect(missing, `contract routes without a client method: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale mappings (every mapping targets a real contract route)', () => {
    const keys = new Set(all.map((r) => r.key));
    const stale = Object.keys(INVOKERS).filter((k) => !keys.has(k));
    expect(stale, `INVOKERS entries with no matching contract route: ${stale.join(', ')}`).toEqual([]);
  });

  for (const route of contractRoutes()) {
    it(`${route.key} hits the right method + path`, async () => {
      const invoke = INVOKERS[route.key];
      if (!invoke) return; // coverage asserted separately
      const { client, calls } = recordingClient();
      await invoke(client);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(route.method);
      expect(calls[0]!.path).toBe(expectedPath(route.path));
    });
  }
});
