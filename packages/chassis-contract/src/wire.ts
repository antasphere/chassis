import { z } from 'zod';
import {
  BILLING_PLANS,
  USAGE_CHECK_REASONS,
  USAGE_EVENT_MAX_FUTURE_MS,
  USAGE_EVENT_MAX_PAST_MS,
  USAGE_EVENTS_BATCH_MAX,
  USAGE_REJECT_REASONS,
  USAGE_ROUTE_ERRORS,
  USAGE_WRITE_SCOPE,
  entitlementProfileSchema,
  usageCheckRequestSchema,
  usageCheckSchema,
  usageEventOccurrenceIssue,
  usageEventSchema,
  usageEventsBatchSchema,
  usageIngestResultSchema
} from './entitlements.js';

/**
 * The chassis's side of the hub–tool wire check (PRDCT-2677). The hub owns
 * the messages the tools exchange with it and publishes them as ONE
 * generated snapshot, `packages/contract/wire/hub-tool-messages.json` of the
 * hub, built by its `packages/contract/src/wire.ts`. The block below, from
 * `WIRE_SCHEMA_KEYS` to `buildWireSnapshot`, is the chassis's copy of that
 * builder, kept VERBATIM so both sides compute the same picture: the same
 * JSON Schema export, the same probe verdicts, the same occurrence table.
 * The hub's inputs (its offsets and probe payloads) and its definitions are
 * NOT copied: the inputs are read back from the hub's file
 * (`wireInputsOf`), the definitions are this package's own copies
 * (`CHASSIS_WIRE_DEFINITIONS`, from `entitlements.ts`).
 *
 * `compareWireSnapshots` names every difference by its dotted path;
 * `scripts/hub-wire-check.mjs` (`pnpm --filter @antasphere/chassis-contract
 * wire:check`, the `hub-wire` CI job against the hub's `dev`) fails on any.
 * The check runs one way: the hub changes first, the chassis follows.
 */

// ── Copied VERBATIM from the hub's packages/contract/src/wire.ts ──────────

/** The keys of the six shapes, the same on both sides. */
export const WIRE_SCHEMA_KEYS = [
  'usageEvent',
  'usageEventsBatch',
  'usageIngestResult',
  'usageEntitlements',
  'usageCheckRequest',
  'usageCheck'
] as const;
export type WireSchemaKey = (typeof WIRE_SCHEMA_KEYS)[number];

export interface WireConstants {
  USAGE_WRITE_SCOPE: string;
  BILLING_PLANS: readonly string[];
  USAGE_EVENTS_BATCH_MAX: number;
  USAGE_EVENT_MAX_PAST_MS: number;
  USAGE_EVENT_MAX_FUTURE_MS: number;
  USAGE_CHECK_REASONS: readonly string[];
  USAGE_REJECT_REASONS: readonly string[];
  USAGE_ROUTE_ERRORS: Readonly<Record<string, number>>;
}

export interface WireProbe {
  name: string;
  input: unknown;
}

export interface WireProbeResult extends WireProbe {
  /** Whether the schema accepts the input. */
  ok: boolean;
}

export interface WireOccurrence {
  /** The event's `occurredAt` minus the receipt time, in milliseconds. */
  offsetMs: number;
  issue: { path: 'occurredAt'; message: string } | null;
}

/** What one side feeds the builder: its own definitions. */
export interface WireDefinitions {
  constants: WireConstants;
  schemas: Record<WireSchemaKey, z.ZodType>;
  occurrenceIssue: (occurredAt: Date, receivedAt: Date) => { path: 'occurredAt'; message: string } | null;
}

/** The inputs the snapshot is computed on: the hub's, read back by the chassis from the hub's file. */
export interface WireInputs {
  occurrenceOffsetsMs: readonly number[];
  probes: Record<WireSchemaKey, readonly WireProbe[]>;
}

export interface HubToolWireSnapshot {
  v: 1;
  constants: WireConstants;
  schemas: Record<WireSchemaKey, unknown>;
  occurrence: WireOccurrence[];
  probes: Record<WireSchemaKey, WireProbeResult[]>;
}

/** A fixed receipt time, so the occurrence table is the same on every run. */
const RECEIVED_AT = new Date('2026-09-23T12:00:00.000Z');

/**
 * Build the snapshot from one side's definitions on the given inputs. The
 * SAME function runs on both sides (the chassis carries a verbatim copy):
 * the hub with its own inputs, the chassis with the inputs read from the
 * hub's file. Deterministic: no clock, no randomness, no environment.
 */
