import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1437 — the account-existence oracle, closed on both remaining doors.
 *
 * Door 1: minting a change-email link succeeds for ANY new address; consuming
 * it used to answer a raw 500 when the address already had an account
 * anywhere on the instance (the update died at the `user.email` UNIQUE
 * constraint) versus a 302 when it did not — a mint-then-consume oracle for
 * any owner, free on a "yes". The consume now answers the SAME observables on
 * both branches: 302 to the callback, a session cookie for the target, no
 * error param — the email just does not change on a collision.
 *
 * Door 2: the public invitation/collaborator lookups no longer carry
 * `accountExists` (asserted in their own suites); this file pins door 1.
 */

const OWNER = { email: 'owner@oracle.test', name: 'Oracle Owner', password: 'oracle-owner-pass-1' };
const MEMBER = { email: 'member@oracle.test', name: 'Oracle Member', password: 'oracle-member-pass-1' };
/** An account that exists on the instance but NOT in this workspace. */
const ELSEWHERE_EMAIL = 'elsewhere@oracle.test';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberId: string;

let ipCounter = 0;
const nextIp = () => `10.67.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function memberEmail(): Promise<string> {
  const { rows } = await app.db.pool.query<{ email: string }>(
    `SELECT u.email FROM "user" u JOIN workspace_members m ON m.user_id = u.id WHERE m.id = $1`,
    [memberId]
  );
  return rows[0]!.email;
}

/** Mint a change-email link for the member; must succeed (200). */
async function mint(newEmail: string): Promise<string> {
  const res = await app.app.request(
    `/api/v1/members/${memberId}/change-email-link`,
    json({ newEmail }, { cookie: ownerCookie })
  );
  expect(res.status).toBe(200);
  return (await readJson(res)).verifyUrl as string;
}

interface Observables {
  status: number;
  location: string | null;
  hasSessionCookie: boolean;
  hasErrorParam: boolean;
  body: string;
}

/** Consume a link logged out; returns the FULL observable set a prober reads. */
async function consume(verifyUrl: string): Promise<Observables> {
  const res = await app.app.request(verifyUrl, { headers: { 'x-forwarded-for': nextIp() } });
  const location = res.headers.get('location');
  const setCookie = res.headers.get('set-cookie') ?? '';
  const body = res.status === 200 ? await res.text() : '';
  return {
    status: res.status,
    location,
    hasSessionCookie: /better-auth\.session_token=[^;]/.test(setCookie),
    hasErrorParam: (location ?? '').includes('error='),
    body
  };
}

/** Rewrite (or drop) the callbackURL query param on a minted verify URL. */
function withCallback(verifyUrl: string, callbackURL: string | null): string {
  const u = new URL(verifyUrl, 'http://localhost:3000');
  if (callbackURL === null) u.searchParams.delete('callbackURL');
  else u.searchParams.set('callbackURL', callbackURL);
  return u.pathname + u.search;
}

/** Every observable must agree between the taken and the free consume. */
function expectIdentical(taken: Observables, free: Observables): void {
  expect(taken.status).toBe(free.status);
  expect(taken.location).toBe(free.location);
  expect(taken.hasSessionCookie).toBe(free.hasSessionCookie);
  expect(taken.hasErrorParam).toBe(false);
  expect(free.hasErrorParam).toBe(false);
  expect(taken.body).toBe(free.body);
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'oracle_uniform'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Oracle', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );

  // The member whose email the owner "changes" while probing.
  const inv = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  expect(
    (
      await app.app.request(
        '/api/v1/invitations/accept',
        json({ token, name: MEMBER.name, password: MEMBER.password })
      )
    ).status
  ).toBe(200);
  const members = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
  );
  memberId = members.members.find((m: { email: string }) => m.email === MEMBER.email).id;

  // The probed address: an account that exists on the instance but holds no
  // membership in this workspace (another tenant's user, say) — so the mint's
  // workspace-scoped advisory pre-check does NOT catch it and the collision
  // would only surface at consumption, exactly the oracle's shape.
  await app.db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('oracle-elsewhere-user', 'Elsewhere', $1, true, now(), now())`,
    [ELSEWHERE_EMAIL]
  );
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

/**
 * Consume, once for a FRESH unused address (the change goes through) and once
 * for ELSEWHERE_EMAIL (a collision), under the SAME callbackURL shape, and
 * assert every observable agrees. A counter hands each call a distinct fresh
 * address, since every successful free consume renames the member.
 */
let freshCounter = 0;
async function bothWaysUnder(callbackURL: string | null): Promise<{ taken: Observables; free: Observables }> {
  const fresh = `fresh${freshCounter++}@oracle.test`;
  const free = await consume(withCallback(await mint(fresh), callbackURL));
  const taken = await consume(withCallback(await mint(ELSEWHERE_EMAIL), callbackURL));
  return { taken, free };
}

