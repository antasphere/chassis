import { describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin, envPrefix } = cli.identity;

/**
 * The demo commands act as a SIGNED-IN OWNER (owner-session.ts): one
 * password sign-in, the session cookie on every request and no
 * authorization header, a sign-out whatever happened. The password and the
 * cookie never reach an output, and the secret leaves only inside the links.
 */

interface Canned {
  status?: number;
  body?: unknown;
  setCookie?: string[];
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const PASSWORD = 'correct-horse-9f3a';
const COOKIE_VALUE = 'sessTOKEN.c0ffee';
const COOKIE = `x.session_token=${COOKIE_VALUE}`;
const SECRET = 'S3cretPassValue_abcdefghijklmnopqrstuvwxyz0';

function harness(responses: Canned[], env: Record<string, string> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const waits: number[] = [];
  const queue = [...responses];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    const r = queue.shift() ?? { status: 200, body: {} };
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const c of r.setCookie ?? []) headers.append('set-cookie', c);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers });
  }) as typeof globalThis.fetch;
  const io: CliIo = {
    env: {
      [`${envPrefix}_OWNER_EMAIL`]: 'owner@example.com',
      [`${envPrefix}_OWNER_PASSWORD`]: PASSWORD,
      ...env
    },
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    }
  };
  return { io, calls, waits, out: () => out.join(''), err: () => err.join('') };
}

const URL_FLAGS = ['--url', 'http://demo.localhost:3000'];

const SIGNED_IN: Canned = {
  body: { redirect: false, token: 'ignored', user: { id: 'o1' } },
  setCookie: [
    'x.session_data=cache; Path=/; HttpOnly',
    `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
    'x.dont_remember=; Path=/'
  ]
};
const SIGNED_OUT: Canned = { body: { success: true } };

const PASS = {
  id: 'dp-1',
  userId: 'u2',
  email: 'ada@example.com',
  name: 'Ada\u009b2K\u007fHIDDEN',
  targetPath: '/decks',
  createdBy: 'o1',
  createdAt: '2026-09-27T20:00:00.000Z',
  expiresAt: '2026-09-28T20:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  useCount: 0
};
const MINTED: Canned = {
  status: 201,
  body: { pass: PASS, secret: SECRET, url: `http://demo.localhost:3000/demo#pass=${SECRET}&to=%2Fdecks` }
};

const refusal = (status: number, code: string, message: string): Canned => ({
  status,
  body: { error: { code, message } }
});

/** Neither secret of the owner appears in any output, whatever the outcome. */
function expectNoLeak(h: ReturnType<typeof harness>): void {
  for (const text of [h.out(), h.err()]) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(COOKIE_VALUE);
  }
}

