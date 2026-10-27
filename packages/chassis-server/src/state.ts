import type { Logger } from './logger.js';

/**
 * Process-local runtime state. This is NOT application state (which lives in
 * Postgres per the statelessness invariant) — it is the lifecycle of this one
 * replica: readiness for /readyz and the draining flag for graceful shutdown.
 */
export interface RuntimeState {
  ready: boolean;
  reason: string;
  draining: boolean;
  /**
   * A fail-closed boot verdict (PRDCT-1809): when set, every route except
   * liveness, readiness and metrics answers 503 `service_closed` with this
   * reason. Readiness alone does not stop the API — the single-host
   * deployment's healthcheck watches /healthz — so a boot that found
   * something it must not serve (an erasure it could not replay) closes the
   * surface itself until an operator resolves it and restarts.
   */
  closed: string | null;
}

export function createRuntimeState(): RuntimeState {
  return { ready: false, reason: 'booting', draining: false, closed: null };
}

/** The booted replicas of this process, each closed by an exception nothing caught. */
const closeOnUncaught = new Set<(err: unknown) => void>();

/**
 * The last resort (PRDCT-3583): an exception nothing caught is logged at
 * error level and closes the service surface (`state.closed`, 503
 * `service_closed`, the verdict on /readyz) instead of ending the process
 * with every request in flight. One process listener, however many boots
 * share the process (a test file boots several); each boot registers its own
 * state and logger.
 */
export function closeOnUncaughtException(state: RuntimeState, logger: Logger): void {
  closeOnUncaught.add((err) => {
    logger.error({ err }, 'uncaught exception: the service closes until an operator restarts it');
    state.ready = false;
    // the exception itself stays in the log: /readyz is no place for its message
    state.reason =
      'refusing to serve: an uncaught exception left this process in an unknown state; see the container log, then restart';
    state.closed ??= state.reason;
  });
  if (closeOnUncaught.size === 1) {
    process.on('uncaughtException', (err) => {
      for (const close of closeOnUncaught) close(err);
    });
  }
}
