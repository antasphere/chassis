import { pino, type Logger } from 'pino';
import type { Env } from './env.js';

export type { Logger };

/**
 * The single redaction list — secrets never reach the log stream.
 *
 * Two rules when adding to it. (1) pino's `*.x` glob matches the key `x` at
 * depth 1 ONLY, and it is an EXACT key match: `*.secret` does NOT cover
 * `clientSecret`, `client_secret`, or `apiSecret`, so every camel/snake spelling
 * a payload can carry needs its own entry. (2) Redaction keys off object
 * PROPERTIES — it can do nothing about a secret interpolated into a message
 * string. Never build a log message out of a config payload; log the shape
 * (`{ length, path }`), never the bytes.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  // Exact-key spellings the `*.secret` glob misses — OAuth/hub-federation
  // payloads carry these verbatim.
  '*.clientSecret',
  '*.client_secret',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.apiKey',
  '*.api_key',
  'DATABASE_URL',
  'AUTH_SECRET',
  'API_KEY_PEPPERS',
  'SETUP_TOKEN',
  'METRICS_TOKEN',
  'SMTP_URL',
  'RESEND_API_KEY',
  'BREVO_API_KEY',
  'S3_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  // Optional social credential — read in env.ts, so any "here is the parsed
  // env" line would otherwise carry it.
  'GOOGLE_CLIENT_SECRET',
  // Slideless: the hub-federation client credential (ADR 015 / user-scoped
  // federation). It is THIS tool's identity at the Antasphere hub — leaking it
  // lets anyone impersonate Slideless at the authorization server.
  'HUB_CLIENT_SECRET'
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' }
  };
  if (env.NODE_ENV === 'development') {
    // pino-pretty is a devDependency; if it is absent (e.g. NODE_ENV flipped
    // on a pruned production image) fall back to JSON instead of crashing.
    try {
      return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
    } catch {
      // fall through to JSON output
    }
  }
  return pino(options);
}