describe(`${bin} demo`, () => {
  it('link signs in with the origin and no key, mints with the cookie and no key, then signs out', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    const code = await run(
      ['demo', 'link', '--email', 'ada@example.com', '--path', '/decks', ...URL_FLAGS, '--api-key', 'k'],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/auth/sign-in/email',
      'POST /api/v1/demo/passes',
      'POST /api/v1/auth/sign-out'
    ]);
    const [signIn, mint, signOut] = h.calls;
    expect(signIn!.headers['origin']).toBe('http://demo.localhost:3000');
    expect(signIn!.headers['content-type']).toBe('application/json');
    expect(signIn!.headers).not.toHaveProperty('authorization');
    expect(signIn!.body).toEqual({ email: 'owner@example.com', password: PASSWORD });
    // Only the session cookie's name=value, never its attributes nor the other cookies.
    expect(mint!.headers['cookie']).toBe(COOKIE);
    expect(mint!.headers['origin']).toBe('http://demo.localhost:3000');
    expect(mint!.headers).not.toHaveProperty('authorization');
    expect(mint!.body).toEqual({ email: 'ada@example.com', path: '/decks' });
    expect(signOut!.headers['cookie']).toBe(COOKIE);
    expect(signOut!.headers['origin']).toBe('http://demo.localhost:3000');
    expect(signOut!.headers).not.toHaveProperty('authorization');
    expectNoLeak(h);
  });

  it('link: one pass, three --path, three links with the fragment and the encoded page', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    const code = await run(
      [
        'demo',
        'link',
        '--email',
        'ada@example.com',
        '--path',
        '/decks',
        '--path',
        '/decks/d1?view=grid&x=1',
        '--path',
        '/settings/members',
        ...URL_FLAGS
      ],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls.filter((c) => c.path === '/api/v1/demo/passes')).toHaveLength(1);
    const base = `http://demo.localhost:3000/demo#pass=${SECRET}&to=`;
    const expected = [
      `${base}%2Fdecks`,
      `${base}%2Fdecks%2Fd1%3Fview%3Dgrid%26x%3D1`,
      `${base}%2Fsettings%2Fmembers`
    ];
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toBe(
      'Demo link for Ada2KHIDDEN <ada@example.com>, valid until 2026-09-28T20:00:00.000Z:'
    );
    expect(lines.slice(1)).toEqual(expected);
    expectNoLeak(h);
  });

  it('link --json is { passes: [{ pass, links }], refused } byte-exact, the secret only inside the urls', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    const code = await run(
      [
        'demo',
        'link',
        '--email',
        'ada@example.com',
        '--path',
        '/decks',
        '--path',
        '/',
        ...URL_FLAGS,
        '--json'
      ],
      h.io
    );
    expect(code).toBe(0);
    const base = `http://demo.localhost:3000/demo#pass=${SECRET}&to=`;
    const value = {
      passes: [
        {
          pass: PASS,
          links: [
            { path: '/decks', url: `${base}%2Fdecks` },
            { path: '/', url: `${base}%2F` }
          ]
        }
      ],
      refused: []
    };
    expect(h.out()).toBe(JSON.stringify(value, null, 2) + '\n');
    // The raw name survives: --json never goes through the TTY sanitizer.
    expect(h.out()).toContain('Ada\u009b2K\u007fHIDDEN');
    expect(JSON.parse(h.out())).toEqual(value);
    expect(h.out().split(SECRET)).toHaveLength(3);
    expectNoLeak(h);
  });

  it('link refuses a bad --path before any request', async () => {
    for (const bad of [
      'decks',
      '//evil.example',
      '/\\evil',
      '/a#b',
      '/a b',
      '/a\u0007',
      `/${'a'.repeat(2048)}`
    ]) {
      const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
      const code = await run(
        ['demo', 'link', '--email', 'ada@example.com', '--path', '/ok', '--path', bad, ...URL_FLAGS],
        h.io
      );
      expect(code).toBe(1);
      expect(h.calls).toEqual([]);
      expect(h.err()).toContain('is not a page of this instance');
    }
  });

  it('link --hours 2 sends 120 minutes, --minutes 45 sends 45', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    expect(
      await run(['demo', 'link', '--email', 'ada@example.com', '--hours', '2', ...URL_FLAGS], h.io)
    ).toBe(0);
    expect(h.calls[1]!.body).toEqual({ email: 'ada@example.com', path: '/', expiresInMinutes: 120 });

    const m = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    expect(
      await run(['demo', 'link', '--email', 'ada@example.com', '--minutes', '45', ...URL_FLAGS], m.io)
    ).toBe(0);
    expect(m.calls[1]!.body).toEqual({ email: 'ada@example.com', path: '/', expiresInMinutes: 45 });
  });

  it('link with both --hours and --minutes is a usage error, and so is a lifetime past a week', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    const code = await run(
      ['demo', 'link', '--email', 'ada@example.com', '--hours', '2', '--minutes', '5', ...URL_FLAGS],
      h.io
    );
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('either --hours or --minutes, not both');

    const w = harness([SIGNED_IN, MINTED, SIGNED_OUT]);
    expect(
      await run(['demo', 'link', '--email', 'ada@example.com', '--hours', '169', ...URL_FLAGS], w.io)
    ).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it('a missing password is a usage error naming both variables, and no request is made', async () => {
    const h = harness([SIGNED_IN, MINTED, SIGNED_OUT], { [`${envPrefix}_OWNER_PASSWORD`]: '' });
    const code = await run(['demo', 'link', '--email', 'ada@example.com', ...URL_FLAGS], h.io);
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain(`${envPrefix}_OWNER_EMAIL`);
    expect(h.err()).toContain(`${envPrefix}_OWNER_PASSWORD`);
  });

  it('--owner-email and --owner-password-stdin replace the variables', async () => {
    const h = harness([SIGNED_IN, { body: { passes: [] } }, SIGNED_OUT], {
      [`${envPrefix}_OWNER_EMAIL`]: '',
      [`${envPrefix}_OWNER_PASSWORD`]: ''
    });
    h.io.readStdin = async () => `${PASSWORD}\n`;
    const code = await run(
      ['demo', 'list', '--owner-email', 'boss@example.com', '--owner-password-stdin', ...URL_FLAGS],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls[0]!.body).toEqual({ email: 'boss@example.com', password: PASSWORD });
    expect(h.out()).toBe('No demo passes.\n');
    expectNoLeak(h);
  });

  it('signs out after a refused mint too, and prints the server sentence', async () => {
    const sentence = 'A demo link cannot open another owner’s account';
    const h = harness([SIGNED_IN, refusal(403, 'owner_target', sentence), SIGNED_OUT]);
    const code = await run(['demo', 'link', '--email', 'boss2@example.com', ...URL_FLAGS], h.io);
    expect(code).toBe(1);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/auth/sign-in/email',
      '/api/v1/demo/passes',
      '/api/v1/auth/sign-out'
    ]);
    expect(h.calls[2]!.headers['cookie']).toBe(COOKIE);
    expect(h.err()).toBe(`Error: boss2@example.com: ${sentence}\n`);
    expectNoLeak(h);
  });

  it('each refusal code reads as the server sentence, without an API key hint', async () => {
    for (const [status, code] of [
      [404, 'no_such_member'],
      [403, 'demo_address_required'],
      [403, 'two_factor_enrolled'],
      [403, 'guest_target'],
      [403, 'cross_workspace_target'],
      [400, 'invalid_demo_path'],
      [403, 'sessions_only']
    ] as const) {
      const h = harness([SIGNED_IN, refusal(status, code, `the ${code} sentence`), SIGNED_OUT]);
      expect(await run(['demo', 'link', '--email', 'ada@example.com', ...URL_FLAGS], h.io)).toBe(1);
      expect(h.err()).toBe(`Error: ada@example.com: the ${code} sentence\n`);
      expect(h.calls.at(-1)!.path).toBe('/api/v1/auth/sign-out');
    }
  });

  it('an admin or a member who signs in reads that an owner is needed, with no API key hint', async () => {
    const h = harness([SIGNED_IN, refusal(403, 'forbidden', 'Requires owner role'), SIGNED_OUT]);
    expect(await run(['demo', 'list', ...URL_FLAGS], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: Only an owner of this workspace manages demo links: the account that signed in is not one.\n'
    );
    expect(h.calls.at(-1)!.path).toBe('/api/v1/auth/sign-out');
    expectNoLeak(h);
  });

  it('several --email: one sign-in, one pass each, a refused member does not stop the others, exit 1', async () => {
    const sentence = 'A demo link opens only a demonstration address';
    const h = harness([
      SIGNED_IN,
      MINTED,
      refusal(403, 'demo_address_required', sentence),
      MINTED,
      SIGNED_OUT
    ]);
    const code = await run(
      [
        'demo',
        'link',
        '--email',
        'ada@example.com',
        '--email',
        'real@gmail.com',
        '--email',
        'bob@example.com',
        ...URL_FLAGS,
        '--json'
      ],
      h.io
    );
    expect(code).toBe(1);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/auth/sign-in/email',
      '/api/v1/demo/passes',
      '/api/v1/demo/passes',
      '/api/v1/demo/passes',
      '/api/v1/auth/sign-out'
    ]);
    expect(h.calls.slice(1, 4).map((c) => (c.body as { email: string }).email)).toEqual([
      'ada@example.com',
      'real@gmail.com',
      'bob@example.com'
    ]);
    const printed = JSON.parse(h.out());
    expect(printed.passes).toHaveLength(2);
    expect(printed.refused).toEqual([
      { email: 'real@gmail.com', code: 'demo_address_required', message: sentence }
    ]);
    expect(h.err()).toBe(`Error: real@gmail.com: ${sentence}\n`);
    expectNoLeak(h);
  });

  it('the sign-in wall is waited out: 429, a wait, then the sign-in and the command go through', async () => {
    const wall = { status: 429, body: { message: 'Too many requests. Please try again later.' } };
    const h = harness([wall, wall, SIGNED_IN, { body: { passes: [] } }, SIGNED_OUT]);
    expect(await run(['demo', 'list', ...URL_FLAGS], h.io)).toBe(0);
    expect(h.waits).toEqual([4000, 8000]);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/auth/sign-in/email',
      '/api/v1/auth/sign-in/email',
      '/api/v1/auth/sign-in/email',
      '/api/v1/demo/passes',
      '/api/v1/auth/sign-out'
    ]);
    expect(h.err()).toBe(
      'The instance limits sign-ins: waiting 4 seconds.\nThe instance limits sign-ins: waiting 8 seconds.\n'
    );
    expectNoLeak(h);
  });

  it('the unknown-route 404 says the switch is off, on each of the three commands', async () => {
    for (const argv of [
      ['demo', 'link', '--email', 'ada@example.com'],
      ['demo', 'list'],
      ['demo', 'revoke', 'dp-1']
    ]) {
      const h = harness([SIGNED_IN, refusal(404, 'not_found', 'Not found'), SIGNED_OUT]);
      expect(await run([...argv, ...URL_FLAGS], h.io)).toBe(1);
      expect(h.err()).toBe(
        'Error: Demo sign-in is off on this instance (DEMO_SIGN_IN), or this is the cloud edition, where demo links are minted at the Antasphere hub.\n'
      );
      expect(h.calls.at(-1)!.path).toBe('/api/v1/auth/sign-out');
      expectNoLeak(h);
    }
  });

  it('revoke of an unknown pass keeps the server sentence', async () => {
    const h = harness([SIGNED_IN, refusal(404, 'not_found', 'Demo pass not found'), SIGNED_OUT]);
    expect(await run(['demo', 'revoke', 'dp-9', ...URL_FLAGS], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Demo pass not found\n');
  });

  it('an owner with a second factor is refused, and no session is left behind', async () => {
    const h = harness([
      { body: { twoFactorRedirect: true, twoFactorMethods: ['totp'] }, setCookie: ['x.two_factor=t; Path=/'] }
    ]);
    expect(await run(['demo', 'list', ...URL_FLAGS], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.err()).toBe('Error: This owner has a second factor: mint demo links from the dashboard.\n');
    expectNoLeak(h);
  });

  it('a refused sign-in prints the server message; the rate wall says to wait', async () => {
    const bad = harness([
      { status: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } }
    ]);
    expect(await run(['demo', 'list', ...URL_FLAGS], bad.io)).toBe(1);
    expect(bad.err()).toBe('Error: Invalid email or password\n');
    expect(bad.calls).toHaveLength(1);
    expectNoLeak(bad);

    const limited = { status: 429, body: {} };
    const wall = harness([limited, limited, limited, limited]);
    expect(await run(['demo', 'list', ...URL_FLAGS], wall.io)).toBe(1);
    expect(wall.waits).toEqual([4000, 8000, 12000]);
    expect(wall.calls).toHaveLength(4);
    expect(wall.err()).toContain('wait a few minutes');
  });

  it('list prints the passes; revoke prints the pass; both sign out', async () => {
    const used = { ...PASS, id: 'dp-2', lastUsedAt: '2026-09-27T21:00:00.000Z', useCount: 3 };
    const h = harness([SIGNED_IN, { body: { passes: [used, PASS] } }, SIGNED_OUT]);
    expect(await run(['demo', 'list', ...URL_FLAGS], h.io)).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+PERSON\s+PAGE\s+EXPIRES\s+REVOKED\s+LAST USED\s+USES$/);
    expect(lines[1]).toContain('dp-2');
    expect(lines[1]).toContain('2026-09-27T21:00:00.000Z');
    expect(lines[1]).toMatch(/3$/);
    expect(lines[2]).toContain('never');
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/auth/sign-in/email',
      'GET /api/v1/demo/passes',
      'POST /api/v1/auth/sign-out'
    ]);

    const r = harness([SIGNED_IN, { body: { ...PASS, revokedAt: '2026-09-27T22:00:00.000Z' } }, SIGNED_OUT]);
    expect(await run(['demo', 'revoke', 'dp-1', ...URL_FLAGS, '--json'], r.io)).toBe(0);
    expect(r.calls[1]).toMatchObject({ method: 'DELETE', path: '/api/v1/demo/passes/dp-1' });
    expect(JSON.parse(r.out())).toMatchObject({ id: 'dp-1', revokedAt: '2026-09-27T22:00:00.000Z' });
    expect(r.calls[2]!.path).toBe('/api/v1/auth/sign-out');
  });
});
