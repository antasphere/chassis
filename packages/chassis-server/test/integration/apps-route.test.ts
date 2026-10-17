import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  host,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { nextIp, ssoLogin } from './sso-helpers.js';

/**
 * The Apps page's route (`GET /apps`, `src/apps/`, PRDCT-3493) through the
 * REAL boot of the minimal tool, on both editions:
 *
 *  - self-hosted, with an operator's file: a browser session reads the list
 *    (this tool marked current, the account from the file's `account` entry,
 *    a non-http entry left out, the descriptor keys read), and a machine
 *    credential is refused before the handler, since no rule of the scope
 *    allowlist opens the path (fail-closed);
 *  - cloud, against the fake hub: the list is the hub's `GET /me/apps` as
 *    the signed-in person, asked for the workspace's hub organization, the
 *    tools the organization does not open to them left out, the descriptor
 *    carried; closing a tool at the hub takes it out of the list once the
 *    five-minute hold has passed (a fresh person reads it at once).
 */

const OWNER = { email: 'owner@apps.test', name: 'Apps Owner', password: 'apps-owner-password-1' };
const DESCRIPTOR = {
  description: 'Where the company keeps its figures.',
  icon: 'landmark',
  drawing: 'ledger',
  accent: '#B5542A'
};

let container: StartedPostgreSqlContainer;

const send = (app: TestApp, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

beforeAll(async () => {
  container = await startPostgres();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe('GET /apps on a self-hosted instance with an operator file', () => {
  let app: TestApp;
  let cookie = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apps-route-'));
    const appsFile = join(dir, 'apps.json');
    writeFileSync(
      appsFile,
      JSON.stringify([
        { slug: 'account', name: 'Antasphere account', launchUrl: 'https://account.example.com' },
        {
          slug: 'finance',
          name: 'Antasphere Finance',
          launchUrl: 'https://finance.example.com',
          ...DESCRIPTOR
        },
        { slug: host.identity.slug, name: 'This Tool', launchUrl: 'https://thistool.example.com' },
        { slug: 'crm', name: 'Antasphere CRM', launchUrl: 'javascript:alert(1)' }
      ])
    );
    app = await createTestApp(await createDatabase(container, 'apps_route_oss'), { APPS_FILE: appsFile });
    const setup = await send(
      app,
      'POST',
      '/setup',
      {},
      { setupToken: SETUP_TOKEN, instanceName: 'Apps', owner: OWNER }
    );
    expect(setup.status).toBe(201);
    const signIn = await send(
      app,
      'POST',
      '/auth/sign-in/email',
      {},
      { email: OWNER.email, password: OWNER.password }
    );
    expect(signIn.status).toBe(200);
    cookie = extractCookie(signIn);
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('a session reads the file: the account, the tools with their descriptor, this tool current, the bad URL left out', async () => {
    const res = await send(app, 'GET', '/apps', { cookie });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.source).toBe('file');
    expect(body.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere account' });
    expect(body.apps.map((a: { slug: string; current: boolean }) => [a.slug, a.current])).toEqual([
      ['finance', false],
      [host.identity.slug, true]
    ]);
    expect(body.apps[0].descriptor).toEqual(DESCRIPTOR);
    expect(body.apps[1]).not.toHaveProperty('descriptor');
  });

  it('a machine credential is refused before the handler, and no credential answers 401', async () => {
    const minted = await send(
      app,
      'POST',
      '/api-keys',
      { cookie },
      { name: 'reader', scopes: [host.scopes.read] }
    );
    expect(minted.status).toBe(201);
    const key = (await readJson(minted)).key as string;
    const asKey = await send(app, 'GET', '/apps', { authorization: `Bearer ${key}` });
    expect(asKey.status).toBe(403);
    expect((await readJson(asKey)).error.code).toBe('endpoint_not_allowed');
    const anon = await send(app, 'GET', '/apps', {});
    expect(anon.status).toBe(401);
  });
});

describe('GET /apps on the cloud edition, against the hub', () => {
  let hub: FakeHub;
  let app: TestApp;
  const ORG = '11111111-2222-4333-8444-555555555555';
  const mira: HubUserFixture = {
    sub: 'hub-user-mira',
    email: 'mira@apps.test',
    name: 'Mira Lund',
    workspaceId: ORG,
    role: 'member',
    workspaceName: 'Acme'
  };
  const omar: HubUserFixture = {
    ...mira,
    sub: 'hub-user-omar',
    email: 'omar@apps.test',
    name: 'Omar Diallo'
  };

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: host.hubClientId });
    hub.setTools([
      {
        slug: 'finance',
        name: 'Antasphere Finance',
        launchUrl: 'https://finance.example.com',
        descriptor: DESCRIPTOR
      },
      {
        slug: 'hiring',
        name: 'Antasphere Hiring',
        launchUrl: 'https://hiring.example.com',
        descriptor: { icon: 'users' }
      },
      { slug: host.identity.slug, name: 'This Tool', launchUrl: 'https://thistool.example.com' }
    ]);
    hub.setToolClosed(omar.sub, 'hiring', ORG);
    app = await createTestApp(await createDatabase(container, 'apps_route_cloud'), {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
    });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    await hub?.stop();
  });

  it('a person signed in through the hub reads the catalogue for her organization, with the descriptors, this tool current', async () => {
    const cookie = await ssoLogin(app, hub, mira);
    const res = await send(app, 'GET', '/apps', { cookie });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.source).toBe('hub');
    expect(body.hub).toEqual({ url: `${hub.issuer}/`, name: 'Antasphere Account' });
    expect(body.apps.map((a: { slug: string; current: boolean }) => [a.slug, a.current])).toEqual([
      ['finance', false],
      ['hiring', false],
      [host.identity.slug, true]
    ]);
    expect(body.apps[0].descriptor).toEqual(DESCRIPTOR);
    expect(body.apps[1].descriptor).toEqual({ icon: 'users' });
    // asked as the person, for the workspace's hub organization
    const last = hub.meAppsRequests.at(-1)!;
    expect(last.orgId).toBe(ORG);
    expect(last.auth).toMatch(/^Bearer /);
  });

  it('a tool the organization does not open to the person is left out of her list', async () => {
    const cookie = await ssoLogin(app, hub, omar);
    const body = await readJson(await send(app, 'GET', '/apps', { cookie }));
    expect(body.source).toBe('hub');
    expect(body.apps.map((a: { slug: string }) => a.slug)).toEqual(['finance', host.identity.slug]);
  });
});
