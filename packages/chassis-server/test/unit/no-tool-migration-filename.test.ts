import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No chassis test names a tool's migration FILE (PRDCT-2544). A tool made from
 * the chassis has its own migration history, so a file name of another tool's
 * history is an ENOENT waiting inside a package that tool never edits. The
 * statements a chassis test needs are fixtures the chassis owns
 * (`test/fixtures`). Reading the migration FOLDER by path stays allowed: any
 * coherent folder satisfies it.
 *
 * The pattern is assembled from pieces so that this file does not match itself.
 */
const FOUR_DIGITS = '\\d{4}';
const MIGRATION_FILENAME = new RegExp(`${FOUR_DIGITS}_[a-z_]+\\.${'sql'}`);

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const testDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('chassis-'))
  .map((entry) => join(packagesDir, entry.name, 'test'));

describe('no chassis test names a migration file', () => {
  it('the pattern catches a migration file name', () => {
    expect(MIGRATION_FILENAME.test(['0001', 'some_backfill.sql'].join('_'))).toBe(true);
    expect(MIGRATION_FILENAME.test('fixtures/onboarding-backfill.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('../../../db/drizzle')).toBe(false);
  });

  it('it looks where the chassis tests are', () => {
    const names = testDirs.map((dir) => relative(packagesDir, dir));
    expect(names).toContain(join('chassis-server', 'test'));
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it('no file under packages/chassis-*/test contains one', () => {
    const files = testDirs.flatMap((dir) => {
      try {
        return walk(dir);
      } catch {
        return []; // a chassis package without a test folder
      }
    });
    expect(files.length).toBeGreaterThan(50);
    // The walk reaches the fixtures and this guard itself: a walk that skips a
    // folder would leave the count above the floor and the guard blind there.
    const walked = files.map((file) => relative(packagesDir, file));
    expect(walked).toEqual(
      expect.arrayContaining([
        join('chassis-server', 'test', 'fixtures', 'onboarding-backfill.sql'),
        join('chassis-server', 'test', 'fixtures', 'operator-user-id-backfill.sql'),
        join('chassis-server', 'test', 'unit', 'no-tool-migration-filename.test.ts')
      ])
    );
    const offenders = files
      .filter((file) => MIGRATION_FILENAME.test(readFileSync(file, 'utf8')))
      .map((file) => relative(packagesDir, file));
    expect(offenders).toEqual([]);
  });
});
