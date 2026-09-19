import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACT_PATHS } from '@antasphere/chassis-server/logger';
import { buildCsp, inlineScriptHashes } from '@antasphere/chassis-server/middleware';

describe('pino redaction (secrets never reach the stream)', () => {
  it('censors passwords, tokens, auth headers, and connection strings', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      }
    });
    // Uses the REAL redaction list exported from logger.ts, so this test
    // cannot drift from what production logs.
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);

    log.info(
      {
        req: { headers: { authorization: 'Bearer super-secret', cookie: 'session=abc' } },
        body: { password: 'hunter2', token: 'tok_123', secret: 's3cr3t' },
        DATABASE_URL: 'postgres://u:p@h/db',
        RESEND_API_KEY: 're_live_deadbeef',
        BREVO_API_KEY: 'xkeysib-deadbeef',
        S3_SECRET_ACCESS_KEY: 's3-super-secret',
        SETUP_TOKEN: 'setup-deadbeef'
      },
      'test'
    );

    const out = lines.join('');
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('session=abc');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('tok_123');
    expect(out).not.toContain('postgres://u:p@h/db');
    expect(out).not.toContain('re_live_deadbeef');
    expect(out).not.toContain('xkeysib-deadbeef');
    expect(out).not.toContain('s3-super-secret');
    expect(out).not.toContain('setup-deadbeef');
    expect(out).toContain('[redacted]');
  });
});

describe('CSP with inline-script hashes', () => {
  it('hashes each non-empty inline script and skips src scripts', () => {
    const html = `<html><head>
      <script src="/app.js"></script>
      <script>console.log("boot")</script>
      <script type="module">start()</script>
      <script></script>
    </head></html>`;
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(2);
    for (const h of hashes) expect(h).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);

    const csp = buildCsp(hashes);
    expect(csp).toContain(`script-src 'self' ${hashes[0]} ${hashes[1]}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
