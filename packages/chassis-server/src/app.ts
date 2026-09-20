import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import type { RuntimeState } from './util/index.js';
import { requestId } from './middleware/index.js';
import { buildCsp, inlineScriptHashes, securityHeaders } from './middleware/index.js';
import { healthRoutes } from './routes/index.js';

export interface AppDeps {
  logger: Logger;
  state: RuntimeState;
  /** Directory holding the built dashboard SPA. */
  publicDir: string;
  /** The tool's name on the no-dashboard page, title and heading alike (`identity.displayName`). */
  displayName: string;
  /** The versioned API, mounted at /api/v1. */
  api: OpenAPIHono;
  /** The bundled MCP endpoint, mounted at /mcp (M6). */
  mcp?: Hono;
  /** Root-level OAuth discovery documents (/.well-known/*, M6). */
  wellKnown?: Hono;
  /**
   * The tool's public routes (for a deck tool the public share-link viewer,
   * /v/{secret}, Phase 4 / ADR 012). Mounted in the public-route slot:
   * OUTSIDE /api/v1, outside the auth/scope middleware — token recipients
   * are anonymous, the path secret is the whole credential, and every
   * user-content response it emits is locked under `CSP: sandbox` (see
   * viewer/routes.ts in the app).
   */
  publicRoutes?: Hono | undefined;
  /** Observability middlewares + the /metrics route (M5). */
  metricsMiddleware?: MiddlewareHandler;
  metricsRoutes?: Hono;
  otelMiddleware?: MiddlewareHandler;
  /**
   * Live readiness probe for the backing store (routes/health.ts). Omitted =
   * /readyz keeps reporting the boot-time storage result forever.
   */
  probeStorage?: () => Promise<void>;
  /** `Strict-Transport-Security` value (security-headers.ts `hstsValue`); null/absent = no HSTS. */
  hsts?: string | null;
  /**
   * The tool's root middleware, installed after the metrics middleware and
   * BEFORE every mount. For a deck tool, VIEWER_BASE_URL (PRDCT-1352): when
   * present, the host gate (middleware/host-gate.ts in the app) — the viewer
   * hostname answers only `/v/*`, `/api/v1/viewer/*` and the probes, every
   * other hostname redirects `/v/*` there. Absent = single-origin behaviour,
   * gate not installed.
   */
  rootMiddleware?: MiddlewareHandler | undefined;
  /** Extra `frame-src` origins of the dashboard CSP (for a deck tool the viewer origin, for the preview). */
  cspFrameSrc?: readonly string[] | undefined;
}

/**
 * The SQLSTATE of a thrown Postgres error, when it is one. node-postgres puts
 * it on `.code`; drizzle re-throws the same object untouched.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Assemble the single Hono app. Route precedence is load-bearing and fixed:
 * health → (api, mcp, well-known — mounted here as the platform grows) →
 * static assets → SPA index fallback LAST. A slot deliberately remains open
 * before the fallback for products that add public content routes.
 */
