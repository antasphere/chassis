import { z } from 'zod';
import { parseApiKeyPeppers } from './apikeys/peppers.js';
import { parseSuperadminEmails } from './accounts/superadmin.js';

/**
 * The single entry point for configuration. Every env var the app reads is
 * declared here; the docs env reference is generated from this schema.
 * Parsing failures print a readable table and exit — the app never boots on a
 * half-valid environment.
 */

/**
 * Empty OR whitespace-only (e.g. `VAR=` or `VAR=" "` in compose) means unset.
 * The trim matters: `Number(' ')` is 0, so an untrimmed blank would silently
 * flip a `min(0)` numeric knob (like the API rate limit) to its 0/disabled
 * meaning instead of the default — a security control off by a stray space.
 */
export const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const booleanish = z.preprocess(
  blankToUndefined,
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
);

/** Optional string where an empty value (e.g. `VAR=` in compose) means unset. */
export const optionalString = (inner: z.ZodString) => z.preprocess(blankToUndefined, inner.optional());

/**
 * Numeric knob where blank/whitespace means "use the default". EVERY numeric
 * var goes through this: `Number('')` is 0, so an unwrapped `min(0)` knob
 * (retention, quotas, sweeps) silently resolves to its 0/disabled meaning when
 * compose passes `VAR=${VAR:-}`. `min(1)` knobs would merely fail the boot,
 * but they ride the same preprocessor so a later `min(0)` cannot be added
 * without it.
 */
export const numeric = <T extends z.ZodType>(inner: T) => z.preprocess(blankToUndefined, inner);

/**
 * URL where only http(s) is acceptable. `z.url()` alone delegates to the WHATWG
 * parser, which happily accepts `javascript:alert(1)` and `data:…` (verified
 * against the pinned zod 4.4.3) — and PUBLIC_BASE_URL becomes the OIDC issuer,
 * the Better Auth baseURL, and the base of every link we mint, so a non-http
 * scheme there is a stored-XSS/redirect primitive rather than a typo.
 */
export const httpUrl = () => z.url({ protocol: /^https?$/ });

/**
 * Cheap, deterministic quality floor for operator-supplied secrets. `min(32)`
 * on its own accepts `'x'.repeat(32)` and `'changeme'.repeat(4)` — 32 bytes of
 * length with a handful of bits of entropy, which for AUTH_SECRET is forgeable
 * session/JWKS material. Three independent smells, all cheap:
 *
 *  - Shannon entropy of the observed character distribution, in bits over the
 *    whole string (a 32-char hex secret scores ~123 bits; `'x'.repeat(32)`
 *    scores 0).
 *  - distinct characters (a keyboard-mashed word list scores badly here even
 *    when its entropy estimate looks acceptable).
 *  - a short repeated pattern (`abcdefgh` × 4 passes both checks above).
 *
 * This is a floor, NOT a strength meter: it rejects the obviously-typed, it
 * cannot bless the merely-random-looking. `openssl rand -hex 32` always passes.
 */
export function shannonEntropyBits(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * value.length;
}

const MIN_SECRET_ENTROPY_BITS = 64;
const MIN_SECRET_DISTINCT_CHARS = 8;

/** True when the whole string is one short block repeated (`'ab'.repeat(16)`). */
function isRepeatedPattern(value: string): boolean {
  for (let len = 1; len < 16 && len <= value.length / 2; len++) {
    if (value.length % len !== 0) continue;
    if (value === value.slice(0, len).repeat(value.length / len)) return true;
  }
  return false;
}

/** Human-readable reason a secret is too predictable, or null when acceptable. */
export function weakSecretReason(value: string): string | null {
  if (new Set(value).size < MIN_SECRET_DISTINCT_CHARS) {
    return `too predictable (fewer than ${MIN_SECRET_DISTINCT_CHARS} distinct characters) — generate one with \`openssl rand -hex 32\``;
  }
  if (isRepeatedPattern(value)) {
    return 'too predictable (a short pattern repeated) — generate one with `openssl rand -hex 32`';
  }
  if (shannonEntropyBits(value) < MIN_SECRET_ENTROPY_BITS) {
    return `too predictable (below ${MIN_SECRET_ENTROPY_BITS} bits of entropy) — generate one with \`openssl rand -hex 32\``;
  }
  return null;
}

