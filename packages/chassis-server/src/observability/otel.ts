import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import { routeLabel } from '../route-label.js';

/**
 * Tracing with the zero-phone-home default: spans are recorded ONLY when an
 * operator configures OTEL_EXPORTER_OTLP_ENDPOINT — without it no exporter
 * is registered and nothing leaves the instance. The request id rides every
 * span as `request.id`, which is the correlation key across log line, span,
 * and audit row.
 */
export interface Otel {
  tracer: Tracer;
  middleware: MiddlewareHandler;
  shutdown: () => Promise<void>;
}

export async function createOtel(
  env: Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'APP_VERSION' | 'EDITION'>,
  logger: Logger,
  options: { serviceName: string }
): Promise<Otel> {
  const resource = resourceFromAttributes({
    'service.name': options.serviceName,
    'service.version': env.APP_VERSION,
    'deployment.environment.name': env.EDITION
  });

  const spanProcessors = [];
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    spanProcessors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }))
    );
    logger.info({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'otel export enabled');
  }

  const provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();
  const tracer = trace.getTracer(options.serviceName);

  const middleware: MiddlewareHandler = async (c, next) => {
    // Start with a low-cardinality name (the matched route pattern isn't known
    // until after routing); rename to the pattern in `finally` so span names
    // stay bounded — a raw path with ids would explode span cardinality.
    await tracer.startActiveSpan(`HTTP ${c.req.method}`, async (span) => {
      span.setAttributes({
        'http.request.method': c.req.method,
        'request.id': c.get('requestId')
      });
      try {
        await next();
      } finally {
        // The MATCHED ROUTE PATTERN, never the raw path (route-label.ts): a
        // span attribute is exported OFF-INSTANCE, so a `/v/<share secret>`
        // there hands a working capability to the trace backend.
        const route = routeLabel(c);
        span.updateName(`${c.req.method} ${route}`);
        span.setAttributes({
          'http.route': route,
          'url.path': route,
          'http.response.status_code': c.error ? 500 : c.res.status
        });
        span.end();
      }
    });
  };

  return {
    tracer,
    middleware,
    shutdown: () => provider.shutdown()
  };
}
