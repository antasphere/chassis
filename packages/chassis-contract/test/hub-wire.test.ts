import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildWireSnapshot,
  CHASSIS_WIRE_DEFINITIONS,
  chassisWireSnapshot,
  compareWireSnapshots,
  type HubToolWireSnapshot,
  type WireInputs
} from '../src/index.js';

/**
 * The hub–tool wire check (PRDCT-2677). First the compare itself, on a
 * snapshot the chassis builds from its own copies, so it is proven without
 * any hub file; then the cross-check against the hub's snapshot, found the
 * way `scripts/hub-wire-check.mjs` finds it (`HUB_WIRE_SNAPSHOT`, else the
 * hub checkout beside this repository), skipped when neither is there. CI
 * runs the script against the hub's `dev` (the `hub-wire` job).
 */

const ACCOUNT = '0b6c7c1e-4f4e-4a7b-9c1d-2e3f4a5b6c7d';
const INPUTS: WireInputs = {
  occurrenceOffsetsMs: [0, 5 * 60 * 1000 + 1],
  probes: {
    usageEvent: [{ name: 'empty', input: {} }],
    usageEventsBatch: [{ name: 'empty batch', input: { events: [] } }],
    usageIngestResult: [
      { name: 'no results', input: { results: [], accepted: 0, duplicate: 0, rejected: 0 } }
    ],
    usageEntitlements: [{ name: 'missing everything', input: {} }],
    usageCheckRequest: [
      { name: 'plain', input: { accountRef: ACCOUNT, actionKey: 'things.publish', quantity: 1 } }
    ],
    usageCheck: [
      {
        name: 'unpriceable',
        input: {
          accountRef: ACCOUNT,
          actionKey: 'things.publish',
          quantity: 1,
          allowed: false,
          credits: Number.MAX_SAFE_INTEGER,
          balance: 0,
          unit: 'call',
          priced: true,
          plan: 'free',
          reason: 'unpriceable',
          topUpUrl: 'https://account.example/billing/top-up'
        }
      }
    ]
  }
};

const clone = (s: HubToolWireSnapshot): HubToolWireSnapshot => JSON.parse(JSON.stringify(s));

describe('compareWireSnapshots', () => {
  const base = clone(buildWireSnapshot(CHASSIS_WIRE_DEFINITIONS, INPUTS));

  it('finds nothing between a snapshot and itself, and the chassis rebuilds it on its own inputs', () => {
    expect(compareWireSnapshots(base, clone(base))).toEqual([]);
    expect(compareWireSnapshots(base, clone(chassisWireSnapshot(base)))).toEqual([]);
  });

  it('names a constant, a probe verdict and a schema leaf by their paths', () => {
    const other = clone(base);
    (other.constants.USAGE_CHECK_REASONS as string[])[2] = 'over_quota';
    other.probes.usageCheck[0]!.ok = !other.probes.usageCheck[0]!.ok;
    const reason = (
      other.schemas.usageCheck as { properties: { reason: { anyOf: Array<{ enum?: string[] }> } } }
    ).properties.reason.anyOf[0]!;
    reason.enum = ['insufficient_credits', 'account_suspended'];
    const differences = compareWireSnapshots(base, other);
    expect(differences.map((d) => d.path)).toEqual([
      'constants.USAGE_CHECK_REASONS[2]',
      'probes.usageCheck[0].ok',
      'schemas.usageCheck.properties.reason.anyOf[0].enum'
    ]);
    expect(differences[0]).toEqual({
      path: 'constants.USAGE_CHECK_REASONS[2]',
      hub: 'unpriceable',
      chassis: 'over_quota'
    });
  });

  it('treats an absent key as undefined and names an added one', () => {
    const other = clone(base);
    (other.constants.USAGE_ROUTE_ERRORS as Record<string, number | undefined>).payment_required = undefined;
    expect(compareWireSnapshots(base, other)).toEqual([]);
    (other.constants.USAGE_ROUTE_ERRORS as Record<string, number>).payment_required = 402;
    expect(compareWireSnapshots(base, other)).toEqual([
      { path: 'constants.USAGE_ROUTE_ERRORS.payment_required', hub: undefined, chassis: 402 }
    ]);
  });
});

// The hub's file, found as the script finds it: from this package, five levels up is labs/products/antasphere/.
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING = path.resolve(PACKAGE_DIR, '../../../../../hub/packages/contract/wire/hub-tool-messages.json');
const HUB_FILE = process.env.HUB_WIRE_SNAPSHOT ? path.resolve(process.env.HUB_WIRE_SNAPSHOT) : SIBLING;

describe('the chassis’s copies against the hub’s wire snapshot', () => {
  if (!existsSync(HUB_FILE)) {
    it.skip(`skipped: no hub snapshot at ${HUB_FILE} (set HUB_WIRE_SNAPSHOT; CI runs the hub-wire job)`, () => {});
    return;
  }
  it(`agree with ${HUB_FILE}`, () => {
    const hub = JSON.parse(readFileSync(HUB_FILE, 'utf8')) as HubToolWireSnapshot;
    const differences = compareWireSnapshots(hub, clone(chassisWireSnapshot(hub)));
    expect(differences, JSON.stringify(differences, null, 2)).toEqual([]);
  });
});
