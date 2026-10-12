import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCliPackage, packFilename } from '@antasphere/chassis-server/cli-package';

/**
 * PRDCT-3312: the folder `CLI_PACKAGE_DIR` names holds the tool's CLI package
 * as the release packed it (`package.tgz` beside a copy of its
 * `package.json`). Pinned: npm's own pack filename, the unset case, the four
 * fields read off a good folder, and the refusals that stop the boot, each
 * naming the folder.
 */
describe('packFilename', () => {
  it('drops the scope’s @ and turns its / into -', () => {
    expect(packFilename('@antasphere/yourtool', '1.2.3')).toBe('antasphere-yourtool-1.2.3.tgz');
  });

  it('keeps an unscoped name as it is', () => {
    expect(packFilename('yourtool', '0.4.0-beta.1')).toBe('yourtool-0.4.0-beta.1.tgz');
  });
});

describe('loadCliPackage', () => {
  const dirs: string[] = [];
  const folder = async (files: Record<string, string | Buffer>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-package-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('answers null when the variable is unset: the instance serves no CLI', () => {
    expect(loadCliPackage(undefined)).toBeNull();
  });

  it('reads the name, the version, the tarball’s path and size, and the pack filename', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({ name: '@antasphere/yourtool', version: '1.2.3', bin: {} }),
      'package.tgz': Buffer.alloc(321, 7)
    });
    expect(loadCliPackage(dir)).toEqual({
      name: '@antasphere/yourtool',
      version: '1.2.3',
      path: join(dir, 'package.tgz'),
      sizeBytes: 321,
      filename: 'antasphere-yourtool-1.2.3.tgz'
    });
  });

  it('refuses a folder without the tarball, naming the folder', async () => {
    const dir = await folder({ 'package.json': JSON.stringify({ name: 'yourtool', version: '1.0.0' }) });
    expect(() => loadCliPackage(dir)).toThrow(`CLI_PACKAGE_DIR=${dir}: no package.tgz`);
  });

  it('refuses a folder without package.json, naming the folder', async () => {
    const dir = await folder({ 'package.tgz': Buffer.alloc(8) });
    expect(() => loadCliPackage(dir)).toThrow(`CLI_PACKAGE_DIR=${dir}: no package.json`);
  });

  it('refuses a package.json lacking a string version, naming the folder', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({ name: 'yourtool' }),
      'package.tgz': Buffer.alloc(8)
    });
    expect(() => loadCliPackage(dir)).toThrow(
      `CLI_PACKAGE_DIR=${dir}: package.json carries no string "version"`
    );
  });

  it('refuses a package.json lacking a string name, or not JSON at all', async () => {
    const nameless = await folder({
      'package.json': JSON.stringify({ name: 7, version: '1.0.0' }),
      'package.tgz': Buffer.alloc(8)
    });
    expect(() => loadCliPackage(nameless)).toThrow(
      `CLI_PACKAGE_DIR=${nameless}: package.json carries no string "name"`
    );
    const garbled = await folder({ 'package.json': '{ not json', 'package.tgz': Buffer.alloc(8) });
    expect(() => loadCliPackage(garbled)).toThrow(
      `CLI_PACKAGE_DIR=${garbled}: package.json is not valid JSON`
    );
  });

  it('refuses a folder that does not exist, naming it', () => {
    const dir = join(tmpdir(), 'cli-package-absent-folder');
    expect(() => loadCliPackage(dir)).toThrow(`CLI_PACKAGE_DIR=${dir}: no package.tgz`);
  });
});
