import { describe, expect, it } from 'vitest';
import {
  USAGE_EVENT_MAX_FUTURE_MS,
  USAGE_EVENT_MAX_PAST_MS,
  usageEventOccurrenceIssue
} from '@antasphere/chassis-contract';

/**
 * The pin of the hub's occurredAt window as the chassis copies it
 * (PRDCT-2644): the two bounds, their inclusive edges and the two messages
 * byte for byte. The agreement with the hub's own definitions is the wire
 * check's (PRDCT-2677): `pnpm --filter @antasphere/chassis-contract
 * wire:check`, the `hub-wire` CI job, whose snapshot carries the bounds and
 * the occurrence table on the hub's offsets.
 */

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const RECEIVED = new Date('2026-09-23T12:00:00.000Z');
const at = (offsetMs: number) => new Date(RECEIVED.getTime() + offsetMs);

const PAST_MESSAGE = 'more than 7 days before the hub received the event';
const FUTURE_MESSAGE = 'more than 5 minutes after the hub received the event';

describe('the hub’s occurredAt window, mirrored (PRDCT-2644)', () => {
  it('seven days back, five minutes forward', () => {
    expect(USAGE_EVENT_MAX_PAST_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(USAGE_EVENT_MAX_FUTURE_MS).toBe(5 * 60 * 1000);
  });

  it('answers null inside the window, both bounds inclusive', () => {
    expect(usageEventOccurrenceIssue(at(0), RECEIVED)).toBeNull();
    expect(usageEventOccurrenceIssue(at(-7 * DAY), RECEIVED)).toBeNull();
    expect(usageEventOccurrenceIssue(at(5 * MIN), RECEIVED)).toBeNull();
    expect(usageEventOccurrenceIssue(at(-3 * DAY), RECEIVED)).toBeNull();
  });

  it('names occurredAt with the two messages, byte for byte, one millisecond past each bound', () => {
    expect(usageEventOccurrenceIssue(at(-7 * DAY - 1), RECEIVED)).toEqual({
      path: 'occurredAt',
      message: PAST_MESSAGE
    });
    expect(usageEventOccurrenceIssue(at(5 * MIN + 1), RECEIVED)).toEqual({
      path: 'occurredAt',
      message: FUTURE_MESSAGE
    });
  });
});
