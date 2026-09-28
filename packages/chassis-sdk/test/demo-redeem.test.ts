import { describe, expect, it } from 'vitest';
import { ChassisClient, PlatformApiError } from '../src/index.js';

/**
 * The demo pass redeem is an endpoint of the sign-in library
 * (`/api/v1/auth/demo/redeem`), so it has no route contract and the route
 * coverage guard cannot see it (the same stance as `signInEmail`). This pins
 * its method, its path and its body by hand.
 */

function recordingClient(answer: Response) {
  const calls: Array<{ method: string; path: string; body: unknown; credentials: unknown }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials
    });
    return answer;
  }) as typeof globalThis.fetch;
  return { client: new ChassisClient<'things:read'>({ fetch }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('redeemDemoPass', () => {
  it('posts the secret as `pass` to the sign-in library, same-origin, and answers the person', async () => {
    const answer = {
      user: { id: 'u1', email: 'a@example.com', name: 'A' },
      path: '/decks',
      expiresAt: '2026-09-28T00:00:00.000Z'
    };
    const { client, calls } = recordingClient(json(200, answer));
    await expect(client.redeemDemoPass('s3cr3t')).resolves.toEqual(answer);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/demo/redeem',
        body: { pass: 's3cr3t' },
        credentials: 'same-origin'
      }
    ]);
  });

  it('turns the one refusal into a PlatformApiError carrying its code', async () => {
    const { client } = recordingClient(
      json(401, { error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' } })
    );
    const refused = await client.redeemDemoPass('nope').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PlatformApiError);
    expect(refused).toMatchObject({ status: 401, code: 'invalid_demo_pass' });
  });
});
