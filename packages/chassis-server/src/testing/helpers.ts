import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Hono } from 'hono';
import type { ToolIdentity } from '@antasphere/chassis-contract';
import type { EmailDriver, EmailMessage } from '../email/driver.js';

/**
 * Delivering driver that records instead of sending. Exists because
 * change-email tokens are stateless JWTs (never stored in the verification
 * table) — the only way a test can obtain the link is to capture the
 * outbound mail. Passed via the `email` boot override.
 */
export class RecordingEmailDriver implements EmailDriver {
  readonly name = 'smtp' as const; // narrowest honest label the union allows
  readonly delivers = true;
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * The first-boot claim credential every test app boots with (PRDCT-1347:
 * POST /setup ALWAYS requires a token now). Suites that exercise the
 * generated-token path override it with an empty SETUP_TOKEN.
 */
export const SETUP_TOKEN = 'integration-test-setup-token';

/** Matches the compose stack: Postgres 17 with pgvector available. */
export const PG_IMAGE = 'pgvector/pgvector:pg17';

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(PG_IMAGE).start();
}

/**
 * What the harness needs of a boot result: the three handles every suite
 * drives (`app`, `db.pool`, `jobs`). Any `BootResult` of `createPlatform`
 * satisfies it, whatever the tool.
 */
export interface BootResultLike {
  app: Hono;
  db: { pool: pg.Pool };
  jobs: { stop: () => Promise<void> };
}

/** A tool's boot function, as `createPlatform(tool).boot` hands it out. */
export type BootFn<TResult extends BootResultLike, TOverrides> = (
  source?: NodeJS.ProcessEnv,
  overrides?: TOverrides
) => Promise<TResult>;

export type TestApp<TResult extends BootResultLike = BootResultLike> = TResult & {
  stop: () => Promise<void>;
};

/**
 * The scope names and the probe routes of the tool a suite runs against. The
 * chassis suite (`test/integration`) never spells a tool's vocabulary: where
 * it needs "some valid scope" or "some authenticated tool route", it takes
 * them from here.
 */
export interface ChassisTestHost<TResult extends BootResultLike, TOverrides> {
  boot: BootFn<TResult, TOverrides>;
  /** The host tool's identity: where the suite reads the key prefix a minted key must carry. */
  identity: ToolIdentity;
  /** The host tool's OAuth client id at the hub: the cloud boots' `HUB_CLIENT_ID`, and the fake hub's. */
  hubClientId: string;
  scopes: {
    /** The scope behind the chassis read surfaces (`/me`, the files reads). */
    read: string;
    /** The scope behind the chassis mutations. */
    write: string;
    /** The dedicated opt-in scope of the workspace export. */
    dataExport: string;
  };
  /**
   * An authenticated, workspace-scoped GET route of the TOOL (under the read
   * scope) that answers 200 to any principal the gates let through.
   */
  probeRoute: string;
}

/** Postgres `admin_shutdown`: what a backend answers a still-connected client when the server stops. */
const ADMIN_SHUTDOWN = '57P01';

/** How long `endPool` waits for the sockets, so that a teardown can never hang on one. */
const POOL_CLOSE_TIMEOUT_MS = 10_000;

/**
 * End a pool and wait until every one of its clients has REALLY closed
 * (PRDCT-2547). `pool.end()` alone does not say that: pg-pool takes each
 * client off its list and only then calls `client.end()`, so its promise
 * resolves while the sockets are still open. A suite that stops its container
 * right after (`await app.stop(); await container.stop()`) then races the
 * server's shutdown: the backend answers the still-connected client with
 * `57P01`, the client hands it to the pool, the pool has no `error` listener,
 * and Node reports an unhandled error: the run fails with every test passed.
 *
 * The pool emits `remove` from the callback of `client.end()`, which pg calls
 * on the connection's `end`, the socket's close. So: count the clients, end
 * the pool, wait for as many `remove`. The `error` listener is the net under
 * it (a wait that timed out): it takes `57P01` on this ENDING pool and nothing
 * else, any other error is thrown as it was before.
 *
 * A ceiling that expires SAYS so, in one `console.warn` line with the number
 * of clients still open: it does not throw (the listener stays the net), but
 * a chronically slow teardown is then visible instead of leaning on the
 * listener in silence. `ceilingMs` exists for the helper's own unit test.
 */
export async function endPool(pool: pg.Pool, ceilingMs: number = POOL_CLOSE_TIMEOUT_MS): Promise<void> {
  pool.on('error', (err: Error & { code?: string }) => {
    if (err.code !== ADMIN_SHUTDOWN) throw err;
  });
  let open = pool.totalCount;
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on('remove', () => {
      if (--open === 0) resolve();
    });
    timer = setTimeout(() => {
      console.warn(
        `endPool: ${open} pool client(s) still open after the ${ceilingMs} ms ceiling; the teardown goes on`
      );
      resolve();
    }, ceilingMs);
    timer.unref();
  });
  await pool.end();
  await closed;
  clearTimeout(timer);
}

/**
 * Binds `createTestApp` to a boot function: boots the real app (real
 * migrations, real Better Auth) against a database.
 */
export function makeCreateTestApp<TResult extends BootResultLike, TOverrides>(
  boot: BootFn<TResult, TOverrides>
): (
  connectionString: string,
  extraEnv?: Record<string, string>,
  overrides?: TOverrides
) => Promise<TestApp<TResult>> {
  return async (connectionString, extraEnv = {}, overrides) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chassis-test-'));
    const result = await boot(
      {
        DATABASE_URL: connectionString,
        DATA_DIR: dataDir,
        AUTH_SECRET: 'integration-test-secret-0123456789abcdef0123456789abcdef',
        SETUP_TOKEN,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        // app.request() has no socket; trusting XFF lets tests exercise the
        // per-IP bucket behavior deliberately.
        TRUST_PROXY: 'true',
        // Generous general-API quota so unrelated suites never trip it while
        // still exercising the consume path; the api-quota suite overrides
        // these with tight values via extraEnv.
        API_RATE_LIMIT_PER_MINUTE: '100000',
        API_RATE_LIMIT_BURST: '10000',
        ...extraEnv
      },
      overrides
    );
    return {
      ...result,
      stop: async () => {
        await result.jobs.stop().catch(() => {});
        await endPool(result.db.pool);
      }
    };
  };
}

/**
 * Assert a boot REFUSES with a message matching `re`. Never `expect(boot)
 * .rejects.toThrow(...)` directly: when the refusal is missing the promise
 * resolves with a live BootResult, vitest tries to serialise it for the
 * failure message (OOM, worker crash), and the app is never stopped.
 */
export async function expectBootRefusal(boot: Promise<TestApp>, re: RegExp): Promise<void> {
  let app: TestApp | undefined;
  try {
    app = await boot;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!re.test(message)) throw new Error(`boot refused for the wrong reason: ${message}`);
    return;
  }
  await app.stop();
  throw new Error(`boot succeeded but a refusal matching ${re} was expected`);
}

/** Create an extra empty database inside the shared container. */
export async function createDatabase(container: StartedPostgreSqlContainer, name: string): Promise<string> {
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const base = new URL(container.getConnectionUri());
  base.pathname = `/${name}`;
  return base.toString();
}

/** Deliberate state isolation: wipe all rows, keep the schema. */
export async function truncateAll(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const tables = res.rows.map((r) => `"${r.tablename}"`).join(', ');
    if (tables.length > 0) {
      await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Read a JSON body without fighting Response's `unknown` under strict TS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

export function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie header in response');
  return setCookie
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}
