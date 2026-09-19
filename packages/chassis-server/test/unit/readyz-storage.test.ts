import { describe, expect, it } from 'vitest';
import { healthRoutes } from '@antasphere/chassis-server/routes';
import { createRuntimeState } from '@antasphere/chassis-server/util';

/**
 * OPS-4: /readyz must be a LIVE claim about the backing store, not a memory
 * of the boot-time probe.
 *
 * The failure this guards is not theoretical: a restore that dies after
 * wiping /data leaves the app running against storage it cannot write, and
 * the old readiness route — a boot-time boolean — kept answering 200. A load
 * balancer therefore kept sending it traffic, and the operator's own drill
 * reported the instance healthy.
 */
function readyState() {
  const state = createRuntimeState();
  state.ready = true;
  state.reason = '';
  return state;
}

describe('/readyz asserts storage reachability', () => {
  it('503s with reason "storage" when the store is unwritable, even though boot said ready', async () => {
    const state = readyState();
    const app = healthRoutes(state, {
      probeStorage: () => Promise.reject(new Error('EROFS: /data/tmp is read-only'))
    });

    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', reason: 'storage' });
  });

  it('200s when the store is writable', async () => {
    const app = healthRoutes(readyState(), { probeStorage: () => Promise.resolve() });
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });

  it('never leaks the driver error text to the unauthenticated endpoint', async () => {
    const app = healthRoutes(readyState(), {
      probeStorage: () => Promise.reject(new Error('s3: bucket acme-prod-secrets AccessDenied'))
    });
    const body = await (await app.request('/readyz')).text();
    expect(body).not.toContain('acme-prod-secrets');
    expect(body).not.toContain('AccessDenied');
  });

  it('flips back to 503 when a healthy instance loses its storage later', async () => {
    let fail = false;
    let clock = 0;
    const app = healthRoutes(readyState(), {
      probeStorage: () => (fail ? Promise.reject(new Error('gone')) : Promise.resolve()),
      storageProbeTtlMs: 10,
      now: () => clock
    });

    expect((await app.request('/readyz')).status).toBe(200);
    fail = true;
    clock += 1000; // past the success TTL
    expect((await app.request('/readyz')).status).toBe(503);
  });

  it('caches a SUCCESS for the TTL but never caches a FAILURE', async () => {
    let probes = 0;
    let fail = false;
    let clock = 0;
    const app = healthRoutes(readyState(), {
      probeStorage: () => {
        probes++;
        return fail ? Promise.reject(new Error('gone')) : Promise.resolve();
      },
      storageProbeTtlMs: 10_000,
      now: () => clock
    });

    await app.request('/readyz');
    await app.request('/readyz');
    await app.request('/readyz');
    expect(probes, 'successes are cached for the TTL').toBe(1);

    clock += 10_001;
    fail = true;
    await app.request('/readyz');
    await app.request('/readyz');
    // A failure must re-probe every time so recovery is seen immediately.
    expect(probes).toBe(3);

    fail = false;
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('coalesces concurrent probes into one call', async () => {
    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = healthRoutes(readyState(), {
      probeStorage: () => {
        probes++;
        return gate;
      }
    });

    const all = Promise.all([app.request('/readyz'), app.request('/readyz'), app.request('/readyz')]);
    release();
    for (const res of await all) expect(res.status).toBe(200);
    expect(probes).toBe(1);
  });

  it('reports the failure to the logger hook', async () => {
    const seen: unknown[] = [];
    const app = healthRoutes(readyState(), {
      probeStorage: () => Promise.reject(new Error('EROFS')),
      onStorageFailure: (err) => seen.push(err)
    });
    await app.request('/readyz');
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('EROFS');
  });

  it('keeps draining and not-yet-ready ahead of the storage probe', async () => {
    let probes = 0;
    const state = createRuntimeState(); // ready=false, reason='booting'
    const app = healthRoutes(state, {
      probeStorage: () => {
        probes++;
        return Promise.resolve();
      }
    });

    let res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', reason: 'booting' });

    state.ready = true;
    state.reason = '';
    state.draining = true;
    res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', reason: 'draining' });
    expect(probes, 'no pointless writes against the store while shutting down').toBe(0);
  });

  it('/healthz stays dependency-free — it must not touch storage', async () => {
    let probes = 0;
    const app = healthRoutes(readyState(), {
      probeStorage: () => {
        probes++;
        return Promise.reject(new Error('gone'));
      }
    });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(probes).toBe(0);
  });
});