export function buildWireSnapshot(defs: WireDefinitions, inputs: WireInputs): HubToolWireSnapshot {
  const schemas = {} as Record<WireSchemaKey, unknown>;
  const probes = {} as Record<WireSchemaKey, WireProbeResult[]>;
  for (const key of WIRE_SCHEMA_KEYS) {
    const schema = defs.schemas[key];
    // A refinement has no JSON Schema form and is dropped on both sides
    // alike; the probes below carry what it decides.
    schemas[key] = z.toJSONSchema(schema, { unrepresentable: 'any' });
    probes[key] = inputs.probes[key].map((probe) => ({
      name: probe.name,
      input: probe.input,
      ok: schema.safeParse(probe.input).success
    }));
  }
  return {
    v: 1,
    constants: {
      USAGE_WRITE_SCOPE: defs.constants.USAGE_WRITE_SCOPE,
      BILLING_PLANS: [...defs.constants.BILLING_PLANS],
      USAGE_EVENTS_BATCH_MAX: defs.constants.USAGE_EVENTS_BATCH_MAX,
      USAGE_EVENT_MAX_PAST_MS: defs.constants.USAGE_EVENT_MAX_PAST_MS,
      USAGE_EVENT_MAX_FUTURE_MS: defs.constants.USAGE_EVENT_MAX_FUTURE_MS,
      USAGE_CHECK_REASONS: [...defs.constants.USAGE_CHECK_REASONS],
      USAGE_REJECT_REASONS: [...defs.constants.USAGE_REJECT_REASONS],
      USAGE_ROUTE_ERRORS: { ...defs.constants.USAGE_ROUTE_ERRORS }
    },
    schemas,
    occurrence: inputs.occurrenceOffsetsMs.map((offsetMs) => ({
      offsetMs,
      issue: defs.occurrenceIssue(new Date(RECEIVED_AT.getTime() + offsetMs), RECEIVED_AT)
    })),
    probes
  };
}

// ── The chassis's own half ─────────────────────────────────────────────────

/** The chassis's definitions: this package's copies of the hub's shapes, under the hub's keys. */
export const CHASSIS_WIRE_DEFINITIONS: WireDefinitions = {
  constants: {
    USAGE_WRITE_SCOPE,
    BILLING_PLANS,
    USAGE_EVENTS_BATCH_MAX,
    USAGE_EVENT_MAX_PAST_MS,
    USAGE_EVENT_MAX_FUTURE_MS,
    USAGE_CHECK_REASONS,
    USAGE_REJECT_REASONS,
    USAGE_ROUTE_ERRORS
  },
  schemas: {
    usageEvent: usageEventSchema,
    usageEventsBatch: usageEventsBatchSchema,
    usageIngestResult: usageIngestResultSchema,
    usageEntitlements: entitlementProfileSchema,
    usageCheckRequest: usageCheckRequestSchema,
    usageCheck: usageCheckSchema
  },
  occurrenceIssue: usageEventOccurrenceIssue
};

/** The inputs the hub computed its snapshot on, read back from its file: the offsets and the probe payloads. */
export function wireInputsOf(reference: HubToolWireSnapshot): WireInputs {
  const probes = {} as Record<WireSchemaKey, readonly WireProbe[]>;
  for (const key of WIRE_SCHEMA_KEYS) {
    probes[key] = (reference.probes[key] ?? []).map((probe) => ({ name: probe.name, input: probe.input }));
  }
  return {
    occurrenceOffsetsMs: reference.occurrence.map((row) => row.offsetMs),
    probes
  };
}

/** The snapshot the chassis's copies give on the hub's own inputs: what must equal the hub's file. */
export function chassisWireSnapshot(reference: HubToolWireSnapshot): HubToolWireSnapshot {
  return buildWireSnapshot(CHASSIS_WIRE_DEFINITIONS, wireInputsOf(reference));
}

/** One place where the hub's snapshot and the chassis's differ: its dotted path and the two values. */
export interface WireDifference {
  path: string;
  hub: unknown;
  chassis: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? parent === ''
      ? key
      : `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function compareAt(path: string, hub: unknown, chassis: unknown, out: WireDifference[]): void {
  if (Array.isArray(hub) && Array.isArray(chassis)) {
    if (hub.length !== chassis.length) {
      out.push({ path, hub, chassis });
      return;
    }
    for (let i = 0; i < hub.length; i += 1) compareAt(`${path}[${i}]`, hub[i], chassis[i], out);
    return;
  }
  if (isPlainObject(hub) && isPlainObject(chassis)) {
    const keys = [...new Set([...Object.keys(hub), ...Object.keys(chassis)])].sort();
    for (const key of keys) compareAt(childPath(path, key), hub[key], chassis[key], out);
    return;
  }
  if (!Object.is(hub, chassis)) out.push({ path, hub, chassis });
}

/**
 * Every difference between the hub's snapshot and the chassis's, by dotted
 * path (`constants.USAGE_CHECK_REASONS[2]`,
 * `schemas.usageCheck.properties.reason.anyOf[0].enum`,
 * `probes.usageCheck[3].ok`). Objects compare by the union of their keys,
 * order ignored, an absent key and `undefined` being the same; arrays by
 * index, a length difference being one difference at the array's path.
 * Deterministic: keys sorted, arrays in order. Empty when they agree.
 */
export function compareWireSnapshots(
  hub: HubToolWireSnapshot,
  chassis: HubToolWireSnapshot
): WireDifference[] {
  const out: WireDifference[] = [];
  compareAt('', hub, chassis, out);
  return out;
}

/** One line of figures for a snapshot: `6 shapes, N constants, M probes, K occurrence offsets`. */
export function describeWireSnapshot(snapshot: HubToolWireSnapshot): string {
  const shapes = Object.keys(snapshot.schemas).length;
  const constants = Object.keys(snapshot.constants).length;
  const probes = Object.values(snapshot.probes).reduce((n, list) => n + list.length, 0);
  return `${shapes} shapes, ${constants} constants, ${probes} probes, ${snapshot.occurrence.length} occurrence offsets`;
}
