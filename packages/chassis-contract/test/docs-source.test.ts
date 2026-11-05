import { describe, expect, it } from 'vitest';
import { DOCS_SOURCE_PAGES_PATH, DOCS_SOURCE_PATH, docsSourceManifestSchema } from '../src/index.js';

/** The docs source manifest (PRDCT-4098): the shape a reader (the Handbook) validates. */
describe('docsSourceManifestSchema', () => {
  const manifest = {
    product: 'Your Tool',
    description: 'A tool.',
    version: '1.8.0',
    slug: 'yourtool',
    groups: [
      { title: 'Getting started', pages: [{ path: 'index', title: 'Your Tool', description: 'Intro.' }] },
      { title: 'Empty', pages: [] }
    ]
  };

  it('accepts the route answer', () => {
    expect(docsSourceManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('accepts an empty description and keeps an additive field out', () => {
    const parsed = docsSourceManifestSchema.parse({ ...manifest, description: '', extra: 1 });
    expect(parsed.description).toBe('');
    expect('extra' in parsed).toBe(false);
  });

  it.each([
    ['no version', { ...manifest, version: undefined }],
    ['no slug', { ...manifest, slug: undefined }],
    ['no groups', { ...manifest, groups: undefined }],
    [
      'a page without a path',
      { ...manifest, groups: [{ title: 'G', pages: [{ title: 'T', description: '' }] }] }
    ],
    [
      'an empty path',
      { ...manifest, groups: [{ title: 'G', pages: [{ path: '', title: 'T', description: '' }] }] }
    ],
    ['a group without pages', { ...manifest, groups: [{ title: 'G' }] }],
    [
      'a page without a title',
      { ...manifest, groups: [{ title: 'G', pages: [{ path: 'p', description: '' }] }] }
    ]
  ])('refuses %s', (_what, value) => {
    expect(docsSourceManifestSchema.safeParse(value).success).toBe(false);
  });

  it('names the two paths', () => {
    expect(DOCS_SOURCE_PATH).toBe('/docs-source');
    expect(DOCS_SOURCE_PAGES_PATH).toBe('/docs-source/pages');
  });
});
