import { describe, expect, it } from 'vitest';
import { RESERVED_EXPORT_ENTRY_NAMES, resolveExportEntries } from '@antasphere/chassis-server/api';

/**
 * The tool's export entries, resolved before the zip stream starts: a name is
 * sanitized like every other entry name, the rows are the JSON the bundle
 * carries, and a name that lands on another entry is an error.
 */
describe('resolveExportEntries (the `api.exportEntries` slot)', () => {
  it('writes each entry as <name>.json, rows as indented JSON, in the order given', () => {
    const resolved = resolveExportEntries([
      { name: 'things', rows: [{ id: 't1' }] },
      { name: 'gadgets', rows: [] }
    ]);
    expect(resolved.map((e) => e.entryName)).toEqual(['things.json', 'gadgets.json']);
    expect(resolved[0]!.buffer.toString('utf8')).toBe(JSON.stringify([{ id: 't1' }], null, 2) + '\n');
    expect(resolved[1]!.buffer.toString('utf8')).toBe('[]\n');
  });

  it('an empty list resolves to nothing', () => {
    expect(resolveExportEntries([])).toEqual([]);
  });

  it('sanitizes a hostile name: no separator, no control character, bounded, never empty', () => {
    const names = resolveExportEntries([
      { name: '../../etc/cron.d/x', rows: [] },
      { name: 'a\u0000b\u001fc\u007fd\\e', rows: [] },
      { name: 'x'.repeat(500), rows: [] },
      { name: '', rows: [] }
    ]).map((e) => e.entryName);
    expect(names).toEqual([
      '.._.._etc_cron.d_x.json',
      'a_b_c_d_e.json',
      `${'x'.repeat(150)}.json`,
      'file.json'
    ]);
  });

  it('the reserved list is the chassis entries of the bundle', () => {
    expect([...RESERVED_EXPORT_ENTRY_NAMES]).toEqual([
      'manifest',
      'workspace',
      'members',
      'invitations',
      'api-keys',
      'audit-log',
      'files',
      'skipped-blobs'
    ]);
  });

  it.each([...RESERVED_EXPORT_ENTRY_NAMES])('refuses the chassis entry name %s', (name) => {
    expect(() => resolveExportEntries([{ name, rows: [] }])).toThrow(/already an entry of the bundle/);
  });

  it('refuses a collision that only differs by case, or that appears through sanitizing', () => {
    expect(() => resolveExportEntries([{ name: 'Files', rows: [] }])).toThrow(/already an entry/);
    expect(() =>
      resolveExportEntries([
        { name: 'a/b', rows: [] },
        { name: 'a_b', rows: [] }
      ])
    ).toThrow(/"a_b" is already an entry/);
  });

  it('refuses the same tool name twice', () => {
    expect(() =>
      resolveExportEntries([
        { name: 'things', rows: [] },
        { name: 'things', rows: [] }
      ])
    ).toThrow(/"things" is already an entry/);
  });

  it('refuses a shape that is not { name, rows[] }, and rows that do not serialize', () => {
    expect(() => resolveExportEntries([{ name: 'things', rows: 'nope' } as never])).toThrow(/every entry is/);
    expect(() => resolveExportEntries({} as never)).toThrow(/must return an array/);
    expect(() => resolveExportEntries([{ name: 'things', rows: [{ n: 1n }] }])).toThrow();
  });
});
