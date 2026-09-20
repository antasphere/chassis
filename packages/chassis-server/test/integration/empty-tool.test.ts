import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, schema } from '@antasphere/chassis-db';
import { defineChassisContract } from '@antasphere/chassis-contract';
import { defineChassisRoutes } from '@antasphere/chassis-contract/routes';
import { createPlatform, type BootResult, type ToolDefinition } from '../../src/index.js';
import { createScopeAllowlist } from '../../src/middleware/index.js';
import { THINGS_IDENTITY } from '../host/identity.js';

/**
 * The chassis boots with a MINIMAL tool: no env extension, no services, no
 * jobs, no buckets, no routes, no public app, no MCP tools — only its own scope
 * vocabulary. This is the proof that the composition has no hidden need of the
 * deck slots.
 *
 * The migrations are a FIXTURE read by path, not an import: the only
 * migration history that exists today is Slideless's (`packages/db/drizzle`,
 * which also creates the deck tables — unused here). That is the honest state
 * of the repository until the template wave squashes a history of its own.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FIXTURE = join(here, '../../../db/drizzle');

const SETUP_TOKEN = 'empty-tool-setup-token';
const OWNER = { email: 'owner@things.test', name: 'Things Owner', password: 'things-owner-password-1' };

const contract = defineChassisContract({ scopes: ['things:read', 'things:write', 'things:export'] });
type ThingsScope = 'things:read' | 'things:write' | 'things:export';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoEnv = {};
type NoDomain = Record<string, never>;

const emptyTool: ToolDefinition<NoEnv, NoDomain> = {
  identity: THINGS_IDENTITY,
  runtime: {
    version: '0.0.0-test',
    findMigrationsDir: () => MIGRATIONS_FIXTURE,
    publicDir: join(here, 'no-dashboard-build')
  },
  db: (url) => createDb(url, schema),
  scopes: {
    oauth: ['openid', 'profile', 'email', 'offline_access', 'things:read', 'things:write', 'things:export'],
    cliKey: ['things:read', 'things:write'],
    requiredScopeFor: createScopeAllowlist<ThingsScope>({
      read: 'things:read',
      write: 'things:write',
      dataExport: 'things:export',
      rules: []
    }),
    contractRoutes: defineChassisRoutes(contract, THINGS_IDENTITY)
  },
  services: () => ({}),
  api: {
    // A tool with no domain references no blob; its files are its uploaders' and its operators'.
    filePolicy: () => ({ blobInUse: async () => false, blobReadScope: () => undefined })
  },
  mcp: {
    registerTools: () => {},
    instructions: (info) => `MCP endpoint of the "${info.instanceName}" instance.`,
    errorHints: {},
    scopes: { read: 'things:read', write: 'things:write' },
    defaultInstanceName: 'Things'
  }
};

let container: StartedPostgreSqlContainer;
let booted: BootResult<NoEnv, NoDomain>;
let cookie: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie header in response');
  return setCookie
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  booted = await createPlatform(emptyTool).boot({
    DATABASE_URL: container.getConnectionUri(),
    DATA_DIR: await mkdtemp(join(tmpdir(), 'chassis-empty-tool-')),
    AUTH_SECRET: 'integration-test-secret-0123456789abcdef0123456789abcdef',
    SETUP_TOKEN,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PUBLIC_BASE_URL: 'http://localhost:3000'
  });
}, 240_000);

afterAll(async () => {
  await booted?.jobs.stop().catch(() => {});
  await booted?.db.pool.end();
  await container?.stop();
});

describe('the chassis with an empty tool', () => {
  it('boots to ready and answers the probes', async () => {
    expect(booted.state.ready).toBe(true);
    expect(booted.tool).toEqual({});
    expect((await booted.app.request('/healthz')).status).toBe(200);
    expect((await booted.app.request('/readyz')).status).toBe(200);
    const instance = (await (await booted.app.request('/api/v1/instance')).json()) as {
      name: string;
      setupRequired: boolean;
    };
    expect(instance).toMatchObject({ name: 'Things', setupRequired: true });
  });

  it('setup claims the instance, sign-in works, /me answers', async () => {
    const setup = await booted.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Things Instance', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const signIn = await booted.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    cookie = extractCookie(signIn);
    const me = await booted.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: OWNER.email }, role: 'owner', via: 'session' });
  });

  it('a key with the tool scope reaches /me and is refused on an unlisted route', async () => {
    const minted = await booted.app.request(
      '/api/v1/api-keys',
      json({ name: 'things-ro', scopes: ['things:read'] }, { cookie })
    );
    expect(minted.status).toBe(201);
    const { key } = (await minted.json()) as { key: string };
    const authorization = `Bearer ${key}`;

    const me = await booted.app.request('/api/v1/me', { headers: { authorization } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ via: 'api_key', scopes: ['things:read'] });

    const members = await booted.app.request('/api/v1/members', { headers: { authorization } });
    expect(members.status).toBe(403);
    // A scope of another vocabulary is not mintable here.
    const foreign = await booted.app.request(
      '/api/v1/api-keys',
      json({ name: 'foreign', scopes: ['presentations:read'] }, { cookie })
    );
    expect(foreign.status).toBe(400);

    // /mcp lists exactly the generic tools.
    const mcp = await booted.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(mcp.status).toBe(200);
    const listed = (await mcp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(['get_me', 'list_files']);
  });

  it('the OpenAPI document carries no deck path and the root app no deck surface', async () => {
    const doc = (await (await booted.app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>;
    };
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/me');
    expect(paths).toContain('/files');
    expect(paths.filter((p) => /presentations|collaborators|annotations|viewer/.test(p))).toEqual([]);
    // Unmatched API paths answer the JSON 404 terminator; there is no public viewer.
    expect((await booted.app.request('/api/v1/presentations', { headers: { cookie } })).status).toBe(404);
    const placeholder = await booted.app.request('/v/some-secret');
    expect(await placeholder.text()).toContain('No dashboard build found');
  });
});
