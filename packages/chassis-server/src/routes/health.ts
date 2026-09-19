import { Hono } from 'hono';
import type { RuntimeState } from '../state.js';

/**
 * /healthz — liveness. No dependencies: answers 200 whenever the event loop
 * runs, so orchestrators never restart a replica that is merely waiting on
 * the database.
 *
 * /readyz — readiness. 503 until env is parsed, migrations are applied (or
 * confirmed current), and the DB is reachable; 503 again while draining; and
 * 503 whenever the backing store stops being writable.
 *
 * That last clause is the whole point of `probeStorage`. Readiness used to be
 * a boot-time boolean, so the storage probe ran exactly once, at startup: an
 * instance whose /data volume was emptied, unmounted or turned read-only
 * after boot — the state a failed restore leaves behind — kept answering 200
 * and kept taking traffic it could not serve. Readiness has to be a live
 * claim about the dependencies, not a memory of them.
 */
export interface HealthDeps {
  /** Re-probe the backing store. Must throw when it is not writable. */
  probeStorage?: () => Promise<void>;
  /** How long a SUCCESSFUL probe is trusted before it re-runs. */
  storageProbeTtlMs?: number;
  /** Called with the probe failure so it lands in the logs. */
  onStorageFailure?: (err: unknown) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Successes are cached briefly so a fast readiness poll does not become a
 * PUT+DELETE per second against S3. Failures are NEVER cached: the next
 * request re-probes, so recovery is observed immediately.
 */
const DEFAULT_STORAGE_PROBE_TTL_MS = 10_000;

export function healthRoutes(state: RuntimeState, deps: HealthDeps = {}): Hono {
  const app = new Hono();
  const { probeStorage, onStorageFailure } = deps;
  const ttlMs = deps.storageProbeTtlMs ?? DEFAULT_STORAGE_PROBE_TTL_MS;
  const now = deps.now ?? (() => Date.now());

  let trustedUntil = 0;
  let inflight: Promise<unknown> | null = null;

  /** Resolves to the failure, or null when storage is reachable. */
  function checkStorage(): Promise<unknown> {
    if (!probeStorage) return Promise.resolve(null);
    if (now() < trustedUntil) return Promise.resolve(null);
    // One probe at a time: a burst of readiness polls must not fan out into a
    // burst of writes against the store.
    const pending = (inflight ??= (async () => {
      try {
        await probeStorage();
        trustedUntil = now() + ttlMs;
        return null;
      } catch (err) {
        trustedUntil = 0;
        onStorageFailure?.(err);
        return err ?? new Error('storage probe failed');
      } finally {
        inflight = null;
      }
    })());
    return pending;
  }

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    if (state.draining) return c.json({ status: 'unavailable', reason: 'draining' }, 503);
    if (!state.ready) return c.json({ status: 'unavailable', reason: state.reason }, 503);
    // The reason stays coarse on purpose: /readyz is unauthenticated and a
    // driver's error text carries bucket names and filesystem paths.
    if (await checkStorage()) return c.json({ status: 'unavailable', reason: 'storage' }, 503);
    return c.json({ status: 'ready' });
  });
  return app;
}
