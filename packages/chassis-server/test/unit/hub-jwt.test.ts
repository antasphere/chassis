import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubJwtVerifier } from '@antasphere/chassis-server/identity';
import { FakeHub } from '@antasphere/chassis-server/testing';

/**
 * HubJwtVerifier — the cloud edition's trust anchor for hub-minted tokens
 * (internal/federation.md). Mirrors oauth-jwt.ts's discipline: hard issuer +
 * audience pinning, RS256 allowlist, one forced key refresh on an unknown
 * signature. Every rejection here is a fail-closed SSO login.
 */

const RESOURCE = 'http://localhost:3000/mcp';

const USER = {
  sub: 'hub-user-1',
  email: 'user@hub.test',
  workspaceId: '5f0c1f9a-1111-4222-8333-444455556666',
  role: 'member'
};

let hub: FakeHub;
let verifier: HubJwtVerifier;

beforeAll(async () => {
  hub = await FakeHub.start();
  verifier = new HubJwtVerifier(hub.issuer);
});

afterAll(async () => {
  await hub.stop();
});

describe('HubJwtVerifier', () => {
  it('accepts a hub-minted token and yields the org claims', async () => {
    const token = await hub.signAccessToken(USER, RESOURCE);
    const payload = await verifier.verify(token, RESOURCE);
    expect(payload.sub).toBe(USER.sub);
    expect(payload.workspace_id).toBe(USER.workspaceId);
    expect(payload.role).toBe('member');
    expect(payload.workspace_name).toBe('Fake Org');
  });

  it('accepts the array-shaped aud (resource + hub userinfo) by matching our element', async () => {
    const token = await hub.signAccessToken(USER, RESOURCE);
    // The fake mints aud = [resource, <issuer>/…/userinfo], like the real hub
    // when openid is scoped — pinning OUR resource must still verify.
    await expect(verifier.verify(token, RESOURCE)).resolves.toBeTruthy();
  });

  it('rejects a token minted for another resource (aud pinning)', async () => {
    const token = await hub.signAccessToken(
      { ...USER, overrides: { accessAud: ['http://other-tool.test/mcp'] } },
      RESOURCE
    );
    await expect(verifier.verify(token, RESOURCE)).rejects.toThrow();
  });

  it('rejects a token from another issuer (iss pinning)', async () => {
    const token = await hub.signAccessToken(
      { ...USER, overrides: { iss: 'http://evil-hub.test' } },
      RESOURCE
    );
    await expect(verifier.verify(token, RESOURCE)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await hub.signAccessToken({ ...USER, overrides: { expiresInSeconds: -60 } }, RESOURCE);
    await expect(verifier.verify(token, RESOURCE)).rejects.toThrow();
  });

  it('rejects a non-JWT (opaque) token', async () => {
    await expect(verifier.verify('opaque_not_a_jwt', RESOURCE)).rejects.toThrow();
  });

  it('survives a hub signing-key rotation (fresh JWKS on unknown kid)', async () => {
    // Prime the key cache with the current key…
    await verifier.verify(await hub.signAccessToken(USER, RESOURCE), RESOURCE);
    // …rotate the hub key, then verify a token signed with the NEW key: the
    // cached set does not know the kid, jose refetches, verification passes.
    await hub.rotateKey();
    const fresh = await hub.signAccessToken(USER, RESOURCE);
    const payload = await verifier.verify(fresh, RESOURCE);
    expect(payload.sub).toBe(USER.sub);
  });

  it('refuses a discovery document claiming a different issuer', async () => {
    // A verifier configured to trust a DIFFERENT issuer than the one the
    // discovery document self-reports must fail closed before trusting keys.
    const misconfigured = new HubJwtVerifier(hub.issuer.replace('127.0.0.1', 'localhost'));
    const token = await hub.signAccessToken(USER, RESOURCE);
    await expect(misconfigured.verify(token, RESOURCE)).rejects.toThrow(/issuer mismatch|fetch failed/);
  });
});