/** A >=`min`-char secret that also has to look random (see weakSecretReason). */
const highEntropySecret = (min: number) =>
  z
    .string()
    .min(min)
    .superRefine((raw, ctx) => {
      const reason = weakSecretReason(raw);
      if (reason) ctx.addIssue({ code: 'custom', message: reason });
    });

/**
 * The generic keys, in the order the env reference lists them. `version` is
 * the TOOL's own package version: the chassis never reads a package.json, so
 * the APP_VERSION default is handed in by the tool that boots it.
 */
const chassisEnvShape = (version: string) => ({
  /** Postgres connection string. The only required variable. */
  DATABASE_URL: z.string().min(1, 'required — postgres://user:pass@host:5432/db'),
  /** Port the single HTTP listener binds. */
  PORT: numeric(z.coerce.number().int().min(1).max(65535).default(3000)),
  /** Bind address. */
  HOST: z.string().default('0.0.0.0'),
  /** Public origin of this instance (scheme matters: https => Secure cookies). */
  PUBLIC_BASE_URL: httpUrl().default('http://localhost:3000'),
  /** Writable data directory (auto-generated secret, local file storage). */
  DATA_DIR: z
    .string()
    .trim()
    .min(1, 'must not be empty — the app needs a writable directory')
    .default('/data'),
  /** Apply pending migrations at boot. When false the app only checks and refuses readiness while behind. */
  AUTO_MIGRATE: booleanish.default(true),
  /** all = API + workers in one process; api = HTTP only; worker = jobs only. */
  SERVICE_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** Session/JWKS encryption secret. Auto-generated into DATA_DIR/secret when unset or empty. */
  AUTH_SECRET: optionalString(highEntropySecret(32)),
  /** Versioned API-key peppers for secret rotation: `<version>:<secret>` entries joined by `;` (e.g. `1:<historical AUTH_SECRET>;2:<new pepper>`, secrets >=32 chars). Version 1 defaults to AUTH_SECRET and, when pinned here, MUST keep the historical AUTH_SECRET-derived value or every existing key stops resolving; new keys mint under the highest version. Rotation runbook: internal/security-runbooks.md. */
  API_KEY_PEPPERS: optionalString(
    z.string().superRefine((raw, ctx) => {
      try {
        parseApiKeyPeppers(raw);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
      }
    })
  ),
  /** The credential POST /api/v1/setup requires (constant-time compared). setup.sh generates one into .env. Unset, the server generates a token into `$DATA_DIR/setup-token` at first boot and prints it to the container log — the first-boot claim is never free (PRDCT-1347). */
  SETUP_TOKEN: optionalString(z.string().min(8)),
  /** Allow POST /api/v1/setup over plaintext HTTP on a non-loopback PUBLIC_BASE_URL. Default false: the wizard 403s, because the owner password and the setup token would cross the network in the clear on the one request that decides who owns the instance. Reach a TLS-less server through an SSH tunnel (`ssh -L`) instead; set this true only on a trusted private network. */
  ALLOW_INSECURE_SETUP: booleanish.default(false),
  /** Break-glass operator allowlist: comma-separated emails. A caller is superadmin ONLY on a SESSION whose VERIFIED email is listed here — machine credentials (API keys, OAuth tokens) never qualify, they 403 fail-closed. Unset (default) = the break-glass endpoints are dormant and 403 for everyone. Runbook: internal/security-runbooks.md. */
  SUPERADMIN_EMAILS: optionalString(
    z.string().superRefine((raw, ctx) => {
      try {
        parseSuperadminEmails(raw);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
      }
    })
  ),
  /** Optional Google social login. */
  GOOGLE_CLIENT_ID: optionalString(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optionalString(z.string().min(1)),
  /** Edition selector (internal/federation.md): `oss` (default, self-host — zero hub surface at runtime) or `cloud` (federates human login + entitlements to the Antasphere hub; requires the HUB_* block). Any other value refuses to boot — the selector decides the identity binding, so a typo must fail loudly, never silently bind `oss`. Also surfaced in discovery + usage events. */
  EDITION: z.preprocess(blankToUndefined, z.enum(['oss', 'cloud']).default('oss')),
  /** Hub OIDC issuer, e.g. https://account.antasphere.com — discovery, JWKS, and the authorize/token endpoints all derive from it. Required when EDITION=cloud; never read when EDITION=oss. */
  HUB_ISSUER_URL: z.preprocess(blankToUndefined, httpUrl().optional()),
  /** OAuth client id from this tool's entry in the hub TOOL_REGISTRY (e.g. tool-acme-cloud). Required when EDITION=cloud. */
  HUB_CLIENT_ID: optionalString(z.string().min(4)),
  /** OAuth client secret matching the hub registry entry (confidential client; PKCE stays on regardless). Also authenticates the per-user refresh grant — there is NO service key: every hub read between logins presents the USER's own grant (internal/federation.md). Required when EDITION=cloud. */
  HUB_CLIENT_SECRET: optionalString(z.string().min(16)),
  /** Name of the hub-set shared SSO hint cookie the dashboard reads client-side (internal/federation.md; NEVER a security input — it only gates whether a silent connect is attempted). Cloud-only; unset = the cross-repo default `ant_sso_hint`. Never read when EDITION=oss. */
  HUB_HINT_COOKIE_NAME: optionalString(z.string().min(1)),
  /** Domain the hint cookie lives on (the hub sets it, tools clear it — both sides must agree). Cloud-only; unset = the hub issuer host minus its first label (account.antasphere.com → antasphere.com). Never read when EDITION=oss. */
  HUB_HINT_COOKIE_DOMAIN: optionalString(z.string().min(1)),
  /** R7 escape hatch (internal/federation.md): acknowledge an EDITION change on an already-set-up instance. Without it, boot refuses an EDITION that differs from the one stamped at setup — flipping editions under existing users/workspaces changes identity semantics and must be a conscious operator act. */
  EDITION_CHANGE_ALLOWED: booleanish.default(false),
  /** Reported version. Defaults to the code's own baked-in package version (PRDCT-1844) — the image knows its version intrinsically, CI injects nothing. The env var remains as a deliberate operator override only. */
  APP_VERSION: z.string().default(version),
  /** RFC 7591 dynamic client registration on the built-in authorization server: unauthenticated `POST /api/v1/auth/oauth2/register`, which is how MCP clients self-register. Default true (the connector-friendly posture, rate-limited in api/index.ts). Set false on an instance whose OAuth clients are provisioned by hand — the endpoint then refuses every caller instead of minting client records for anyone who asks. */
  OAUTH_DYNAMIC_CLIENT_REGISTRATION: booleanish.default(true),
  /** `Strict-Transport-Security` max-age in seconds, sent on every response when PUBLIC_BASE_URL is https (browsers ignore HSTS over plain http per RFC 6797 §7.2, so an http instance is unaffected). Default 180 days; 0 disables the header — the escape hatch for an operator who is not yet certain every subdomain can serve TLS. */
  HSTS_MAX_AGE: numeric(z.coerce.number().int().min(0).default(15552000)),
  /** Instance-level cap read by the default AllowAllEntitlements. */
  MAX_FILE_SIZE_MB: numeric(z.coerce.number().int().min(1).default(100)),
  /** How many workspaces ONE person may own on this instance — the cap on creating another workspace from the dashboard (the first one comes from setup). Any signed-in member who is not a guest may create one until they own this many. 0 closes workspace creation for everyone. On the cloud edition the count is Antasphere's own organization limit; only the 0 switch applies here. */
  MAX_WORKSPACES_PER_USER: numeric(z.coerce.number().int().min(0).max(1000).default(10)),
  /** General per-principal API quota: sustained requests/minute allowed to every authenticated /api/v1 principal (API key, OAuth token, session). 0 disables the general limiter. */
  API_RATE_LIMIT_PER_MINUTE: numeric(z.coerce.number().int().min(0).default(600)),
  /** Spike cap for the general API quota: max requests per principal in any 1-second burst. 0 disables burst smoothing (the per-minute window still applies). */
  API_RATE_LIMIT_BURST: numeric(z.coerce.number().int().min(0).default(100)),
  /** Email delivery. `none` (default) never blocks a flow: links stay copyable. */
  EMAIL_DRIVER: z.preprocess(blankToUndefined, z.enum(['none', 'smtp', 'resend', 'brevo']).default('none')),
  /** smtp(s)://user:pass@host:port — required when EMAIL_DRIVER=smtp. */
  SMTP_URL: optionalString(z.string().min(1)),
  /** Required when EMAIL_DRIVER=resend. */
  RESEND_API_KEY: optionalString(z.string().min(1)),
  /** Required when EMAIL_DRIVER=brevo. */
  BREVO_API_KEY: optionalString(z.string().min(1)),
  /** Sender, e.g. `Acme <noreply@acme.example>`. Required when a driver delivers. */
  EMAIL_FROM: optionalString(z.string().min(3)),
  /** When set, rate limits (and later caches) are shared across replicas. */
  REDIS_URL: optionalString(z.string().min(1)),
  /** File storage: local (default; DATA_DIR volume, single replica) or s3 (MinIO/AWS/R2). */
  STORAGE_DRIVER: z.preprocess(blankToUndefined, z.enum(['local', 's3']).default('local')),
  S3_BUCKET: optionalString(z.string().min(1)),
  S3_REGION: optionalString(z.string().min(1)),
  /** Endpoint override for MinIO/R2; leave unset for AWS. */
  S3_ENDPOINT: z.preprocess(blankToUndefined, httpUrl().optional()),
  S3_ACCESS_KEY_ID: optionalString(z.string().min(1)),
  S3_SECRET_ACCESS_KEY: optionalString(z.string().min(1)),
  /** Path-style addressing — required by MinIO and most S3-compatibles. */
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  /**
   * Trust x-forwarded-for for client IPs (rate limits, audit). The app reads
   * the RIGHTMOST hop — the one your proxy appended or set (Caddy ≥2.5
   * discards client-supplied X-Forwarded-* by default). Enable ONLY behind a
   * reverse proxy you control; when false the socket address is used and
   * spoofed headers are ignored.
   */
  TRUST_PROXY: booleanish.default(false),
  /** OTLP/HTTP endpoint for trace export. Unset (default) = no export, zero phone-home. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(blankToUndefined, httpUrl().optional()),
  /** GET /metrics requires `Authorization: Bearer <token>`; unset = /metrics disabled (401). */
  METRICS_TOKEN: optionalString(z.string().min(8)),
  /** Days of audit_log to keep (nightly purge at 03:00). 0 = keep forever. */
  AUDIT_RETENTION_DAYS: numeric(z.coerce.number().int().min(0).default(365)),
  /** Grace period for orphaned users (accounts with ZERO workspace memberships, e.g. setup-race losers): the nightly 03:00 sweep deletes them once older than this many hours. A user with ANY membership row — even deactivated — is never touched. 0 = sweep disabled. */
  ORPHAN_USER_RETENTION_HOURS: numeric(z.coerce.number().int().min(0).default(72)),
  /** pino level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production')
});

export type ChassisEnvShape = ReturnType<typeof chassisEnvShape>;
export type ChassisEnvKey = keyof ChassisEnvShape;

/**
 * Vars the cloud edition cannot boot without. Enforced as a schema check so
 * a cloud instance missing ANY of them fails env parsing with one readable
 * table listing every gap — never a partial boot that dies later at the
 * first hub call. On EDITION=oss these stay plain optional strings: unset
 * is fine and nothing reads them.
 */
const HUB_REQUIRED_VARS = ['HUB_ISSUER_URL', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET'] as const;

/**
 * What a tool adds to the environment: its own keys, where each one sits in
 * the merged schema, and its own cross-key checks. The env reference is
 * generated from the merged shape, so placement is part of the contract.
 */
export interface EnvExtension<TShape extends z.ZodRawShape> {
  shape: TShape;
  /**
   * The chassis key each tool key FOLLOWS. Tool keys naming the same chassis
   * key keep the order they have in `shape`; a tool key naming none sits after
   * the last chassis key, in `shape` order.
   */
  after?: Partial<Record<keyof TShape, ChassisEnvKey>>;
  /** Cross-key checks of the tool's own keys. Runs BEFORE the chassis checks. */
  refine?: (env: ToolEnv<TShape>, ctx: z.RefinementCtx) => void;
}

export interface EnvOptions<TShape extends z.ZodRawShape> {
  /** The tool's package version: the default of APP_VERSION. */
  version: string;
  extension?: EnvExtension<TShape>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function buildEnvSchema<TShape extends z.ZodRawShape = {}>(
  options: EnvOptions<TShape>
): z.ZodObject<ChassisEnvShape & TShape> {
  const chassis = chassisEnvShape(options.version);
  const extension = options.extension;
  const extra = extension?.shape ?? ({} as TShape);
  const after: Partial<Record<string, ChassisEnvKey>> = extension?.after ?? {};
  const extraKeys = Object.keys(extra);
  for (const key of extraKeys) {
    if (key in chassis) throw new Error(`env extension re-declares the chassis key ${key}`);
    const anchor = after[key];
    if (anchor !== undefined && !(anchor in chassis)) {
      throw new Error(`env extension places ${key} after ${anchor}, which is not a chassis key`);
    }
  }
  // Ordered splice: object key order IS the order of the generated reference.
  const merged: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(chassis)) {
    merged[key] = schema;
    for (const extraKey of extraKeys) {
      if (after[extraKey] === key) merged[extraKey] = extra[extraKey] as z.ZodType;
    }
  }
  for (const extraKey of extraKeys) {
    if (after[extraKey] === undefined) merged[extraKey] = extra[extraKey] as z.ZodType;
  }

  return z.object(merged as unknown as ChassisEnvShape & TShape).superRefine((value, ctx) => {
    const env = value as unknown as ToolEnv<TShape>;
    extension?.refine?.(env, ctx);
    if (env.EDITION !== 'cloud') return;
    for (const key of HUB_REQUIRED_VARS) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when EDITION=cloud — see internal/federation.md'
        });
      }
    }
  });
}

