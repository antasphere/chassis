import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import { routeLabel } from '../route-label.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
  }
}

/**
 * First middleware in the chain: binds a request id (propagated from
 * x-request-id when a proxy already assigned one) and a child logger carrying
 * it, and writes the completion log line with latency. Everything downstream
 * (traces, audit entries) reuses this id, which is what makes one request
 * followable across log, trace, and audit.
 */
/** Propagated ids must be sane: bounded length, log-safe charset. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function requestId(base: Logger): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    const log = base.child({ requestId: id });
    c.set('requestId', id);
    c.set('logger', log);
    c.header('x-request-id', id);
    const start = performance.now();
    try {
      await next();
    } finally {
      const latencyMs = Math.round((performance.now() - start) * 100) / 100;
      log.info(
        {
          method: c.req.method,
          // The MATCHED ROUTE PATTERN, never the raw URL path — see
          // route-label.ts. On THIS repo that is not hypothetical: the public
          // viewer is `/v/:secret`, so logging c.req.path wrote every live
          // share-link capability into the log stream, where redaction (which
          // keys off object properties) can do nothing about one opaque
          // string. Read after next() so routing has resolved.
          path: routeLabel(c),
          status: c.error ? 500 : c.res.status,
          latencyMs,
          ...(c.error ? { failed: true } : {})
        },
        'request'
      );
    }
  };
}
