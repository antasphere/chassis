import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { deferrableBodyCap } from '../../src/middleware/body-cap.js';
import { pendingBodyRefusal } from '../../src/middleware/body-refusal.js';

/**
 * The size cap's deferral (PRDCT-2632): on a deferring route a declared
 * oversize body is parked for the gate and the request loses its body, so
 * no later middleware can read a byte of it; everywhere else hono's cap
 * answers as before (the header refusal, the mid-stream cut, the pass).
 */
const cap = {
  maxBytes: 100,
  onError: (c: { json: (b: unknown, s: 413) => Response }) =>
    c.json({ error: { code: 'too_big', message: 'the cap' } }, 413)
};

function app(isDeferring: boolean) {
  const seen: { pending: boolean; body: string | null; pulls: number }[] = [];
  const a = new Hono();
  a.use(
    '*',
    deferrableBodyCap(cap, () => isDeferring)
  );
  // A reader in the middle: the body a deferred request carries is gone.
  a.post('/up', async (c) => {
    const pending = Boolean(pendingBodyRefusal(c));
    const body = c.req.raw.body ? await c.req.text() : null;
    seen.push({ pending, body, pulls: body?.length ?? 0 });
    const refusal = pendingBodyRefusal(c);
    return refusal ? refusal() : c.json({ ok: true }, 201);
  });
  return { a, seen };
}

describe('deferrableBodyCap', () => {
  it('on a deferring route: a declared oversize body is parked for the gate and dropped, nothing downstream reads it', async () => {
    const { a, seen } = app(true);
    const res = await a.request('/up', {
      method: 'POST',
      headers: { 'content-length': '500', 'content-type': 'application/json' },
      body: 'x'.repeat(500)
    });
    expect(res.status).toBe(413); // the handler fired the parked refusal
    expect(seen).toEqual([{ pending: true, body: null, pulls: 0 }]);
  });

  it('elsewhere: the header refusal happens at once, before any handler', async () => {
    const { a, seen } = app(false);
    const res = await a.request('/up', {
      method: 'POST',
      headers: { 'content-length': '500' },
      body: 'x'.repeat(500)
    });
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('a body within the cap passes untouched on either kind of route', async () => {
    for (const deferring of [true, false]) {
      const { a, seen } = app(deferring);
      const res = await a.request('/up', {
        method: 'POST',
        headers: { 'content-length': '5' },
        body: 'hello'
      });
      expect(res.status).toBe(201);
      expect(seen).toEqual([{ pending: false, body: 'hello', pulls: 5 }]);
    }
  });

  it('an undeclared oversize body is still cut by the cap on a deferring route', async () => {
    const { a, seen } = app(true);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i += 1) controller.enqueue(new TextEncoder().encode('y'.repeat(10)));
        controller.close();
      }
    });
    const res = await a.request('/up', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    expect(seen.every((s) => !s.pending)).toBe(true);
  });
});
