import type { Context } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * A body-size refusal the size cap DEFERRED (PRDCT-2632): the request
     * declared a Content-Length over the tool's cap on a route whose gate
     * judges a plan limit, so the gate must see the declared size first (a
     * metered account meets 403 `plan_required` with the upgrade link at any
     * size, never the instance-cap 413 in its place). The cap DROPS the
     * request's body when it defers (`c.req.raw` is rebuilt without one), so
     * nothing downstream can read a byte of it by construction; the gate
     * fires the refusal right after the plan check, or before anything else
     * when no plan applies. Undefined otherwise.
     */
    bodyRefusal: (() => Response) | undefined;
  }
}

/** The pending deferred refusal of this request, if any. */
export function pendingBodyRefusal(c: Context): (() => Response) | undefined {
  return c.get('bodyRefusal');
}
