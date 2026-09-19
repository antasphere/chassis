import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

/**
 * PLT-39: Hono answers a HEAD request by running the GET handler. A separate
 * `app.on('HEAD', …)` registration therefore NEVER fires — which made the
 * `headOnly` flag on the file-content route dead code, so every HEAD read the
 * blob and streamed the whole body.
 *
 * Two tests: one pins the framework behaviour (so a Hono bump that changes it
 * fails here first), one greps the API surface so the dead idiom cannot come
 * back on a future route.
 */
describe('Hono HEAD handling (pinned)', () => {
  it('runs the GET handler and never the HEAD registration', async () => {
    const app = new Hono();
    let getHits = 0;
    let headHits = 0;
    app.get('/x', (c) => {
      getHits++;
      return c.text('body');
    });
    app.on('HEAD', '/x', (c) => {
      headHits++;
      return c.body(null, 200);
    });
    const res = await app.request('/x', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(getHits).toBe(1);
    expect(headHits).toBe(0);
  });

  it('still reports HEAD as the method inside the GET handler', async () => {
    const app = new Hono();
    let seen = '';
    app.get('/x', (c) => {
      seen = c.req.method;
      return c.text('body');
    });
    await app.request('/x', { method: 'HEAD' });
    // This is the ONLY signal that survives the rewrite, so it is what the
    // file-content route branches on.
    expect(seen).toBe('HEAD');
  });
});

describe('no dead HEAD registrations under /api/v1', () => {
  it('has none', () => {
    // The routers live in two places since the chassis extraction: the generic
    // ones here, the tool's in the app that composes it. Both are audited.
    const apiDirs = [
      join(import.meta.dirname, '../../../../apps/server/src/api'),
      join(import.meta.dirname, '../../src/api')
    ];
    const offenders: string[] = [];
    const files = apiDirs.flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)));
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(file, 'utf8');
      const code = source
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      if (/\.on\(\s*(\[[^\]]*)?['"]HEAD['"]/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
