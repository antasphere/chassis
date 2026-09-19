import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from './helpers.js';

/**
 * PLT-12 against a REAL pg_dump.
 *
 * test/unit/dr-lib.test.ts drives dr_verify_pg_dump with a hand-written dump
 * fixture, which proves the parser's logic but not that the shape it parses is
 * the shape pg_dump actually emits. That gap is the dangerous one: if the two
 * diverge, dr_verify_pg_dump rejects EVERY genuine backup and the operator
 * cannot restore at all — a verification step that turns into an outage. The
 * unit fixture would stay green throughout.
 *
 * So this suite dumps a real database from the same Postgres image the compose
 * stack runs, and asserts both directions on it: the intact dump verifies with
 * row counts that match reality, and the same dump truncated mid-COPY is
 * refused.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const drLib = join(repoRoot, 'scripts/lib/dr-lib.sh');

let container: StartedPostgreSqlContainer;
let work: string;
let dumpSql: string;

/** Run a snippet with dr-lib.sh sourced. */
function sh(snippet: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'bash',
      ['-euo', 'pipefail', '-c', `. ${JSON.stringify(drLib)}\n${snippet}`],
      { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(async () => {
  container = await startPostgres();
  work = mkdtempSync(join(tmpdir(), 'dr-real-'));

  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  // Deliberately awkward shapes: a reserved-word table name (pg_dump quotes it
  // as public."user", the identifier the row-count assertion has to survive),
  // an empty table, and a text column holding a line that reads like a COPY
  // header.
  await client.query('CREATE TABLE "user" (id text primary key, email text not null)');
  await client.query('CREATE TABLE api_keys (id text primary key, hash text)');
  await client.query('CREATE TABLE empty_table (id text primary key)');
  await client.query('CREATE TABLE notes (id text primary key, body text)');
  await client.query(`INSERT INTO "user" VALUES ('u1','a@b.c'),('u2','d@e.f'),('u3','g@h.i')`);
  await client.query(`INSERT INTO api_keys VALUES ('k1','deadbeef'),('k2','cafe')`);
  await client.query(`INSERT INTO notes VALUES ('n1', 'COPY public.evil (id) FROM stdin;'), ('n2','ok')`);
  await client.end();

  const uri = new URL(container.getConnectionUri());
  dumpSql = execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${decodeURIComponent(uri.password)}`,
      container.getId(),
      'pg_dump',
      '-U',
      decodeURIComponent(uri.username),
      uri.pathname.slice(1)
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}, 240_000);

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await container?.stop();
});

function writeGz(name: string, sql: string): void {
  writeFileSync(join(work, name), gzipSync(Buffer.from(sql, 'utf8')));
}

describe('dr_verify_pg_dump against output pg_dump really produced', () => {
  it('is a plain-text dump with the banner, COPY blocks and the completion trailer', () => {
    expect(dumpSql).toContain('-- PostgreSQL database dump');
    expect(dumpSql).toContain('-- PostgreSQL database dump complete');
    expect(dumpSql).toMatch(/^COPY public\."user" \([^)]*\) FROM stdin;$/m);
  });

  it('verifies the intact dump and reports the row counts that are really in it', () => {
    writeGz('db.sql.gz', dumpSql);
    const r = sh('dr_verify_pg_dump db.sql.gz');
    expect(r.status, r.stderr).toBe(0);
    const counts = new Map(
      r.stdout
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t') as [string, string])
    );
    expect(counts.get('public."user"')).toBe('3');
    expect(counts.get('public.api_keys')).toBe('2');
    expect(counts.get('public.empty_table')).toBe('0');
    // A COPY-looking line inside a text column is DATA, not a new block.
    expect(counts.get('public.notes')).toBe('2');
    expect(counts.has('public.evil')).toBe(false);
  });

  it('emits identifiers the row-count assertion in restore.sh accepts', () => {
    writeGz('db.sql.gz', dumpSql);
    // restore.sh pins the table identifier to this shape before it can reach
    // the SQL it builds. A real dump must never trip that guard, or every
    // restore fails on a table pg_dump had to quote.
    for (const line of sh('dr_verify_pg_dump db.sql.gz').stdout.trim().split('\n')) {
      const tbl = line.split('\t')[0]!;
      expect(tbl, tbl).toMatch(/^[A-Za-z0-9_."]+$/);
    }
  });

  it('REFUSES the same real dump truncated mid-COPY, before anything is dropped', () => {
    const cut = dumpSql.slice(0, dumpSql.indexOf('\\.'));
    writeGz('cut.sql.gz', cut);
    // The gzip layer is perfectly happy, which is why gzip -t alone is a trap.
    expect(sh('dr_verify_gzip cut.sql.gz').status).toBe(0);
    const r = sh('dr_verify_pg_dump cut.sql.gz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TRUNCATED dump/);
  });

  it('REFUSES a real dump whose tail was lost (completion trailer gone)', () => {
    writeGz('notail.sql.gz', dumpSql.slice(0, dumpSql.lastIndexOf('-- PostgreSQL database dump complete')));
    const r = sh('dr_verify_pg_dump notail.sql.gz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TRUNCATED dump: the pg_dump completion trailer is missing/);
  });

  it('REFUSES a real dump that lost bytes in the middle', () => {
    const bytes = Buffer.from(gzipSync(Buffer.from(dumpSql, 'utf8')));
    writeFileSync(join(work, 'half.sql.gz'), bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(sh('dr_verify_pg_dump half.sql.gz').status).not.toBe(0);
    // Sanity: the fixture really is a valid prefix of a gzip stream, not junk.
    expect(readFileSync(join(work, 'half.sql.gz')).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });
});
