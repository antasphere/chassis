import { describe, expect, it } from 'vitest';
import { ChassisClient, PlatformApiError } from '../src/index.js';

/**
 * PRDCT-2426: a download is a request like any other, so it carries the
 * active workspace. A browser anchor cannot send `X-Workspace-Id`, which is
 * why a dashboard downloads through these methods: each of them must put the
 * header on the wire, or a file of a non-default workspace answers 404.
 * (The generic downloads; the tool SDK judges its own on its own class.)
 */

const FILE = '33333333-3333-3333-3333-333333333333';
const WORKSPACE = '44444444-4444-4444-4444-444444444444';
type Client = ChassisClient<'things:read'>;

function recordingClient() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof globalThis.fetch;
  const client: Client = new ChassisClient({ baseUrl: 'http://x', fetch: fetchImpl, workspaceId: WORKSPACE });
  return { client, calls };
}

const DOWNLOADS: Record<string, [(c: Client) => Promise<Response>, string]> = {
  downloadFileContent: [(c) => c.downloadFileContent(FILE), `/api/v1/files/${FILE}/content`],
  downloadExport: [(c) => c.downloadExport(), '/api/v1/workspace/export']
};

describe('chassis client downloads carry the active workspace', () => {
  it.each(Object.entries(DOWNLOADS))('%s', async (_name, [call, path]) => {
    const { client, calls } = recordingClient();
    await call(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://x${path}`);
    expect((calls[0]!.init.headers as Record<string, string>)['x-workspace-id']).toBe(WORKSPACE);
  });

  it('percent-encodes the file id: no path or query break-out', async () => {
    const { client, calls } = recordingClient();
    await client.downloadFileContent('../f?x#1');
    expect(calls[0]!.url).toBe('http://x/api/v1/files/..%2Ff%3Fx%231/content');
  });

  it('follows setWorkspace, and sends no header once it is cleared', async () => {
    const { client, calls } = recordingClient();
    client.setWorkspace('other');
    await client.downloadFileContent(FILE);
    client.setWorkspace(null);
    await client.downloadFileContent(FILE);
    expect((calls[0]!.init.headers as Record<string, string>)['x-workspace-id']).toBe('other');
    expect((calls[1]!.init.headers as Record<string, string>)['x-workspace-id']).toBeUndefined();
  });

  it('a refusal throws the wire error instead of handing back a body to save', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'File not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })) as typeof globalThis.fetch;
    const client: Client = new ChassisClient({ baseUrl: 'http://x', fetch: fetchImpl });
    for (const call of [() => client.downloadFileContent(FILE), () => client.downloadExport()]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(PlatformApiError);
      expect(error).toMatchObject({ name: 'PlatformApiError', status: 404, code: 'not_found' });
    }
  });
});