/** The parsed generic environment. A tool's env (`ChassisEnv & its own keys`) is assignable to it. */
export type ChassisEnv = z.infer<z.ZodObject<ChassisEnvShape>>;
/** A tool's parsed environment: the generic keys plus its own. */
export type ToolEnv<TShape extends z.ZodRawShape> = ChassisEnv & z.infer<z.ZodObject<TShape>>;
/** The name the chassis modules use for the environment they take. */
export type Env = ChassisEnv;

/**
 * The hub half of the edition split (internal/federation.md), extracted once at
 * boot. Returns null on EDITION=oss — the single switch every cloud seam
 * hangs off, so the self-host edition provably reads no hub config. The
 * tool's own OAuth resource URL is DERIVED (`<PUBLIC_BASE_URL>/mcp`, see
 * mcpResourceUrl), never configured.
 */
export interface HubConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * The shared SSO hint cookie's name + domain (internal/federation.md,
   * cross-repo contract with the hub): the HUB sets the cookie on any
   * response that mints a session; this tool only READS it client-side (a
   * silent-connect hint, never a security input) and CLEARS it on logout /
   * login_required. Surfaced in `/instance` discovery so the dashboard
   * needs no env of its own.
   */
  hintCookieName: string;
  hintCookieDomain: string;
}

