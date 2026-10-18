import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meAppsSchema } from '@antasphere/chassis-contract';
import { FakeHub, type HubUserFixture } from '../../src/testing/fake-hub.js';

/**
 * The fake hub's `GET /me/apps` answers the hub's published shape and
 * nothing else (PRDCT-3493): a conforming catalogue parses with
 * `meAppsSchema`, and a catalogue the fake was handed off the contract is
 * refused as a 500 naming the drift, never served as if the real hub would.
 */

const ORG = '11111111-2222-4333-8444-555555555555';
const mira: HubUserFixture = {
  sub: 'hub-user-mira',
  email: 'mira@fake.test',
  name: 'Mira Lund',
  workspaceId: ORG,
  role: 'member',
  workspaceName: 'Acme'
};

describe('FakeHub GET /me/apps', () => {
  let hub: FakeHub;
  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: 'tool-test' });
    // a signed token seeds no organization: the registry says who belongs where
    hub.setUserOrg(mira.sub, ORG, { name: 'Acme', role: 'member' });
  });
  afterAll(async () => {
    await hub?.stop();
  });

  async function read() {
    const token = await hub.signAccessToken(mira, hub.apiResource);
    return fetch(`${hub.issuer}/api/v1/me/apps`, {
      headers: { authorization: `Bearer ${token}`, 'x-workspace-id': ORG }
    });
  }

  it('answers the contract shape, the organization with its status', async () => {
    hub.setTools([
      {
        slug: 'finance',
        name: 'Finance',
        launchUrl: 'https://finance.example.com',
        descriptor: { icon: 'landmark' }
      }
    ]);
    const res = await read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization: unknown };
    expect(meAppsSchema.safeParse(body).success).toBe(true);
    expect(body.organization).toEqual({ id: ORG, name: 'Acme', status: 'active' });
  });

  it('refuses its own drift as a 500 naming it, never as an answer', async () => {
    hub.setTools([
      {
        slug: 'finance',
        name: 'Finance',
        launchUrl: 'https://finance.example.com',
        descriptor: { icon: 'skull' }
      }
    ]);
    const res = await read();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('fake_hub_drift');
    expect(body.error.message).toContain('off the hub contract');
  });
});
