#!/usr/bin/env node
/**
 * The release motion of the chassis. Five packages are published from this
 * repository (@antasphere/chassis-contract, -db, -sdk, -server and -cli), and
 * they move in LOCKSTEP: one version for the whole chassis, carried by the
 * root package.json and the five packages/chassis-* package.json files alike.
 * The packages depend on one another (the server on the contract and the db,
 * the sdk and the CLI on the contract), so a tool that pins one chassis number
 * gets a set that was built, tested and released together, and never has to
 * work out which -server goes with which -contract.
 *
 * Two commands:
 *
 *   node scripts/release.mjs patch|minor|major [--title "…"] [--push] [--dry-run]
 *
 *     On a clean `main` checkout: bumps the six package.json files together,
 *     commits `chore(release): chassis X.Y.Z[ — title]`, and makes the
 *     ANNOTATED tag vX.Y.Z on that commit with the same subject. It pushes
 *     nothing unless --push (main + the tag). Never derives the bump from
 *     commit subjects, and never auto-increments: the kind is the one
 *     argument, chosen by the human.
 *
 *   node scripts/release.mjs guard
 *
 *     The structural check CI and release.yml run first: refuses when the
 *     package version already carries a v-tag on ANOTHER commit, i.e. a
 *     release that forgot the bump and would publish a lookalike of a
 *     previous one (npm refuses a version twice, so the packages would quietly
 *     not move). A version with no tag (moved, not yet tagged) and a tag
 *     pointing at HEAD (this very release) both pass. The tag namespace it
 *     trusts is ORIGIN's (`git ls-remote`), which a shallow or `--no-tags`
 *     checkout cannot hide from it; without an origin it reads the local tags
 *     and refuses a shallow checkout outright, since "no tag here" would then
 *     mean "no tag fetched", and a gate that passes on missing data is no gate.
 *
 *     The guard also refuses when the version carriers disagree (a half-bumped
 *     release), so a package left behind the others fails before anything ships.
 *
 * The publish happens on the tag: pushing vX.Y.Z runs release.yml, which runs
 * this guard, checks the tag against the root version and publishes the five
 * packages to npm at that version, skipping any npm already has.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_FILES = [
  'package.json',
  'packages/chassis-contract/package.json',
  'packages/chassis-db/package.json',
  'packages/chassis-sdk/package.json',
  'packages/chassis-server/package.json',
  'packages/chassis-cli/package.json'
];
const RELEASE_BRANCH = 'main';
const KINDS = ['patch', 'minor', 'major'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  // The `::error::` prefix makes the line a GitHub annotation when this runs
  // in a workflow; locally it is just the first word of the reason.
  console.error(`::error::${message}`);
  process.exit(1);
}

function git(args, { root, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return { status: r.status, out: (r.stdout || '').trim() };
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) fail('not inside a git repository');
  return r.stdout.trim();
}

/** The TOP-LEVEL version each package file declares (parsed, never grepped); all must agree and be a plain semver. */
function readVersion(root) {
  const seen = VERSION_FILES.map((f) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    } catch (e) {
      fail(`${f} is not valid JSON: ${e.message}`);
    }
    if (typeof parsed.version !== 'string') fail(`${f} has no top-level "version" field`);
    return { file: f, version: parsed.version };
  });
  const versions = new Set(seen.map((s) => s.version));
  if (versions.size !== 1) {
    fail(
      `the package files disagree: ${seen.map((s) => `${s.file} ${s.version}`).join(', ')} — fix them before releasing`
    );
  }
  const version = seen[0].version;
  if (!SEMVER.test(version)) fail(`"${version}" is not a plain X.Y.Z semver`);
  return version;
}

