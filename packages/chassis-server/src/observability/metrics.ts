import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { files, type Db } from '@antasphere/chassis-db';
import type PgBoss from 'pg-boss';
import { constantTimeEquals } from '../constant-time.js';
import { USAGE_QUEUE } from '../jobs/pgboss.js';
import { routeLabel } from '../route-label.js';

/**
 * Prometheus surface. Route labels use the MATCHED pattern (not the raw
 * path) so label cardinality stays bounded. Queue depth and storage bytes
 * are collected lazily at scrape time.
 */
export interface Metrics {
  registry: Registry;
  middleware: MiddlewareHandler;
  routes: (token: string | undefined) => Hono;
}

export function createMetrics(db: Db, boss: PgBoss): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry]
  });

  new Gauge({
    name: 'job_queue_depth',
    help: 'Pending jobs in the usage queue',
    registers: [registry],
    async collect() {
      try {
        this.set((await boss.getQueueSize(USAGE_QUEUE)) ?? 0);
      } catch {
        // queue may not exist yet (api-only role before first worker boot)
      }
    }
  });

  new Gauge({
    name: 'storage_bytes_total',
    help: 'Bytes referenced by live file rows',
    registers: [registry],
    async collect() {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${files.sizeBytes}), 0)::text` })
        .from(files)
        .where(sql`${files.deletedAt} IS NULL`);
      this.set(Number(row?.total ?? '0'));
    }
  });

  const middleware: MiddlewareHandler = async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const seconds = (performance.now() - start) / 1000;
      httpDuration.observe(
        {
          method: c.req.method,
          // routeLabel, same as the log line and the span: on the pinned
          // Hono the previous `?? c.req.path` fallback was unreachable
          // (routePath always answers a string here), but a raw-path
          // expression in a label position is exactly what must not come
          // back to life on a version bump — one shared, secret-free
          // label instead (PRIV-1).
          route: routeLabel(c),
          status: String(c.error ? 500 : c.res.status)
        },
        seconds
      );
    }
  };

  const routes = (token: string | undefined): Hono => {
    const app = new Hono();
    app.get('/metrics', async (c) => {
      // Default-closed: route names, queue depth, and storage totals are not
      // for the open internet. setup.sh generates a METRICS_TOKEN.
      if (!token) {
        return c.text('metrics disabled: set METRICS_TOKEN', 401);
      }
      const auth = c.req.header('authorization') ?? '';
      if (!constantTimeEquals(auth, `Bearer ${token}`)) {
        return c.text('unauthorized', 401);
      }
      c.header('content-type', registry.contentType);
      return c.body(await registry.metrics());
    });
    return app;
  };

  return { registry, middleware, routes };
}
