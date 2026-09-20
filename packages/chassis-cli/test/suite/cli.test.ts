import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin, envPrefix: P } = cli.identity;

/**
 * Unit coverage: each command hits the right method + path (via a recording
 * fake fetch), the no-API-key guard fires, and a 403 maps to a friendly line.
 * The upload/download filesystem paths are exercised by the server-side
 * integration test.
 */

interface Canned {
  status?: number;
  body?: unknown;
}

function harness(responses: Canned[] = [{ status: 200, body: {} }]) {
  const calls: Array<{ method: string; path: string }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...responses];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    // pathname + search so cursor/limit threading is assertable.
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname + url.search });
    const r = queue.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  const io: CliIo = {
    env: {},
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    fetch
  };
  return { io, calls, out: () => out.join(''), err: () => err.join('') };
}

const INSTANCE = {
  name: 'Acme',
  version: '1.0.0',
  edition: 'oss',
  setupRequired: false,
  auth: { methods: ['password', 'api-key', 'oauth'], passwordReset: false }
};
const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
  role: 'owner',
  via: 'api_key',
  scopes: ['items:read']
};

describe(`${bin} CLI`, () => {
  it('instance → GET /api/v1/instance (no key needed)', async () => {
    const h = harness([{ body: INSTANCE }]);
    const code = await run(['instance', '--url', 'http://x'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/instance' }]);
    expect(h.out()).toContain('Acme');
  });

  it('whoami → GET /api/v1/me with the key', async () => {
    const h = harness([{ body: ME }]);
    const code = await run(['whoami', '--url', 'http://x', '--api-key', 'key_a_b'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/me' }]);
    expect(h.out()).toContain('ada@x.co');
  });

  it(`reads ${P}_URL / ${P}_API_KEY from the environment`, async () => {
    const h = harness([{ body: ME }]);
    h.io.env[`${P}_URL`] = 'http://from-env';
    h.io.env[`${P}_API_KEY`] = 'key_env';
    const code = await run(['whoami'], h.io);
    expect(code).toBe(0);
    expect(h.calls[0]).toEqual({ method: 'GET', path: '/api/v1/me' });
  });

  it('files list → GET /api/v1/files', async () => {
    const h = harness([{ body: { files: [], nextCursor: null } }]);
    const code = await run(['files', 'list', '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/files' }]);
    expect(h.out()).toContain('No files.');
  });

  it('files list threads --cursor and --limit onto the query string', async () => {
    const h = harness([{ body: { files: [], nextCursor: null } }]);
    const code = await run(
      ['files', 'list', '--limit', '2', '--cursor', 'abc', '--url', 'http://x', '--api-key', 'k'],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/files?cursor=abc&limit=2' }]);
  });

  it('files list --all follows nextCursor and outputs every page', async () => {
    const fileA = { id: 'f-a', sizeBytes: 10, originalName: 'a.txt' };
    const fileB = { id: 'f-b', sizeBytes: 20, originalName: 'b.txt' };
    const h = harness([
      { body: { files: [fileA], nextCursor: 'f-a' } },
      { body: { files: [fileB], nextCursor: null } }
    ]);
    const code = await run(['files', 'list', '--all', '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/files' },
      { method: 'GET', path: '/api/v1/files?cursor=f-a' }
    ]);
    expect(h.out()).toContain('a.txt');
    expect(h.out()).toContain('b.txt');
  });

  it('files list --json prints the wire shape { files, nextCursor }', async () => {
    const fileA = { id: 'f-a', sizeBytes: 10, originalName: 'a.txt' };
    const h = harness([{ body: { files: [fileA], nextCursor: 'f-a' } }]);
    const code = await run(['files', 'list', '--json', '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ files: [fileA], nextCursor: 'f-a' });
  });

  it('files rm → DELETE /api/v1/files/:id', async () => {
    const h = harness([{ body: {} }]);
    const code = await run(['files', 'rm', 'abc', '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'DELETE', path: '/api/v1/files/abc' }]);
  });

  it('export → GET /api/v1/workspace/export streamed to disk', async () => {
    const h = harness([{ body: { fake: 'zip-bytes' } }]);
    const out = join(await mkdtemp(join(tmpdir(), 'cli-export-')), 'bundle.zip');
    const code = await run(['export', '-o', out, '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/workspace/export' }]);
    expect(await readFile(out, 'utf8')).toBe(JSON.stringify({ fake: 'zip-bytes' }));
    expect(h.out()).toContain(out);
  });

  it('requires an API key for authenticated commands (exit 1, one discovery probe only)', async () => {
    // With no key at all, the runner asks discovery whether this is a cloud
    // instance (connect-on-demand seam); a non-cloud answer keeps the
    // classic error and no other request is made.
    const h = harness([{ body: INSTANCE }]);
    const code = await run(['whoami', '--url', 'http://x'], h.io);
    expect(code).toBe(1);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/instance' }]);
    expect(h.err()).toContain('API key is required');
  });

  it('maps a 403 to a friendly stderr line and exit 1', async () => {
    const h = harness([{ status: 403, body: { error: { code: 'forbidden', message: 'Not allowed here' } } }]);
    const code = await run(['files', 'list', '--url', 'http://x', '--api-key', 'k'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('not allowed to do that');
  });
});
