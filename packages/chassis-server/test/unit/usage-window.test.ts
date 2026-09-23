import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  USAGE_EVENT_MAX_FUTURE_MS,
  USAGE_EVENT_MAX_PAST_MS,
  usageEventOccurrenceIssue
} from '@antasphere/chassis-contract';

/**
 * The pin of the hub's occurredAt window as the chassis mirrors it
 * (PRDCT-2644): the two bounds, their inclusive edges and the two messages
 * byte for byte, then the cross-read of the hub's own file when its checkout
 * sits beside this one (`labs/products/antasphere/hub`), so a change on
 * either side that the other did not make fails here.
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

// From packages/chassis-server/test/unit/ up to labs/products/antasphere/, then the hub checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_BILLING = path.resolve(HERE, '../../../../../../../hub/packages/contract/src/schemas/billing.ts');
const hubPresent = existsSync(HUB_BILLING);

describe('the hub’s own file agrees (cross-read)', () => {
  if (!hubPresent) {
    it.skip(`skipped: the hub checkout is not beside this one (looked for ${HUB_BILLING})`, () => {});
    return;
  }
  it(`carries the same bounds and messages (${HUB_BILLING})`, () => {
    const src = readFileSync(HUB_BILLING, 'utf8');
    expect(src).toContain('export const USAGE_EVENT_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;');
    expect(src).toContain('export const USAGE_EVENT_MAX_FUTURE_MS = 5 * 60 * 1000;');
    expect(src).toContain(
      'message: `more than ${USAGE_EVENT_MAX_PAST_MS / 86_400_000} days before the hub received the event`'
    );
    expect(src).toContain(
      'message: `more than ${USAGE_EVENT_MAX_FUTURE_MS / 60_000} minutes after the hub received the event`'
    );
    expect(src).toContain('if (delta < -USAGE_EVENT_MAX_PAST_MS)');
    expect(src).toContain('if (delta > USAGE_EVENT_MAX_FUTURE_MS)');
  });
});
