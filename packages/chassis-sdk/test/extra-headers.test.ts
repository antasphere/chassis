import { describe, expect, it } from 'vitest';
import { ChassisClient, type ClientOptions } from '../src/index.js';

/**
 * `headers` rides on every call, and it never stands in for a credential:
 * a client given no key sends no `authorization` at all (the CLI's owner
 * session holds a cookie and must never look like a machine caller), and a
 * client given a key keeps its own bearer whatever the caller passed.
 */

function recordingClient(options: ClientOptions = {}) {
  const sent: Array<Record<string, string>> = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push({ ...(init?.headers as Record<string, string>) });
    return new Response(JSON.stringify({ passes: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  return { client: new ChassisClient<'things:read'>({ ...options, fetch }), sent };
}

describe('ClientOptions.headers', () => {
  it('sends the given headers on every call, and no authorization when no key is given', async () => {
    const { client, sent } = recordingClient({
      baseUrl: 'http://x',
      headers: { cookie: 'a.session_token=v', origin: 'http://x' }
    });
    await client.demoPasses();
    await client.mintDemoPass({ email: 'ada@example.com' });
    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers['cookie']).toBe('a.session_token=v');
      expect(headers['origin']).toBe('http://x');
      expect(headers).not.toHaveProperty('authorization');
    }
  });

  it('never lets a given header replace the key', async () => {
    const { client, sent } = recordingClient({
      apiKey: 'k_1_s',
      headers: { authorization: 'Bearer forged', 'x-extra': '1' }
    });
    await client.demoPasses();
    expect(sent[0]!['authorization']).toBe('Bearer k_1_s');
    expect(sent[0]!['x-extra']).toBe('1');
  });
});
