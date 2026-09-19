import type { Context } from 'hono';
import type { Principal } from '@antasphere/chassis-contract';

/**
 * The part of the rate-limit module the credential resolver
 * (`auth-context.ts`) depends on: the client-identity function type and the
 * request-quota decision shape with its headers. The limiter factory, the
 * `rateLimit` middleware and the quota service itself follow in the
 * middleware step; they still live in the app's `middleware/rate-limit.ts`.
 */
export type ClientIpFn = (c: Context) => string;

/** Outcome of one quota consume — everything the HTTP layer needs for headers. */
export interface QuotaDecision {
  ok: boolean;
  /** The sustained per-minute limit (what RateLimit-Limit reports). */
  limit: number;
  remaining: number;
  /** Seconds until the sustained window resets. */
  resetSeconds: number;
  /** Present when ok=false: seconds the client should wait before retrying. */
  retryAfterSeconds?: number;
}

export interface RequestQuotaService {
  /** Consume one request for this principal; null = quota disabled (no headers). */
  consume(principal: Principal): Promise<QuotaDecision | null>;
}

/** RateLimit draft headers + the X- legacy mirror; reset values are delta seconds. */
export function quotaHeaderEntries(d: QuotaDecision): Array<[string, string]> {
  const remaining = String(Math.max(0, d.remaining));
  const reset = String(Math.max(0, d.resetSeconds));
  const limit = String(d.limit);
  return [
    ['RateLimit-Limit', limit],
    ['RateLimit-Remaining', remaining],
    ['RateLimit-Reset', reset],
    ['X-RateLimit-Limit', limit],
    ['X-RateLimit-Remaining', remaining],
    ['X-RateLimit-Reset', reset]
  ];
}
