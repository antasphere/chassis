import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emailHash, ErasureLog } from '@antasphere/chassis-server/accounts';

/**
 * PRDCT-1811: the tombstone's email fingerprint is KEYED. `erasures.jsonl`
 * rides in the unencrypted data tarball of every backup, and a plain
 * sha256 of an address is a dictionary lookup away from the address — an
 * off-site backup would list who asked to be forgotten. The key is the
 * instance's auth secret, which travels only in the encrypted config
 * archive.
 *
 * PRDCT-1809: a replay whose delete fails reports the tombstone as REFUSED
 * instead of swallowing it — the boot turns that into a fail-closed verdict.
 */
const silent = { warn() {}, error() {}, info() {}, debug() {} } as unknown as ConstructorParameters<
  typeof ErasureLog
>[1];

const KEY = 'unit-test-auth-secret-0123456789abcdef0123456789abcdef';

describe('emailHash (PRDCT-1811)', () => {
  it('is an HMAC under the key: 64 hex, key-dependent, and never the plain sha256 of the address', () => {
    const fp = emailHash('Alice@Example.com', KEY);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toBe(createHash('sha256').update('alice@example.com').digest('hex'));
    expect(emailHash('alice@example.com', 'another-key-0123456789abcdef0123456789abcdef')).not.toBe(fp);
  });

  it('normalizes the address (trim + lowercase) so the operator correlation survives casing', () => {
    expect(emailHash('  ALICE@example.COM ', KEY)).toBe(emailHash('alice@example.com', KEY));
  });
});

describe('ErasureLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'erasure-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('append writes the keyed fingerprint, never the address', async () => {
    const log = new ErasureLog(dir, silent, KEY);
    await log.append({ id: 'u1', email: 'Alice@Example.com' });
    const raw = readFileSync(join(dir, 'erasures.jsonl'), 'utf8');
    expect(raw).not.toContain('example.com');
    const line = JSON.parse(raw.trim()) as { userId: string; emailHash: string };
    expect(line.userId).toBe('u1');
    expect(line.emailHash).toBe(emailHash('alice@example.com', KEY));
  });

  it('replay reports a tombstone whose delete throws as REFUSED, with its cause (PRDCT-1809)', async () => {
    const log = new ErasureLog(dir, silent, KEY);
    await log.append({ id: 'gone', email: 'gone@example.com' });
    await log.append({ id: 'owner', email: 'owner@example.com' });
    await log.append({ id: 'absent', email: 'absent@example.com' });
    const boom = new Error('last owner');
    const result = await log.replay(
      async (id) => id !== 'absent',
      async (id) => {
        if (id === 'owner') throw boom;
      }
    );
    expect(result.replayed).toEqual(['gone']);
    expect(result.refused).toEqual([{ userId: 'owner', erasedAt: expect.any(String), cause: boom }]);
  });
});
