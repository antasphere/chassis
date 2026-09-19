import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Advisory-lock key for boot migrations. Constant and app-specific: every
 * replica of this app contends on the same key, so exactly one runs DDL while
 * the others wait, then find nothing left to apply.
 */
const MIGRATION_LOCK_KEY = 7_432_001n;

export interface MigrateOptions {
  connectionString: string;
  migrationsFolder: string;
  log?: (msg: string) => void;
}

export interface MigrationStatus {
  applied: number;
  onDisk: number;
  /** Migrations on disk whose hash the database has not applied. */
  pending: boolean;
  /**
   * Hashes the database has applied that NO file on disk produces (OPS-6,
   * PRDCT-1357): the database was migrated by a NEWER image (a rollback to
   * an older tag, `:next` behind `:latest`), or a migration file was edited
   * after it ran. A count-based status called both "current"; either way
   * this image's schema expectations are wrong and readiness must refuse.
   */
  unknownApplied: number;
  /** True when the database is ahead of this image (unknownApplied > 0). */
  downgrade: boolean;
}

/** drizzle's own migration identity: sha256 of the whole .sql file (migrator.js). */
export function migrationHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Pure comparison of the on-disk hashes with the applied ones — the part of
 * migrationStatus worth unit-testing without a database.
 */
export function compareMigrations(onDisk: string[], applied: string[]): MigrationStatus {
  const appliedSet = new Set(applied);
  const onDiskSet = new Set(onDisk);
  const pendingCount = onDisk.filter((h) => !appliedSet.has(h)).length;
  const unknownApplied = applied.filter((h) => !onDiskSet.has(h)).length;
  return {
    applied: applied.length,
    onDisk: onDisk.length,
    pending: pendingCount > 0,
    unknownApplied,
    downgrade: unknownApplied > 0
  };
}

/** The hashes drizzle would compute for the journal's migrations, in journal order. */
export async function onDiskMigrationHashes(migrationsFolder: string): Promise<string[]> {
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const hashes: string[] = [];
  for (const entry of journal.entries) {
    hashes.push(migrationHash(await readFile(join(migrationsFolder, `${entry.tag}.sql`), 'utf8')));
  }
  return hashes;
}

/**
 * Run all pending migrations exactly once across concurrent replicas.
 *
 * Uses a session-scoped pg_advisory_lock on a dedicated client (never a
 * pool): drizzle's migrator runs its own transactions, so a transaction-scoped
 * lock would release after the first internal commit and stop protecting the
 * rest of the run. Holding one session for lock + DDL guarantees every
 * statement runs under the lock.
 */
export async function runMigrations({
  connectionString,
  migrationsFolder,
  log
}: MigrateOptions): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    log?.('acquiring migration advisory lock');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    log?.('advisory lock acquired, applying pending migrations');
    await migrate(drizzle(client), { migrationsFolder });
    log?.('migrations up to date');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      await client.end();
    }
  }
}

/**
 * Compare applied migrations against the folder without running anything,
 * BY HASH (never by count): drizzle records the sha256 of every applied file,
 * so a database migrated by a newer image shows up as applied hashes this
 * image does not know — a downgrade — instead of "n of n, current". Used
 * before every boot's migration decision: pending → apply (AUTO_MIGRATE) or
 * refuse readiness; downgrade → refuse readiness regardless.
 */
export async function migrationStatus({
  connectionString,
  migrationsFolder
}: Omit<MigrateOptions, 'log'>): Promise<MigrationStatus> {
  const onDisk = await onDiskMigrationHashes(migrationsFolder);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables t
        WHERE t.table_schema = 'drizzle' AND t.table_name = '__drizzle_migrations'`
    );
    if (res.rows[0]?.count === '0') {
      return compareMigrations(onDisk, []);
    }
    const applied = await client.query<{ hash: string }>('SELECT hash FROM drizzle.__drizzle_migrations');
    return compareMigrations(
      onDisk,
      applied.rows.map((r) => r.hash)
    );
  } finally {
    await client.end();
  }
}
