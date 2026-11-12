import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The verify-email wrapper reads Better Auth's JSON answer before it hands
 * one on (PRDCT-4441). A link without `callbackURL` answers 200 JSON, the
 * branch where the wrapper must hand on a response it rebuilt, never the
 * original it has read or a clone's original (which Node's fetch cancels
 * once the clone is garbage collected). Collections are forced before the
 * body is read; the canary proves they run.
 */
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const collect = async () => {
  for (let i = 0; i < 4; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const OWNER = { email: 'owner@verify-body.test', name: 'Vera Owner', password: 'vera-owner-password-123' };
const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mailer: RecordingEmailDriver;

beforeAll(async () => {
  container = await startPostgres();
  mailer = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'verify_body'), {}, { email: mailer });
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Verify body', owner: OWNER })
  );
  expect(setup.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

it('the canary: the forced collections really run', async () => {
  let finalized = false;
  const registry = new FinalizationRegistry(() => {
    finalized = true;
  });
  (() => registry.register({}, 'dropped'))();
  await collect();
  expect(finalized).toBe(true);
});

it('verify-email without callbackURL answers a readable JSON body after collections', async () => {
  const ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  const created = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: 'bob@verify-body.test', role: 'member' }, ownerCookie)
    )
  );
  const token = (created.acceptUrl as string).split('/invite/')[1]!;
  mailer.sent.length = 0;
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: 'Bob', password: 'bob-password-1234567' })
  );
  expect(accepted.status).toBe(200);
  const mail = mailer.sent.find((m) => m.to === 'bob@verify-body.test');
  const link = /https?:\/\/\S*\/verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  expect(link).toBeDefined();
  const url = new URL(link!);
  expect(url.searchParams.has('callbackURL')).toBe(true);
  url.searchParams.delete('callbackURL');

  const res = await app.app.request(url.pathname + url.search);
  await collect();
  expect(res.status).toBe(200);
  expect(JSON.parse(await res.text())).toEqual({ status: true, user: null });
});
