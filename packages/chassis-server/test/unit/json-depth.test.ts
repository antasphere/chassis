import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { exceedsJsonDepth, jsonDepthLimit, MAX_JSON_DEPTH } from '@antasphere/chassis-server/middleware';

const nest = (depth: number) => '['.repeat(depth) + '1' + ']'.repeat(depth);

describe('exceedsJsonDepth', () => {
  it('measures nesting', () => {
    expect(exceedsJsonDepth(nest(10), 100)).toBe(false);
    expect(exceedsJsonDepth(nest(101), 100)).toBe(true);
    expect(exceedsJsonDepth(nest(100), 100)).toBe(false);
  });

  it('counts objects and arrays together', () => {
    expect(exceedsJsonDepth('{"a":{"b":{"c":[1]}}}', 3)).toBe(true);
    expect(exceedsJsonDepth('{"a":{"b":{"c":[1]}}}', 4)).toBe(false);
  });

  it('ignores brackets inside string literals, escapes included', () => {
    const payload = `{"a":"${'['.repeat(500)}"}`;
    expect(exceedsJsonDepth(payload, 5)).toBe(false);
    expect(exceedsJsonDepth('{"a":"\\"[[[[[[[[[[","b":1}', 5)).toBe(false);
  });

  it('does not fire on flat, wide payloads', () => {
    expect(exceedsJsonDepth(JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)), 100)).toBe(false);
  });
});

describe('jsonDepthLimit middleware', () => {
  function app() {
    const a = new Hono();
    a.use('*', jsonDepthLimit());
    a.post('/echo', async (c) => c.json({ ok: true, body: await c.req.json() }));
    a.post('/raw', async (c) => c.text(await c.req.text()));
    return a;
  }

  it('rejects an over-deep JSON body with a 400 before the handler', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nest(MAX_JSON_DEPTH + 1)
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'payload_too_deep' } });
  });

  it('rejects the depth that breaks JSON.stringify inside the shipped image', async () => {
    // node:22-alpine throws RangeError from JSON.stringify past ~5000 levels;
    // a newer host Node does not, which is exactly why the guard is at the
    // edge and not a try/catch around some stringify call.
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nest(6000)
    });
    expect(res.status).toBe(400);
  });

  it('passes ordinary bodies through untouched', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'acme', nested: { a: { b: [1, 2, 3] } } })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, body: { name: 'acme' } });
  });

  it('ignores non-JSON bodies (streamed uploads, form-encoded token calls)', async () => {
    const res = await app().request('/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: nest(6000)
    });
    expect(res.status).toBe(200);
  });

  it('ignores bodyless requests', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
    // No body: the handler's own parse decides, the guard does not interfere.
    expect(res.status).not.toBe(400);
  });
});
