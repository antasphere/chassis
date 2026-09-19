import { describe, expect, it } from 'vitest';
import { ChassisClient, DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../src/index.js';

/**
 * PRDCT-1353 / CLI-10 — `fetch` has no default timeout anywhere. Without an
 * AbortSignal a silent (or deliberately stalling) instance parks the caller
 * forever. Every call the chassis client makes must carry one. (The tool SDK
 * keeps the same cases on its own class; these judge the generic half alone.)
 */

function recordingClient(overrides: { timeoutMs?: number; downloadTimeoutMs?: number } = {}) {
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    inits.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  const client = new ChassisClient<'things:read'>({
    baseUrl: 'http://x',
    apiKey: 'thk_k_s',
    fetch: fetchImpl,
    ...overrides
  });
  return { client, inits };
}

describe('chassis client request deadlines', () => {
  it('puts an AbortSignal on the JSON calls', async () => {
    const { client, inits } = recordingClient();
    await client.instance();
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(inits[0]!.signal!.aborted).toBe(false);
  });

  it('puts an AbortSignal on the streaming download calls', async () => {
    const { client, inits } = recordingClient();
    await client.downloadExport();
    await client.downloadFileContent('file');
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('puts an AbortSignal on the upload call', async () => {
    const { client, inits } = recordingClient();
    await client.uploadFile('a.txt', new Uint8Array([1]), 'text/plain');
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('actually aborts once the deadline passes', async () => {
    const stalling = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof globalThis.fetch;
    const client = new ChassisClient<'things:read'>({ baseUrl: 'http://x', fetch: stalling, timeoutMs: 20 });
    await expect(client.instance()).rejects.toThrow(/abort/i);
  });

  it('lets an explicit 0 opt out, per kind of call', async () => {
    const { client, inits } = recordingClient({ timeoutMs: 0 });
    await client.instance();
    await client.downloadExport();
    expect(inits[0]!.signal).toBeUndefined();
    expect(inits[1]!.signal).toBeInstanceOf(AbortSignal);

    const downloads = recordingClient({ downloadTimeoutMs: 0 });
    await downloads.client.downloadExport();
    await downloads.client.instance();
    expect(downloads.inits[0]!.signal).toBeUndefined();
    expect(downloads.inits[1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('documents its defaults', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});