describe('the change-email consume answers uniformly (door 1)', () => {
  it('the minted shape (relative callbackURL): taken ≡ free, and only free renames the member', async () => {
    const before = await memberEmail();
    const { taken, free } = await bothWaysUnder('/account');
    expectIdentical(taken, free);
    expect(free.status).toBeGreaterThanOrEqual(300);
    expect(free.status).toBeLessThan(400);
    // The free consume renamed the member; the collision left both accounts.
    expect(await memberEmail()).not.toBe(before);
    const { rows } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [ELSEWHERE_EMAIL]);
    expect(rows.length).toBe(1);
  });

  it('Repro A — no callbackURL (the JSON path): taken ≡ free, both user:null (no user record leaks)', async () => {
    const { taken, free } = await bothWaysUnder(null);
    expectIdentical(taken, free);
    expect(free.status).toBe(200);
    // The free JSON must be normalized to user:null — a leaked user record is
    // the whole oracle this repro exposed.
    expect(JSON.parse(free.body)).toEqual({ status: true, user: null });
    expect(JSON.parse(taken.body)).toEqual({ status: true, user: null });
  });

  it('Repro B — absolute SAME-ORIGIN callbackURL: taken ≡ free (both redirect, no oracle)', async () => {
    const { taken, free } = await bothWaysUnder('http://localhost:3000/account');
    expectIdentical(taken, free);
    expect(free.status).toBeGreaterThanOrEqual(300);
    expect(free.status).toBeLessThan(400);
  });

  // CAVEAT: this harness runs with NODE_ENV=test, which makes Better Auth
  // skip ITS OWN callbackURL origin check — so these two assertions exercise
  // safeRedirectLocation (our defence-in-depth layer) alone, not production's
  // stacked guards. Do not read them as proof the upstream guard works.
  it('an untrusted absolute callbackURL is refused IDENTICALLY on both branches (no open redirect)', async () => {
    const { taken, free } = await bothWaysUnder('http://evil.example/x');
    expect(taken.status).toBe(free.status);
    expect(taken.location).toBe(free.location);
    for (const o of [taken, free]) {
      expect(o.location ?? '').not.toContain('evil.example');
    }
  });

  it('a tab-smuggled protocol-relative callbackURL never redirects off-origin, and both branches agree', async () => {
    const { taken, free } = await bothWaysUnder('/\t/evil.example');
    expect(taken.status).toBe(free.status);
    expect(taken.location).toBe(free.location);
    for (const o of [taken, free]) {
      // The one thing that must never happen: a Location resolving off-origin.
      const loc = o.location;
      if (loc) {
        const resolved = new URL(loc, 'http://localhost:3000');
        expect(resolved.origin).toBe('http://localhost:3000');
      }
    }
  });

  it('never answers 5xx on the consume path, and the collision-branch session authenticates the target', async () => {
    const res = await app.app.request(withCallback(await mint(ELSEWHERE_EMAIL), '/account'), {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBeLessThan(500);
    // The link is sign-in-equivalent by design (LESSONS M6) — on the collision
    // branch too, and for the TARGET member, never the probed account.
    const cookie = extractCookie(res);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe(await memberEmail());
    expect(me.user.email).not.toBe(ELSEWHERE_EMAIL);
  });

  it('an invalid token keeps its ordinary error redirect (uniformity never hides real failures)', async () => {
    const res = await app.app.request('/api/v1/auth/verify-email?token=not-a-jwt&callbackURL=%2Faccount', {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toContain('error=');
  });
});

/** Mint an invitation and return its accept token. */
async function inviteToken(email: string): Promise<string> {
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', json({ email, role: 'member' }, { cookie: ownerCookie }))
  );
  return (inv.acceptUrl as string).split('/invite/')[1]!;
}

describe('the invitation accept answers uniformly to a credential-less probe (door 2)', () => {
  it('existing and fresh emails answer credentials_required alike; existence surfaces only on a committed create', async () => {
    // ELSEWHERE_EMAIL has an account on the instance; the fresh one does not.
    const takenToken = await inviteToken(ELSEWHERE_EMAIL);
    const freshToken = await inviteToken('door2-fresh@oracle.test');

    const probe = (token: string, body: Record<string, unknown> = {}) =>
      app.app.request('/api/v1/invitations/accept', json({ token, ...body }));

    // Credential-less: the account-existence bit is not readable for free —
    // same status, same code on both. (The old oracle answered 409
    // account_exists for the existing email, 400 for the fresh one.)
    const taken = await probe(takenToken);
    const fresh = await probe(freshToken);
    expect(taken.status).toBe(fresh.status);
    expect(taken.status).toBe(400);
    expect((await readJson(taken)).error.code).toBe('credentials_required');
    expect((await readJson(fresh)).error.code).toBe('credentials_required');

    // Existence surfaces ONLY after real credentials are committed — the
    // inherent signup collision, not a free pre-credential probe. The invite
    // stays alive (nothing created on the collision branch).
    const withCreds = await probe(takenToken, { name: 'Probe', password: 'a-probe-password-123' });
    expect(withCreds.status).toBe(409);
    expect((await readJson(withCreds)).error.code).toBe('account_exists');
  });
});
