import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { REDACT_PATHS } from '@antasphere/chassis-server/logger';

/**
 * The redaction list is the last line between a config payload and the log
 * stream. Two gaps this pins shut:
 *  - `*.secret` is an EXACT key match, so `clientSecret` sailed straight
 *    through it (PLT-33);
 *  - GOOGLE_CLIENT_SECRET and, on this repo, HUB_CLIENT_SECRET (this tool's
 *    own identity at the Antasphere hub) are read in env.ts but were absent
 *    from the list, so any "parsed env" line carried them.
 */
type Log = ReturnType<typeof pino>;

function capture(fn: (log: Log) => void): string {
  const chunks: string[] = [];
  const log: Log = pino(
    { redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    { write: (chunk: string) => chunks.push(chunk) }
  ) as Log;
  fn(log);
  return chunks.join('');
}

describe('log redaction', () => {
  it('redacts the env-level credentials', () => {
    const out = capture((log) =>
      log.info({
        DATABASE_URL: 'postgres://u:p@h/db',
        AUTH_SECRET: 'auth-secret-value',
        GOOGLE_CLIENT_SECRET: 'google-secret-value',
        HUB_CLIENT_SECRET: 'hub-client-secret-value'
      })
    );
    expect(out).not.toContain('google-secret-value');
    expect(out).not.toContain('hub-client-secret-value');
    expect(out).not.toContain('auth-secret-value');
    expect(out).not.toContain('postgres://u:p@h/db');
  });

  it('redacts camelCase and snake_case secret keys the `*.secret` glob misses', () => {
    const out = capture((log) =>
      log.info({
        client: {
          clientId: 'visible-id',
          clientSecret: 'camel-secret-value',
          client_secret: 'snake-secret-value',
          accessToken: 'access-token-value',
          refresh_token: 'refresh-token-value',
          apiKey: 'api-key-value'
        }
      })
    );
    expect(out).toContain('visible-id');
    for (const leaked of [
      'camel-secret-value',
      'snake-secret-value',
      'access-token-value',
      'refresh-token-value',
      'api-key-value'
    ]) {
      expect(out).not.toContain(leaked);
    }
  });
});