function nextVersion(current, kind) {
  const [, major, minor, patch] = current.match(SEMVER).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The JSON nesting depth at the start of each line: 0 before the root brace,
 * 1 inside the root object, deeper inside any nested object or array. Strings
 * (with their escapes) are skipped, so a brace inside a value counts for
 * nothing. Indentation is never consulted: tabs, spaces or none, the depth
 * is the structure's own.
 */
function lineDepths(raw) {
  const depths = [];
  let depth = 0;
  let inString = false;
  let atLineStart = true;
  for (let i = 0; i < raw.length; i++) {
    if (atLineStart) {
      depths.push(depth);
      atLineStart = false;
    }
    const c = raw[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (c === '\n') atLineStart = true;
  }
  return depths;
}

/**
 * Rewrite the top-level version line textually, so the file's formatting
 * (key order, indentation, trailing newline) stays byte-identical. The line
 * is the one carrying the current value at depth 1, the root object's own
 * field (a nested `"version"` under `pnpm.overrides` or `dependencies` sits
 * deeper, however it is indented); the result is re-parsed and must read
 * `next` at the top level, or nothing is written. Every file is prepared
 * before any is touched.
 */
function writeVersion(root, current, next) {
  const prepared = VERSION_FILES.map((f) => {
    const path = join(root, f);
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n');
    const depths = lineDepths(raw);
    const needle = new RegExp(`^\\s*"version":\\s*"${current.replace(/\./g, '\\.')}"`);
    const picks = [];
    for (let i = 0; i < lines.length; i++) if (depths[i] === 1 && needle.test(lines[i])) picks.push(i);
    if (picks.length !== 1) {
      fail(
        `${f}: expected exactly one top-level line carrying "version": "${current}", found ${picks.length} (the field must sit on its own line inside the root object)`
      );
    }
    const pick = picks[0];
    lines[pick] = lines[pick].replace(`"${current}"`, `"${next}"`);
    const updated = lines.join('\n');
    if (JSON.parse(updated).version !== next) {
      fail(`${f}: rewriting line ${pick + 1} did not move the top-level version to ${next}; nothing written`);
    }
    return { path, updated };
  });
  for (const { path, updated } of prepared) writeFileSync(path, updated);
}

/** The commit a local tag points at (annotated tags peeled), or null when the tag does not exist here. */
function localTagTarget(root, tag) {
  const r = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { root, allowFail: true });
  return r.status === 0 ? r.out : null;
}

/**
 * The commit a tag on origin points at, or null when origin has no such tag.
 * An annotated tag's plain line is the TAG object; its commit is the peeled
 * `^{}` line, which ls-remote only prints when that ref is asked for by name.
 */
function remoteTagTarget(root, tag) {
  const out = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { root }).out;
  let plain = null;
  let peeled = null;
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tag}`) plain = sha;
  }
  return peeled ?? plain;
}

function hasOrigin(root) {
  return git(['remote', 'get-url', 'origin'], { root, allowFail: true }).status === 0;
}

function isShallow(root) {
  return git(['rev-parse', '--is-shallow-repository'], { root }).out === 'true';
}

function parseArgs(argv) {
  const args = { kind: null, title: '', push: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') args.push = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--title') {
      args.title = argv[++i] ?? '';
      if (!args.title || args.title.startsWith('--')) fail('--title needs a value');
    } else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else if (args.kind) fail(`one command only (got ${args.kind} and ${a})`);
    else args.kind = a;
  }
  if (args.kind === 'guard' && (args.title || args.push || args.dryRun)) {
    fail('guard takes no options: it reads, and writes nothing');
  }
  return args;
}

function guard(root) {
  const version = readVersion(root);
  const tag = `v${version}`;
  const head = git(['rev-parse', 'HEAD'], { root }).out;

  // Origin's tags are the namespace that counts (another machine may have cut
  // the release), and this checkout's own tags count beside them: a release
  // cut here and not yet pushed lives only in this .git, and a guard run before
  // the tag push must not call that version untagged. Without an origin the
  // local tags stand alone, and only when the checkout holds the whole history.
  const looked = [];
  if (hasOrigin(root)) looked.push({ where: 'origin', target: remoteTagTarget(root, tag) });
  else if (isShallow(root)) {
    fail(
      `cannot verify ${version}: this checkout is shallow and has no origin to ask for the tags — fetch the full history or add the remote`
    );
  }
  looked.push({ where: 'this checkout', target: localTagTarget(root, tag) });

  for (const { where, target } of looked) {
    if (target !== null && target !== head) {
      fail(
        `package version ${version} is already released: ${tag} on ${where} points at ${target.slice(0, 7)}, not at HEAD ${head.slice(0, 7)}. ` +
          `Run \`pnpm release patch|minor|major\` on ${RELEASE_BRANCH} first — a release that keeps the number would publish nothing new under ${tag}.`
      );
    }
  }
  const at = looked.find((l) => l.target === head);
  if (at)
    console.log(`release guard: ${tag} on ${at.where} points at HEAD — this is the ${version} release, ok`);
  else
    console.log(
      `release guard: ${version} carries no tag yet on ${looked.map((l) => l.where).join(' or ')} — the version moved, ok`
    );
}

function release(root, { kind, title, push, dryRun }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { root }).out;
  if (branch !== RELEASE_BRANCH) fail(`releases are cut on ${RELEASE_BRANCH}, this checkout is on ${branch}`);
  // Tracked changes block; untracked files (scratch, build leftovers) do not —
  // they never reach the release commit, which adds the version carriers only.
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { root }).out;
  if (dirty) fail(`the working tree is not clean:\n${dirty}`);

  const current = readVersion(root);
  const next = nextVersion(current, kind);
  const tag = `v${next}`;
  if (localTagTarget(root, tag) !== null) fail(`${tag} already exists locally`);
  if (hasOrigin(root) && remoteTagTarget(root, tag) !== null) fail(`${tag} already exists on origin`);

  const subject = `chore(release): chassis ${next}${title ? ` — ${title}` : ''}`;
  console.log(`${current} → ${next}  (${VERSION_FILES.join(', ')})`);
  console.log(`commit  ${subject}`);
  console.log(`tag     ${tag} (annotated)`);
  if (dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  writeVersion(root, current, next);
  git(['add', ...VERSION_FILES], { root });
  git(['commit', '-q', '-m', subject], { root });
  git(['tag', '-a', tag, '-m', subject], { root });
  const sha = git(['rev-parse', '--short', 'HEAD'], { root }).out;
  console.log(`done    ${sha}`);

  if (push) {
    git(['push', 'origin', RELEASE_BRANCH, tag], { root });
    console.log(`pushed  ${RELEASE_BRANCH} and ${tag} to origin`);
  }
  console.log('');
  console.log('next:');
  if (!push) console.log(`  git push origin ${RELEASE_BRANCH} ${tag}`);
  console.log(
    `  release.yml publishes the five @antasphere/chassis-* packages at ${next} on the ${tag} push`
  );
}

const args = parseArgs(process.argv.slice(2));
const root = repoRoot();
if (args.kind === 'guard') guard(root);
else if (KINDS.includes(args.kind)) release(root, args);
else fail(`usage: release.mjs <${KINDS.join('|')}> [--title "…"] [--push] [--dry-run]  |  release.mjs guard`);
