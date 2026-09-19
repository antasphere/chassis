import type { UsageEvent, UsageSink } from '@antasphere/chassis-contract';

/**
 * Default UsageSink: drop everything. Domain code always emits usage events
 * (they double as local analytics hooks); only a rail-connected sink turns
 * them into billing. Zero phone-home is the default posture — nothing leaves
 * the instance unless an operator explicitly configures a sink.
 */
export class NoopUsageSink implements UsageSink {
  async emit(_event: UsageEvent): Promise<void> {
    // intentionally empty
  }
}
