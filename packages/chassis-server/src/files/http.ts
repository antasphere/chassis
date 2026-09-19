import type { ByteRange } from '../storage/driver.js';

/**
 * HTTP Range parsing for the files module. Single range only — multi-range
 * responses require multipart bodies nobody needs and open a DoS vector
 * (many tiny ranges of a huge blob), so `a-b,c-d` is rejected outright.
 */
export type RangeParse =
  | { kind: 'none' } // no/ignored header → 200 full body
  | { kind: 'range'; range: ByteRange } // → 206
  | { kind: 'unsatisfiable' }; // → 416

export function parseRangeHeader(header: string | undefined, size: number): RangeParse {
  if (!header) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    // Multi-range or malformed: RFC allows ignoring, but for the seekable
    // media target we answer 416 on anything bytes-shaped we cannot honor,
    // and ignore non-bytes units.
    return header.trim().startsWith('bytes=') ? { kind: 'unsatisfiable' } : { kind: 'none' };
  }
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return { kind: 'unsatisfiable' };

  if (startStr === '') {
    // suffix form: last N bytes
    const suffix = Number(endStr);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return size === 0 ? { kind: 'unsatisfiable' } : { kind: 'range', range: { start, end: size - 1 } };
  }

  const start = Number(startStr);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', range: { start, end } };
}

/**
 * Safe-serving policy (§2.6): browser-renderable ACTIVE content (HTML, SVG,
 * XML — anything that can execute script on the app origin) is never served
 * inline. Passive media may render inline; everything unknown downloads.
 * Always paired with X-Content-Type-Options: nosniff.
 */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'application/pdf',
  'text/plain'
]);

export function contentDispositionFor(contentType: string, filename: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const mode = INLINE_SAFE.has(base) ? 'inline' : 'attachment';
  return encodeContentDisposition(mode, filename);
}

/**
 * Encode a Content-Disposition with an explicit mode. `inline` for an ACTIVE
 * type is legitimate ONLY on the sandboxed viewer surface (ADR 012) — the
 * app-origin routes must keep deriving the mode via `contentDispositionFor`.
 */
export function encodeContentDisposition(mode: 'inline' | 'attachment', filename: string): string {
  // RFC 5987 encoding for non-ASCII names; strip quotes/control chars.
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
