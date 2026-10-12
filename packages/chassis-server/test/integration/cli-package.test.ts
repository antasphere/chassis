import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  expectBootRefusal,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import * as sso from './sso-helpers.js';

/**
 * The tool's own CLI package (PRDCT-3312): `POST /api/v1/cli/package`, cloud
 * only, answers the tarball the release packed (`CLI_PACKAGE_DIR`) to the
 * holder of a hub-minted exchange token, and discovery names the package.
 * Pinned: the discovery field, the bytes and their headers, the one-time
 * token shared with `/sso/cli-connect` (spent at one door, it opens neither),
 * the uniform 401 for every bad token, the validation 400s, the 403 a machine
 * credential meets before the handler, the 404 of an instance released
 * without its package, the oss terminator, and the boot refusal of a folder
 * that does not hold the pair.
 *
 * NOT modelled here: the hub's own refusal of a member without access to the
 * tool (`tool_access_denied`, 403 on `POST /sso/tool-token`). The hub mints
 * no token for that person, so nothing reaches this route; the refusal is the
 * hub's suite's to pin, and the fake hub signs whatever it is asked to.
 */

const OWNER = { email: 'owner@clipkg.test', name: 'Op Erator', password: 'op-erator-password-123' };
const ORG = '11111111-aaaa-4bbb-8ccc-0000000000c1';
/** The host's own resource URL, the audience every exchange token is minted for. */
const RESOURCE = 'http://localhost:3000/mcp';
const PACKAGE = { name: '@antasphere/yourtool', version: '1.2.3' };

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let fixtureDir = '';
let emptyDir = '';
const tarball = randomBytes(1024);

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: host.hubClientId })]);
  fixtureDir = await mkdtemp(join(tmpdir(), 'cli-package-fixture-'));
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify(PACKAGE));
  await writeFile(join(fixtureDir, 'package.tgz'), tarball);
  emptyDir = await mkdtemp(join(tmpdir(), 'cli-package-empty-'));
});

afterAll(async () => {
  await Promise.all([container?.stop(), hub?.stop()]);
  await Promise.all([fixtureDir, emptyDir].map((d) => (d ? rm(d, { recursive: true, force: true }) : null)));
});

function cloudEnv(extra: Record<string, string> = {}) {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: host.hubClientId,
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
    ...extra
  };
}

async function setUp(app: TestApp, instanceName: string): Promise<void> {
  const res = await app.app.request(
    '/api/v1/setup',
    sso.json({ setupToken: 'integration-test-setup-token', instanceName, owner: OWNER })
  );
  expect(res.status).toBe(201);
}

