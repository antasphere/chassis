import { constants as FS } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Writing SERVER-CHOSEN paths to a developer's disk, safely.
 *
 * `slideless pull` and `slideless files download` both materialize names the
 * instance picked (a manifest path, a stored filename). That makes the local
 * filesystem the last line of defence, and a lexical `resolve()` +
 * `startsWith()` is not one: it says nothing about symlinks. Three rules,
 * enforced here so both call sites get the same ones:
 *
 *  1. the path must be relative and stay inside the destination LEXICALLY;
 *  2. the parent directory, after `realpath()`, must still be inside the
 *     destination (a symlinked sub-directory is a way out);
 *  3. the final component is opened `O_NOFOLLOW`, so an existing symlink is
 *     refused rather than written through, and the file's mode is forced to
 *     0644 — `O_TRUNC` on an existing file PRESERVES its mode, which is how
 *     an already-executable path stays executable after a hostile pull.
 */

/** Thrown when a write target fails containment; the CLI turns it into exit 1. */
export class UnsafeWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWriteError';
  }
}

/** Lexical containment: `relPath` must resolve to something under `root`. */
export function resolveInside(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new UnsafeWriteError(`Refusing to write an absolute path: ${relPath}`);
  }
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsafeWriteError(`Refusing to write outside ${root}: ${relPath}`);
  }
  return target;
}

/**
 * Create (recursively) the parent of `target` and prove that the REAL
 * directory it lands in is still inside `root`. `mkdir -p` happily walks
 * through an existing symlinked directory, so this must run after it.
 */
async function prepareParent(root: string, target: string): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const realRoot = await realpath(root);
  const realParent = await realpath(parent);
  const rel = relative(realRoot, realParent);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new UnsafeWriteError(
      `Refusing to write through a symlinked directory: ${parent} resolves to ${realParent}, ` +
        `outside ${realRoot}`
    );
  }
}

/**
 * Write `bytes` at `root`/`relPath` under all three rules above. Returns the
 * absolute path written.
 */
export async function writeContained(root: string, relPath: string, bytes: Uint8Array): Promise<string> {
  const target = resolveInside(root, relPath);
  await prepareParent(root, target);
  await writeNoFollow(target, bytes);
  return target;
}

/**
 * Write `bytes` to an exact path, refusing to follow a symlink there and
 * forcing mode 0644 (never inherit an existing file's executable bit).
 */
export async function writeNoFollow(target: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ELOOP (POSIX) / EMLINK (some BSDs) — the target exists and is a symlink.
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new UnsafeWriteError(`Refusing to write through the symlink at ${target}`);
    }
    throw e;
  }
  try {
    await handle.writeFile(bytes);
    // O_TRUNC keeps the existing mode; re-assert it so a pull can never
    // leave a file executable (or group/world-writable) behind.
    await handle.chmod(0o644).catch(() => undefined);
  } finally {
    await handle.close();
  }
}

/**
 * Stream `source` to `root`/`relPath` under the same three rules as
 * `writeContained`, for a body too large to buffer (a zip of respondent
 * uploads). Returns the absolute path and the byte count. A failed stream
 * removes the partial file — a truncated archive must not look like a
 * finished one.
 */
export async function streamContained(
  root: string,
  relPath: string,
  source: Readable
): Promise<{ path: string; sizeBytes: number }> {
  const target = resolveInside(root, relPath);
  await prepareParent(root, target);
  let handle;
  try {
    handle = await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new UnsafeWriteError(`Refusing to write through the symlink at ${target}`);
    }
    throw e;
  }
  try {
    await handle.chmod(0o644).catch(() => undefined);
    const sink = handle.createWriteStream();
    await pipeline(source, sink);
    return { path: target, sizeBytes: sink.bytesWritten };
  } catch (e) {
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw e;
  }
}