export async function createApp({
  logger,
  state,
  publicDir,
  displayName,
  api,
  mcp,
  wellKnown,
  publicRoutes,
  metricsMiddleware,
  metricsRoutes,
  otelMiddleware,
  probeStorage,
  hsts,
  rootMiddleware,
  cspFrameSrc
}: AppDeps): Promise<Hono> {
  const app = new Hono();

  // The SPA fallback is read first: its inline bootstrap script hashes feed
  // the CSP that guards every HTML response.
  let indexHtml: string | null = null;
  try {
    indexHtml = await readFile(join(publicDir, 'index.html'), 'utf8');
  } catch {
    logger.warn({ publicDir }, 'no dashboard build found — serving a placeholder at /');
  }
  const csp = buildCsp(indexHtml ? inlineScriptHashes(indexHtml) : [], {
    frameSrc: [...(cspFrameSrc ?? [])]
  });

  app.use('*', requestId(logger));
  app.use('*', securityHeaders({ csp, state, hsts: hsts ?? null }));
  // PRDCT-1809: a fail-closed boot verdict closes the whole surface — the
  // operator-facing probes stay so the verdict is visible (/readyz carries
  // the reason) and the process is not restarted into the same state.
  app.use('*', async (c, next) => {
    if (state.closed === null) return next();
    const path = c.req.path;
    if (path === '/healthz' || path === '/readyz' || path === '/metrics') return next();
    return c.json(
      {
        error: {
          code: 'service_closed',
          message: 'This instance refuses to serve until an operator resolves a boot verdict; see /readyz'
        }
      },
      503
    );
  });
  if (otelMiddleware) app.use('*', otelMiddleware);
  if (metricsMiddleware) app.use('*', metricsMiddleware);
  // PRDCT-1352: the viewer-origin host gate, BEFORE every mount below — the
  // boundary between the two hostnames must be decided before any route
  // (and any cookie-reading middleware) runs.
  if (rootMiddleware) app.use('*', rootMiddleware);

  // Uncaught handler errors: log with the request id, answer the wire shape.
  app.onError((error, c) => {
    // Malformed request bodies first: Hono's body validators throw
    // HTTPException(400) on unparseable JSON ("Malformed JSON in request
    // body") or broken multipart BEFORE zod runs, so the zod-openapi
    // defaultHook never sees them — and Hono routes a thrown error straight
    // here from the throwing handler's own dispatch frame, so an upstream
    // try/catch middleware never observes it either. This is therefore THE
    // seam: map the framework's 400s to the wire shape with a stable
    // machine code instead of amplifying a pre-auth-reachable client
    // mistake into a 500 + an error-level log. Only hono's validators throw
    // HTTPException(400) on this app (the MCP sub-app handles its own).
    if (error instanceof HTTPException && error.status === 400) {
      const isJson = error.message.includes('JSON');
      return c.json(
        {
          error: {
            code: isJson ? 'invalid_json' : 'invalid_body',
            message: isJson ? 'Request body is not valid JSON' : 'Malformed request body'
          }
        },
        400
      );
    }
    // A NUL byte (or any byte the server encoding cannot represent) that
    // reaches Postgres inside a text value raises 22021 / 22P05. It is a
    // CLIENT mistake, anonymously drivable on every free-text sink, but the
    // pg error object carries the offending statement AND its bound
    // parameters — so left alone it becomes a 500 whose error-level log line
    // prints the SQL and the values. Contract-level `noNulString` rejects the
    // known sinks at validation time; this is the backstop for the ones a
    // product forgets, and it must answer 400 with no log.
    const pgCode = postgresErrorCode(error);
    if (pgCode === '22021' || pgCode === '22P05') {
      return c.json(
        {
          error: {
            code: 'invalid_characters',
            message: 'Request contains characters that cannot be stored (e.g. a NUL byte)'
          }
        },
        400
      );
    }
    // JSON.stringify is recursive: a deeply nested body blows the V8 stack
    // (`RangeError`) or exceeds the maximum string length. Both are client
    // input, not server faults. middleware/json-depth.ts rejects these at the
    // edge; this is the backstop for anything that builds a deep structure
    // downstream. Narrow on the two known messages — a RangeError from
    // anywhere else is a real bug and must stay a 500.
    if (
      error instanceof RangeError &&
      /maximum call stack size exceeded|invalid string length/i.test(error.message)
    ) {
      return c.json(
        { error: { code: 'payload_too_deep', message: 'Request payload is nested too deeply' } },
        400
      );
    }
    (c.get('logger') ?? logger).error({ err: error }, 'unhandled error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  app.route(
    '/',
    healthRoutes(state, {
      ...(probeStorage ? { probeStorage } : {}),
      onStorageFailure: (err) => logger.error({ err }, 'storage probe failed — reporting not ready')
    })
  );
  if (metricsRoutes) app.route('/', metricsRoutes);

  app.route('/api/v1', api);
  if (mcp) app.route('/mcp', mcp);
  if (wellKnown) app.route('/', wellKnown);

  // The public-route slot: the share-link viewer lives here — before the
  // static assets and the SPA fallback, after every credentialed surface.
  if (publicRoutes) app.route('/', publicRoutes);

  app.use('*', serveStatic({ root: publicDir }));

  app.get('*', (c) => {
    if (indexHtml) return c.html(indexHtml);
    return c.html(
      `<!doctype html><title>${displayName}</title><h1>${displayName} API is running</h1>` +
        '<p>No dashboard build found. API health: <a href="/healthz">/healthz</a></p>'
    );
  });

  return app;
}