const download = (app: TestApp, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request('/api/v1/cli/package', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

let seq = 0;
const person = (): HubUserFixture => {
  seq += 1;
  return {
    sub: `hub-clipkg-${seq}`,
    email: `person${seq}@clipkg.test`,
    name: `Person ${seq}`,
    workspaceId: ORG,
    role: 'member',
    workspaceName: 'CLI Org'
  };
};

describe('cloud edition, released with its CLI package', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'cli_package'),
      cloudEnv({ CLI_PACKAGE_DIR: fixtureDir })
    );
    await setUp(app, 'CLI package');
  });

  afterAll(async () => {
    await app.stop();
  });

  it('discovery names the package and its version', async () => {
    const res = await app.app.request('/api/v1/instance');
    expect(res.status).toBe(200);
    expect((await readJson(res)).cli).toEqual(PACKAGE);
  });

  it('a hub exchange token downloads the tarball, byte for byte, as npm names it', async () => {
    const { token } = await hub.signConnectToken(person(), RESOURCE);
    const res = await download(app, { token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="antasphere-yourtool-1.2.3.tgz"'
    );
    expect(res.headers.get('content-length')).toBe('1024');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(tarball)).toBe(true);
  });

  it('the same token a second time is 401 invalid_token: one download per token', async () => {
    const { token } = await hub.signConnectToken(person(), RESOURCE);
    expect((await download(app, { token })).status).toBe(200);
    await expectError(await download(app, { token }), 401, 'invalid_token');
  });

  it('one ledger with /sso/cli-connect: a token spent at one door opens neither', async () => {
    const downloader = person();
    const first = await hub.signConnectToken(downloader, RESOURCE);
    expect((await download(app, { token: first.token })).status).toBe(200);
    await expectError(
      await app.app.request(
        '/api/v1/sso/cli-connect',
        sso.json({ token: first.token, hubRefreshToken: first.hubRefreshToken })
      ),
      401,
      'invalid_token'
    );

    const connector = person();
    const second = await hub.signConnectToken(connector, RESOURCE);
    const connect = await app.app.request(
      '/api/v1/sso/cli-connect',
      sso.json({ token: second.token, hubRefreshToken: second.hubRefreshToken })
    );
    expect(connect.status).toBe(201);
    await expectError(await download(app, { token: second.token }), 401, 'invalid_token');
  });

  it('every bad token is the same 401 invalid_token: no purpose, another purpose, another audience, expired', async () => {
    const someone = person();
    const tokens = [
      (await hub.signConnectToken(someone, RESOURCE, { purpose: null })).token,
      (await hub.signConnectToken(someone, RESOURCE, { purpose: 'other' })).token,
      (
        await hub.signConnectToken(
          { ...someone, overrides: { accessAud: 'http://another-tool.test/mcp' } },
          RESOURCE
        )
      ).token,
      (await hub.signConnectToken({ ...someone, overrides: { expiresInSeconds: -10 } }, RESOURCE)).token,
      'garbage'
    ];
    for (const token of tokens) {
      await expectError(await download(app, { token }), 401, 'invalid_token');
    }
  });

  it('a body without a token or with an empty one is 400 validation_error; no body at all is 400 invalid_json', async () => {
    await expectError(await download(app, {}), 400, 'validation_error');
    await expectError(await download(app, { token: '' }), 400, 'validation_error');
    await expectError(await download(app, undefined), 400, 'invalid_json');
  });

  it('a machine credential is 403 endpoint_not_allowed before the handler, and the token is not spent', async () => {
    const holder = person();
    // A user-scoped API key, the one /sso/cli-connect mints.
    const minted = await hub.signConnectToken(holder, RESOURCE);
    const connect = await app.app.request(
      '/api/v1/sso/cli-connect',
      sso.json({ token: minted.token, hubRefreshToken: minted.hubRefreshToken })
    );
    expect(connect.status).toBe(201);
    const key = (await readJson(connect)).key as string;
    // An OAuth bearer this instance minted, through a browser session.
    const cookie = await sso.ssoLogin(app, hub, holder);
    const bearer = await sso.oauthBearer(app, cookie);

    const { token } = await hub.signConnectToken(holder, RESOURCE);
    await expectError(
      await download(app, { token }, { authorization: `Bearer ${key}` }),
      403,
      'endpoint_not_allowed'
    );
    await expectError(
      await download(app, { token }, { authorization: `Bearer ${bearer}` }),
      403,
      'endpoint_not_allowed'
    );
    // Refused before the handler: the token was never burned.
    expect((await download(app, { token })).status).toBe(200);
  });
});

describe('cloud edition, released without its CLI package', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'cli_package_none'), cloudEnv());
    await setUp(app, 'No CLI package');
  });

  afterAll(async () => {
    await app.stop();
  });

  it('discovery carries no cli key, and a valid token is 404 cli_not_packaged', async () => {
    const instance = await readJson(await app.app.request('/api/v1/instance'));
    expect('cli' in instance).toBe(false);
    const { token } = await hub.signConnectToken(person(), RESOURCE);
    await expectError(await download(app, { token }), 404, 'cli_not_packaged');
  });
});

describe('oss edition', () => {
  let app: TestApp;

  beforeAll(async () => {
    // Even with the folder set: the oss edition mounts zero hub surface.
    app = await createTestApp(await createDatabase(container, 'cli_package_oss'), {
      CLI_PACKAGE_DIR: fixtureDir
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('the path is the JSON 404 terminator, and discovery carries no cli key', async () => {
    const { token } = await hub.signConnectToken(person(), RESOURCE);
    const res = await download(app, { token });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('not_found');
    const instance = await readJson(await app.app.request('/api/v1/instance'));
    expect('cli' in instance).toBe(false);
  });
});

describe('the boot', () => {
  it('refuses a CLI_PACKAGE_DIR that does not hold the package, naming the folder', async () => {
    // The env parser's refusal is a printed table and process.exit(1): both
    // are stubbed so the refusal surfaces as a rejection carrying the table.
    let printed = '';
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed += args.map(String).join(' ');
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}): ${printed}`);
    });
    try {
      const escaped = emptyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await expectBootRefusal(
        createTestApp(
          await createDatabase(container, 'cli_package_refused'),
          cloudEnv({ CLI_PACKAGE_DIR: emptyDir })
        ),
        new RegExp(`CLI_PACKAGE_DIR\\s+CLI_PACKAGE_DIR=${escaped}: no package\\.tgz`)
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
