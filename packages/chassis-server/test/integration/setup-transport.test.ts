import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, startPostgres, type TestApp, SETUP_TOKEN } from './helpers.js';

/**
 * PLT-10, end to end: the one-shot wizard is the request that decides who
 * owns the instance, and it carries the owner password plus the setup token.
 * On a plaintext, non-loopback origin the server refuses it outright — the
 * documented no-domain install path used to walk operators straight into
 * handing both to the network.
 *
 * The refusal must sit BEFORE the token check, and it must not be reachable
 * around by presenting a correct token.
 */
let container: StartedPostgreSqlContainer;

const owner = {
  email: 'owner@example.com',
  password: 'correct-horse-battery-staple',
  name: 'Owner'
};

async function bootWith(env: Record<string, string>, dbName: string): Promise<TestApp> {
  const url = await createDatabase(container, dbName);
  return createTestApp(url, env);
}

async function postSetup(app: TestApp, body: unknown): Promise<Response> {
  return app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

beforeAll(async () => {
  container = await startPostgres();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe('POST /setup over plaintext on a non-loopback origin', () => {
  it('403s with insecure_transport, and does NOT create the instance', async () => {
    const app = await bootWith(
      { PUBLIC_BASE_URL: 'http://platform.example.com', SETUP_TOKEN: 'the-setup-token' },
      'plaintext_public'
    );
    try {
      const res = await postSetup(app, {
        owner,
        instanceName: 'Acme',
        setupToken: 'the-setup-token' // the CORRECT token — it must not help
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'insecure_transport' } });

      // Still un-set-up: the wizard is genuinely still available over a safe
      // transport, it was not consumed by the refused attempt.
      const instance = await app.app.request('/api/v1/instance');
      expect(((await instance.json()) as { setupRequired: boolean }).setupRequired).toBe(true);
    } finally {
      await app.stop();
    }
  }, 120_000);

  it('is refused before the token check, so it cannot be probed for a valid token', async () => {
    const app = await bootWith(
      { PUBLIC_BASE_URL: 'http://10.0.0.4:3000', SETUP_TOKEN: 'the-setup-token' },
      'plaintext_private'
    );
    try {
      const res = await postSetup(app, { owner, instanceName: 'Acme', setupToken: 'wrong' });
      expect(res.status).toBe(403);
      // A wrong token would give invalid_setup_token; the transport verdict
      // must come first so the two cases are indistinguishable.
      expect(await res.json()).toMatchObject({ error: { code: 'insecure_transport' } });
    } finally {
      await app.stop();
    }
  }, 120_000);
});

describe('POST /setup on a transport the operator can trust', () => {
  it('succeeds over plaintext LOOPBACK — the `ssh -L` tunnel path', async () => {
    const app = await bootWith({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000' }, 'plaintext_loopback');
    try {
      const res = await postSetup(app, { owner, instanceName: 'Acme', setupToken: SETUP_TOKEN });
      expect(res.status).toBe(201);
    } finally {
      await app.stop();
    }
  }, 120_000);

  it('succeeds over https on a public origin', async () => {
    const app = await bootWith({ PUBLIC_BASE_URL: 'https://platform.example.com' }, 'https_public');
    try {
      const res = await postSetup(app, { owner, instanceName: 'Acme', setupToken: SETUP_TOKEN });
      expect(res.status).toBe(201);
    } finally {
      await app.stop();
    }
  }, 120_000);

  it('succeeds over plaintext on a public origin ONLY with the explicit opt-in', async () => {
    const app = await bootWith(
      { PUBLIC_BASE_URL: 'http://platform.example.com', ALLOW_INSECURE_SETUP: 'true' },
      'plaintext_optin'
    );
    try {
      const res = await postSetup(app, { owner, instanceName: 'Acme', setupToken: SETUP_TOKEN });
      expect(res.status).toBe(201);
    } finally {
      await app.stop();
    }
  }, 120_000);
});
