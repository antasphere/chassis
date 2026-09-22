import type { Context } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * A body-size refusal the size cap DEFERRED (PRDCT-2632): the request
     * declared a Content-Length over the tool's cap on a route that declares
     * a plan limit, so the plan gate must judge the declared size first (a
     * metered account meets 403 `plan_required` with the upgrade link at any
     * size, never the instance-cap 413 in its place). While it is pending
     * NOTHING reads the body — the JSON depth scan and the idempotency claim
     * step aside — and the gate fires it right after the plan check, or
     * before anything else when no plan applies. Undefined otherwise.
     */
    bodyRefusal: (() => Response) | undefined;
  }
}

/** The pending deferred refusal of this request, if any. */
export function pendingBodyRefusal(c: Context): (() => Response) | undefined {
  return c.get('bodyRefusal');
}
