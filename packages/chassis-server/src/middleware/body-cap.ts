import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { BodyCap } from '../tool-definition.js';

/**
 * A body-size cap that DEFERS its declared-size refusal to the entitlement
 * gate (PRDCT-2632). Built once per `BodyCap` from hono's `bodyLimit` (a
 * declared Content-Length over the cap is refused before a byte is read; an
 * undeclared body is counted and cut at the cap), with one difference: when
 * the request's matched route carries a gate that judges a plan limit
 * (`isDeferring`), a declared oversize body is not refused HERE — the
 * refusal is parked on the context (`bodyRefusal`) for the gate to fire
 * after the plan check, and the request is rebuilt WITHOUT a body, so
 * nothing downstream can read a byte of it whatever the middleware order.
 * A metered account thus meets 403 `plan_required` with its upgrade link at
 * any size, and the cap's 413 only when the plan allows the size.
 */
export function deferrableBodyCap(cap: BodyCap, isDeferring: (c: Context) => boolean): MiddlewareHandler {
  const streamCap = bodyLimit({ maxSize: cap.maxBytes, onError: cap.onError });
  return (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap.maxBytes && isDeferring(c)) {
      c.set('bodyRefusal', () => cap.onError(c));
      // Rebuilt from the URL, the method and the headers: a `body: null`
      // in a Request init keeps the input's body (the Fetch spec), so the
      // drop must be a request that never had one.
      const raw = c.req.raw;
      c.req.raw = new Request(raw.url, { method: raw.method, headers: raw.headers, signal: raw.signal });
      return next();
    }
    return streamCap(c, next);
  };
}
