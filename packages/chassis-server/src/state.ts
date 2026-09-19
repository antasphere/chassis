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
