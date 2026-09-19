import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/**
 * The append-only ERASURE TOMBSTONE (OPS-3, PRDCT-1357).
 *
 * A GDPR erasure that lives only in the database is undone by the next
 * restore from an older dump: the subject's row comes back, their password
 * works again, and the audit row saying they were erased is rolled back
 * with everything else. The tombstone lives OUTSIDE the dump — one JSON
 * line per erased user in `$DATA_DIR/erasures.jsonl` — so it survives the
 * database swap; restore.sh carries the live volume's file forward into
 * the restored tree, and boot REPLAYS it: any tombstoned user present in
 * the database is deleted again, with an audit row recording the replay.
 *
 * The line carries the user id (the replay key) and a KEYED fingerprint of
 * the lowercased email (a second correlation handle for operators, never
 * the address itself — the file is the one artifact that must outlive the
 * erasure it records). Keyed (PRDCT-1811): the file rides in the
 * UNENCRYPTED data tarball of every backup, and a plain hash of a
 * low-entropy value is a dictionary lookup away from the address — an
 * off-site backup would list who asked to be forgotten. HMAC-SHA256 under
 * the instance's auth secret (which travels only in the passphrase-
 * encrypted config archive) keeps the operator's correlation and denies it
 * to anyone holding the tarball alone. Rotating the auth secret changes
 * the fingerprints written from then on; old lines keep their old key.
 */
export const ERASURE_LOG_FILE = 'erasures.jsonl';

/** What a replay did: the ids re-erased, and the tombstones it could NOT apply. */
export interface ErasureReplay {
  replayed: string[];
  refused: Array<{ userId: string; erasedAt: string; cause: unknown }>;
}

export interface ErasureTombstone {
  userId: string;
  emailHash: string;
  at: string;
}

export function emailHash(email: string, key: string): string {
  return createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}

export class ErasureLog {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    /** The fingerprint key: the resolved auth secret (never stored beside the file). */
    private readonly fingerprintKey: string
  ) {
    this.path = join(dataDir, ERASURE_LOG_FILE);
  }

  /** Append one tombstone. Best-effort on I/O failure: loud, never blocking the erasure itself. */
  async append(user: { id: string; email: string }): Promise<void> {
    const line: ErasureTombstone = {
      userId: user.id,
      emailHash: emailHash(user.email, this.fingerprintKey),
      at: new Date().toISOString()
    };
    try {
      await mkdir(join(this.path, '..'), { recursive: true });
      await appendFile(this.path, JSON.stringify(line) + '\n', { mode: 0o600 });
    } catch (err) {
      this.logger.error(
        { err, path: this.path },
        'erasure tombstone: could not append — a restore may resurrect this user'
      );
    }
  }

  /** Every tombstone on disk (malformed lines skipped, loudly). Empty when the file is absent. */
  async read(): Promise<ErasureTombstone[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: ErasureTombstone[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<ErasureTombstone>;
        if (typeof parsed.userId === 'string' && parsed.userId) {
          out.push({
            userId: parsed.userId,
            emailHash: String(parsed.emailHash ?? ''),
            at: String(parsed.at ?? '')
          });
        }
      } catch {
        this.logger.warn({ path: this.path }, 'erasure tombstone: skipping a malformed line');
      }
    }
    return out;
  }

  /**
   * Replay: for every tombstoned user still (or again) present, delete them
   * through `deleteUser` (Better Auth's cascade, the same path every GDPR
   * surface uses) and count it. A tombstone whose delete FAILS is reported
   * as refused, never swallowed (PRDCT-1809): the caller decides what a
   * present-but-unerasable subject means for the boot (it refuses to serve).
   */
  async replay(
    exists: (userId: string) => Promise<boolean>,
    deleteUser: (userId: string) => Promise<void>
  ): Promise<ErasureReplay> {
    const replayed: string[] = [];
    const refused: ErasureReplay['refused'] = [];
    const seen = new Set<string>();
    for (const tomb of await this.read()) {
      if (seen.has(tomb.userId)) continue;
      seen.add(tomb.userId);
      if (!(await exists(tomb.userId))) continue;
      try {
        await deleteUser(tomb.userId);
        replayed.push(tomb.userId);
        this.logger.warn(
          { userId: tomb.userId, erasedAt: tomb.at },
          'erasure tombstone replayed: a previously erased user was present again (restore from an older backup?) and has been re-erased'
        );
      } catch (err) {
        refused.push({ userId: tomb.userId, erasedAt: tomb.at, cause: err });
        this.logger.error(
          { err, userId: tomb.userId },
          'erasure tombstone: replay delete refused — the user is STILL PRESENT'
        );
      }
    }
    return { replayed, refused };
  }
}
