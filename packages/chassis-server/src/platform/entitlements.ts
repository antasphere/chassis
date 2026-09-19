import type {
  EntitlementDecision,
  EntitlementService,
  MeteredAction,
  Principal,
  RequestQuota
} from '@antasphere/chassis-contract';

/**
 * Default EntitlementService: everything is allowed, bounded only by
 * instance-level env caps. The cloud/central edition swaps this via the
 * registry for a credits-backed implementation; handlers only ever call
 * `entitlements.check(...)` and never know the difference.
 */
export interface InstanceCaps {
  maxFileSizeMb: number;
  /** General-API quota defaults: sustained per-minute + 1 s spike cap (env-driven). */
  apiRequestsPerMinute: number;
  apiRequestsBurstPerSecond: number;
}

export class AllowAllEntitlements implements EntitlementService {
  constructor(private readonly caps: InstanceCaps) {}

  async check(_principal: Principal, action: MeteredAction): Promise<EntitlementDecision> {
    if (action.key === 'files.upload' && action.unit === 'bytes') {
      const max = this.caps.maxFileSizeMb * 1024 * 1024;
      if (action.quantity > max) {
        return { allowed: false, reason: `file exceeds MAX_FILE_SIZE_MB (${this.caps.maxFileSizeMb}MB)` };
      }
    }
    return { allowed: true };
  }

  /**
   * One flat instance-level quota for every principal. A plan-aware edition
   * returns different values per plan here — the enforcing middleware keys
   * buckets by (quota size, principal), so per-plan variation needs no other
   * change.
   */
  async getRequestQuota(_principal: Principal): Promise<RequestQuota> {
    return {
      perMinute: this.caps.apiRequestsPerMinute,
      burstPerSecond: this.caps.apiRequestsBurstPerSecond
    };
  }
}
