import type { Context } from 'hono';

/**
 * Read a body once, and put the same bytes back: never `clone()` (PRDCT-4441).
 *
 * Node's fetch (undici 6, Node 22) registers a CLONE for cleanup with a weak
 * reference to the ORIGINAL's body stream: once the clone is garbage
 * collected, the original's stream is cancelled if nobody has read it yet.
 * A middleware that reads `raw.clone().text()` and then awaits anything (a
 * session lookup, a database write) before the original is read hands the
 * next garbage collection the original body: the route's validator then
 * finds "Body is unusable: Body has already been read" and the person gets
 * 400 `invalid_json` for a body that was perfectly valid, and a response
 * cloned for a cache reaches the client cut. It shows only under memory
 * pressure: a loaded machine, a busy instance.
 *
 * So the body is read ONCE, as bytes, and the request (or response) is
 * rebuilt around those same bytes: nothing is teed, nothing is registered,
 * and the bytes stay exact (no decode and re-encode of the original).
 */

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * The request's body as text, the request rebuilt on the same bytes so every
 * later reader (Hono's validators, a library handed `c.req.raw`) still finds
 * it. `null` for a bodyless request. A body that cannot be read rejects, as
 * reading the clone did.
 */
export async function readRequestBodyOnce(c: Context): Promise<string | null> {
  const raw = c.req.raw;
  if (!raw.body) return null;
  const bytes = await raw.arrayBuffer();
  c.req.raw = new Request(raw, { body: bytes });
  return new TextDecoder().decode(bytes);
}

/**
 * The response's body as text, beside a response rebuilt on the same bytes,
 * status and headers: hand THAT one on, never the original, whose body is
 * now read.
 */
export async function readResponseBodyOnce(res: Response): Promise<{ text: string; response: Response }> {
  const bytes = await res.arrayBuffer();
  const response = new Response(res.body === null || NULL_BODY_STATUSES.has(res.status) ? null : bytes, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
  return { text: new TextDecoder().decode(bytes), response };
}