/**
 * Default hint-cookie domain: the hub issuer host minus its first label —
 * account.antasphere.com → antasphere.com, the shared parent domain both
 * the hub and every tool live under. When stripping a label leaves nothing
 * (a single-label host like `localhost`), the host itself is the honest
 * fallback; operators on unusual topologies override via
 * HUB_HINT_COOKIE_DOMAIN.
 */
function defaultHintCookieDomain(issuerUrl: string): string {
  const host = new URL(issuerUrl).hostname;
  const parent = host.split('.').slice(1).join('.');
  return parent || host;
}

export function hubConfig(env: Env): HubConfig | null {
  if (env.EDITION !== 'cloud') return null;
  // parseEnv already refused a cloud env missing any of these.
  return {
    issuerUrl: env.HUB_ISSUER_URL!,
    clientId: env.HUB_CLIENT_ID!,
    clientSecret: env.HUB_CLIENT_SECRET!,
    hintCookieName: env.HUB_HINT_COOKIE_NAME ?? 'ant_sso_hint',
    hintCookieDomain: env.HUB_HINT_COOKIE_DOMAIN ?? defaultHintCookieDomain(env.HUB_ISSUER_URL!)
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function parseEnv<TShape extends z.ZodRawShape = {}>(
  source: NodeJS.ProcessEnv,
  options: EnvOptions<TShape>
): ToolEnv<TShape> {
  const result = buildEnvSchema(options).safeParse(source);
  if (result.success) return result.data as unknown as ToolEnv<TShape>;

  const rows: Array<[string, string]> = [];
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '(root)';
    rows.push([key, issue.message]);
  }
  const width = Math.max(...rows.map(([k]) => k.length), 'VARIABLE'.length);
  const lines = [
    '',
    'Invalid environment configuration:',
    '',
    `  ${'VARIABLE'.padEnd(width)}  PROBLEM`,
    `  ${'-'.repeat(width)}  ${'-'.repeat(40)}`,
    ...rows.map(([k, msg]) => `  ${k.padEnd(width)}  ${msg}`),
    '',
    'See docs/reference/env-reference.md (or .env.example) for every variable.',
    ''
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}
