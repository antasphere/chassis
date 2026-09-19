import { describe, expect, it } from 'vitest';
import { contentDispositionFor, parseRangeHeader } from '@antasphere/chassis-server/files';
import { blobKey } from '@antasphere/chassis-server/storage';

describe('parseRangeHeader', () => {
  const SIZE = 100;

  it('no header → full body', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
  });

  it('closed range', () => {
    expect(parseRangeHeader('bytes=0-3', SIZE)).toEqual({ kind: 'range', range: { start: 0, end: 3 } });
  });

  it('open-ended range', () => {
    expect(parseRangeHeader('bytes=95-', SIZE)).toEqual({ kind: 'range', range: { start: 95, end: 99 } });
  });

  it('suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-10', SIZE)).toEqual({ kind: 'range', range: { start: 90, end: 99 } });
  });

  it('end clamped to size', () => {
    expect(parseRangeHeader('bytes=90-500', SIZE)).toEqual({ kind: 'range', range: { start: 90, end: 99 } });
  });

  it('start beyond size → 416', () => {
    expect(parseRangeHeader('bytes=100-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('inverted range → 416', () => {
    expect(parseRangeHeader('bytes=50-10', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('multi-range → 416 (single range only, DoS guard)', () => {
    expect(parseRangeHeader('bytes=0-1,5-9', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('non-bytes unit ignored → full body', () => {
    expect(parseRangeHeader('items=0-5', SIZE)).toEqual({ kind: 'none' });
  });

  it('empty spec → 416', () => {
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('zero-size file with any range → 416', () => {
    expect(parseRangeHeader('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('contentDispositionFor (safe serving, brief §2.6)', () => {
  it('active content downloads: html, svg, xml never render on the app origin', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/xml',
      'text/xml',
      'application/xhtml+xml'
    ]) {
      expect(contentDispositionFor(type, 'f')).toMatch(/^attachment/);
    }
  });

  it('passive media may render inline', () => {
    for (const type of ['image/png', 'image/jpeg', 'video/mp4', 'application/pdf', 'text/plain']) {
      expect(contentDispositionFor(type, 'f')).toMatch(/^inline/);
    }
  });

  it('unknown types download', () => {
    expect(contentDispositionFor('application/octet-stream', 'f')).toMatch(/^attachment/);
  });

  it('handles charset suffixes and sanitizes names', () => {
    expect(contentDispositionFor('TEXT/HTML; charset=utf-8', 'a"b\\c.html')).toMatch(/^attachment/);
    const value = contentDispositionFor('image/png', 'héllo.png');
    expect(value).toContain('filename="h_llo.png"');
    expect(value).toContain("filename*=UTF-8''h%C3%A9llo.png");
  });
});

describe('blobKey', () => {
  const WS = '123e4567-e89b-42d3-a456-426614174000';
  const SHA = 'a'.repeat(64);

  it('shards by the first two sha chars', () => {
    expect(blobKey(WS, SHA)).toBe(`ws/${WS}/aa/${SHA}`);
  });

  it('rejects traversal-shaped inputs', () => {
    expect(() => blobKey(WS, '../../../etc/passwd')).toThrow();
    expect(() => blobKey('../..', SHA)).toThrow();
    expect(() => blobKey(WS, SHA.toUpperCase())).toThrow();
  });
});
