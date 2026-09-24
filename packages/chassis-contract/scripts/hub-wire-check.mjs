#!/usr/bin/env node
// The hub–tool wire check (PRDCT-2677): the hub owns the messages the tools
// exchange with it and publishes them as ONE generated snapshot
// (`packages/contract/wire/hub-tool-messages.json` of antasphere/hub). This
// script rebuilds the same snapshot from the chassis's copies
// (`src/entitlements.ts`), with the builder copied verbatim from the hub
// (`src/wire.ts`) on the offsets and probe inputs read from the hub's file,
// and fails on any difference. One way only: the hub changes first, this
// check goes red, the chassis follows.
//
// The hub's file: `HUB_WIRE_SNAPSHOT` when set (the `hub-wire` CI job points
// it at a sparse checkout of the hub's `dev`), else the hub checkout beside
// this repository in the Antasphere workspace. This package sits at
// labs/products/antasphere/tools/slideless/<checkout>/packages/chassis-contract,
// so five levels up (packages, <checkout>, slideless, tools, antasphere) is
// labs/products/antasphere/, where the hub lives as `hub/`.
//
// Needs the package built first (`pnpm --filter @antasphere/chassis-contract build`).
// Exit 0: the copies agree. Exit 1: differences, each named by its path. Exit 2: no hub file.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING = path.resolve(PACKAGE_DIR, '../../../../../hub/packages/contract/wire/hub-tool-messages.json');
const file = process.env.HUB_WIRE_SNAPSHOT ? path.resolve(process.env.HUB_WIRE_SNAPSHOT) : SIBLING;

if (!existsSync(file)) {
  console.error(`hub–tool wire: the hub's snapshot is not at ${file}.`);
  console.error(
    '  Give it with HUB_WIRE_SNAPSHOT=<path to hub-tool-messages.json>, or check the hub out beside this repository'
  );
  console.error(`  (${SIBLING}).`);
  process.exit(2);
}

const { chassisWireSnapshot, compareWireSnapshots, describeWireSnapshot } = await import('../dist/index.js');

const hub = JSON.parse(readFileSync(file, 'utf8'));
// The chassis's snapshot goes through JSON exactly as the hub's did on its way to the file.
const chassis = JSON.parse(JSON.stringify(chassisWireSnapshot(hub)));
const differences = compareWireSnapshots(hub, chassis);

const show = (value) => {
  const text = value === undefined ? 'absent' : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

if (differences.length > 0) {
  console.error(
    `hub–tool wire: ${differences.length} difference(s) between the hub's snapshot and the chassis's copies:`
  );
  for (const d of differences) console.error(`  ${d.path}: hub ${show(d.hub)} · chassis ${show(d.chassis)}`);
  console.error(
    'The hub owns these definitions and the chassis follows: fix the copies in packages/chassis-contract/src/entitlements.ts.'
  );
  process.exit(1);
}

console.log(
  `hub–tool wire: the chassis's copies agree with the hub's snapshot (${describeWireSnapshot(hub)}).`
);
