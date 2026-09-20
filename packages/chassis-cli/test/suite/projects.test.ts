import { describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin } = cli.identity;

/**
 * The project commands: the method + path each one hits (recording fake
 * fetch), `--json` byte-exactness, the human rendering, the `@`-vs-user-id
 * detection of `members add`, and one refusal per server error code — each
 * one reading as a sentence rather than as the wire message.
 */

interface Canned {
  status?: number;
  body?: unknown;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function harness(responses: Canned[] = [{ status: 200, body: {} }]) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...responses];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    const r = queue.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  const io: CliIo = {
    env: {},
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    fetch
  };
  return { io, calls, out: () => out.join(''), err: () => err.join('') };
}

/** Every invocation carries the same instance + key; only the verb differs. */
const WIRED = ['--url', 'http://x', '--api-key', 'k'];

const PROJECT = {
  id: 'p-1',
  name: 'Atlas',
  description: 'The launch work',
  metadata: { tier: 'gold' },
  archivedAt: null,
  createdBy: 'u1',
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
  myRole: 'manager',
  memberCount: 3
};
const ARCHIVED = { ...PROJECT, id: 'p-2', name: 'Borealis', archivedAt: '2026-02-01T00:00:00.000Z' };
const MEMBER = {
  userId: 'u2',
  email: 'ada@x.co',
  name: 'Ada',
  role: 'editor',
  addedBy: 'u1',
  createdAt: '2026-01-02T03:04:05.000Z'
};

/** An error body in the server's shape. */
const refusal = (status: number, code: string, message = 'terse wire message'): Canned => ({
  status,
  body: { error: { code, message } }
});

describe(`${bin} projects`, () => {
  // ── list ───────────────────────────────────────────────────────────────────

  it('list → GET /api/v1/projects', async () => {
    const h = harness([{ body: { projects: [PROJECT], nextCursor: null } }]);
    const code = await run(['projects', 'list', ...WIRED], h.io);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/projects', body: undefined }]);
    expect(h.out()).toContain('Atlas');
    expect(h.out()).toContain('p-1');
    expect(h.out()).toContain('3 members');
  });

  it('list says so when there is nothing', async () => {
    const h = harness([{ body: { projects: [], nextCursor: null } }]);
    expect(await run(['projects', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe('No projects.\n');
  });

  it('list threads --cursor, --limit and --archived onto the query string', async () => {
    const h = harness([{ body: { projects: [], nextCursor: null } }]);
    const code = await run(
      ['projects', 'list', '--cursor', 'abc', '--limit', '2', '--archived', 'all', ...WIRED],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls[0]!.path).toBe('/api/v1/projects?cursor=abc&limit=2&archived=all');
  });

  it('list --archived true asks for the archived ones only', async () => {
    const h = harness([{ body: { projects: [ARCHIVED], nextCursor: null } }]);
    expect(await run(['projects', 'list', '--archived', 'true', ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.path).toBe('/api/v1/projects?archived=true');
    expect(h.out()).toContain('[archived]');
  });

  it('list refuses an --archived value that is not false|true|all, before any request', async () => {
    const h = harness();
    expect(await run(['projects', 'list', '--archived', 'yes', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('one of false, true, all');
  });

  it('list --all follows nextCursor and prints every page', async () => {
    const h = harness([
      { body: { projects: [PROJECT], nextCursor: 'p-1' } },
      { body: { projects: [{ ...PROJECT, id: 'p-9', name: 'Zephyr' }], nextCursor: null } }
    ]);
    expect(await run(['projects', 'list', '--all', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/projects', '/api/v1/projects?cursor=p-1']);
    expect(h.out()).toContain('Atlas');
    expect(h.out()).toContain('Zephyr');
  });

  it('list --json prints the wire shape { projects, nextCursor } byte-exactly', async () => {
    const h = harness([{ body: { projects: [PROJECT], nextCursor: 'p-1' } }]);
    expect(await run(['projects', 'list', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify({ projects: [PROJECT], nextCursor: 'p-1' }, null, 2)}\n`);
  });

  // ── get ────────────────────────────────────────────────────────────────────

  it('get → GET /api/v1/projects/:id', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'get', 'p-1', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/projects/p-1', body: undefined }]);
    expect(h.out()).toContain('your role:   manager');
    expect(h.out()).toContain('The launch work');
  });

  it('get --json prints the project payload byte-exactly', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'get', 'p-1', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(PROJECT, null, 2)}\n`);
  });

  it('get escapes an id into the path', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'get', 'a/b c', ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.path).toBe('/api/v1/projects/a%2Fb%20c');
  });

  // ── create ─────────────────────────────────────────────────────────────────

  it('create → POST /api/v1/projects with the name', async () => {
    const h = harness([{ status: 201, body: PROJECT }]);
    expect(await run(['projects', 'create', 'Atlas', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/v1/projects', body: { name: 'Atlas' } }]);
    expect(h.out()).toContain('Created project "Atlas".');
  });

  it('create carries --description and --metadata', async () => {
    const h = harness([{ status: 201, body: PROJECT }]);
    const code = await run(
      [
        'projects',
        'create',
        'Atlas',
        '--description',
        'The launch work',
        '--metadata',
        '{"tier":"gold"}',
        ...WIRED
      ],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls[0]!.body).toEqual({
      name: 'Atlas',
      description: 'The launch work',
      metadata: { tier: 'gold' }
    });
  });

  it('create refuses --metadata that is not a JSON object, before any request', async () => {
    const h = harness();
    expect(await run(['projects', 'create', 'Atlas', '--metadata', '[1,2]', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('takes a JSON object');

    const h2 = harness();
    expect(await run(['projects', 'create', 'Atlas', '--metadata', 'nope{', ...WIRED], h2.io)).toBe(1);
    expect(h2.calls).toEqual([]);
    expect(h2.err()).toContain('did not parse as JSON');
  });

  // ── update ─────────────────────────────────────────────────────────────────

  it('update → PATCH /api/v1/projects/:id with only the fields passed', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'update', 'p-1', '--name', 'Atlas II', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'PATCH', path: '/api/v1/projects/p-1', body: { name: 'Atlas II' } }]);
    expect(h.out()).toContain('Updated project');
  });

  it('update --clear-description sends description: null', async () => {
    const h = harness([{ body: { ...PROJECT, description: null } }]);
    expect(await run(['projects', 'update', 'p-1', '--clear-description', ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ description: null });
  });

  it('update refuses --description together with --clear-description', async () => {
    const h = harness();
    const code = await run(
      ['projects', 'update', 'p-1', '--description', 'x', '--clear-description', ...WIRED],
      h.io
    );
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('not both');
  });

  it('update with nothing to change never reaches the wire', async () => {
    const h = harness();
    expect(await run(['projects', 'update', 'p-1', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Nothing to change');
  });

  it('update --json prints the project payload byte-exactly', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'update', 'p-1', '--name', 'Atlas', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(PROJECT, null, 2)}\n`);
  });

  // ── archive / unarchive ────────────────────────────────────────────────────

  it('archive → POST /api/v1/projects/:id/archive', async () => {
    const h = harness([{ body: ARCHIVED }]);
    expect(await run(['projects', 'archive', 'p-2', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/v1/projects/p-2/archive', body: undefined }]);
    expect(h.out()).toContain('Archived "Borealis"');
  });

  it('unarchive → POST /api/v1/projects/:id/unarchive', async () => {
    const h = harness([{ body: PROJECT }]);
    expect(await run(['projects', 'unarchive', 'p-1', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/v1/projects/p-1/unarchive', body: undefined }]);
    expect(h.out()).toContain('writable again');
  });

  it('archive --json prints the project payload byte-exactly', async () => {
    const h = harness([{ body: ARCHIVED }]);
    expect(await run(['projects', 'archive', 'p-2', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(ARCHIVED, null, 2)}\n`);
  });

  // ── members ────────────────────────────────────────────────────────────────

  it('members list → GET /api/v1/projects/:id/members', async () => {
    const h = harness([{ body: { members: [MEMBER], nextCursor: null } }]);
    expect(await run(['projects', 'members', 'list', 'p-1', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/projects/p-1/members', body: undefined }]);
    expect(h.out()).toContain('ada@x.co');
    expect(h.out()).toContain('editor');
  });

  it('members list says so when there is nobody', async () => {
    const h = harness([{ body: { members: [], nextCursor: null } }]);
    expect(await run(['projects', 'members', 'list', 'p-1', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe('No members.\n');
  });

  it('members list threads --cursor / --limit and follows --all', async () => {
    const h = harness([
      { body: { members: [MEMBER], nextCursor: 'u2' } },
      { body: { members: [{ ...MEMBER, userId: 'u3', email: 'bo@x.co' }], nextCursor: null } }
    ]);
    expect(await run(['projects', 'members', 'list', 'p-1', '--limit', '1', '--all', ...WIRED], h.io)).toBe(
      0
    );
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/projects/p-1/members?limit=1',
      '/api/v1/projects/p-1/members?cursor=u2&limit=1'
    ]);
    expect(h.out()).toContain('bo@x.co');
  });

  it('members list --json prints { members, nextCursor } byte-exactly', async () => {
    const h = harness([{ body: { members: [MEMBER], nextCursor: null } }]);
    expect(await run(['projects', 'members', 'list', 'p-1', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify({ members: [MEMBER], nextCursor: null }, null, 2)}\n`);
  });

  it('members add sends { email } when the argument carries an @', async () => {
    const h = harness([{ status: 201, body: MEMBER }]);
    const code = await run(
      ['projects', 'members', 'add', 'p-1', 'ada@x.co', '--role', 'editor', ...WIRED],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/projects/p-1/members',
        body: { email: 'ada@x.co', role: 'editor' }
      }
    ]);
    expect(h.out()).toContain('Added Ada <ada@x.co> is a editor');
  });

  it('members add sends { userId } when the argument carries no @', async () => {
    const h = harness([{ status: 201, body: MEMBER }]);
    const code = await run(['projects', 'members', 'add', 'p-1', 'u2', '--role', 'viewer', ...WIRED], h.io);
    expect(code).toBe(0);
    expect(h.calls[0]!.body).toEqual({ userId: 'u2', role: 'viewer' });
  });

  it('members add refuses an unknown role before any request', async () => {
    const h = harness();
    expect(await run(['projects', 'members', 'add', 'p-1', 'u2', '--role', 'admin', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Unknown role "admin"');
  });

  it('members add --json prints the member payload byte-exactly', async () => {
    const h = harness([{ status: 201, body: MEMBER }]);
    const code = await run(
      ['projects', 'members', 'add', 'p-1', 'u2', '--role', 'editor', '--json', ...WIRED],
      h.io
    );
    expect(code).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(MEMBER, null, 2)}\n`);
  });

  it('members role → PATCH /api/v1/projects/:id/members/:userId', async () => {
    const h = harness([{ body: { ...MEMBER, role: 'manager' } }]);
    expect(await run(['projects', 'members', 'role', 'p-1', 'u2', 'manager', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/v1/projects/p-1/members/u2',
        body: { role: 'manager' }
      }
    ]);
    expect(h.out()).toContain('Now Ada <ada@x.co> is a manager');
  });

  it('members role refuses an unknown role before any request', async () => {
    const h = harness();
    expect(await run(['projects', 'members', 'role', 'p-1', 'u2', 'boss', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Unknown role "boss"');
  });

  it('members remove → DELETE /api/v1/projects/:id/members/:userId', async () => {
    const h = harness([{ body: MEMBER }]);
    expect(await run(['projects', 'members', 'remove', 'p-1', 'u2', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'DELETE', path: '/api/v1/projects/p-1/members/u2', body: undefined }]);
    expect(h.out()).toContain('Removed Ada <ada@x.co>');
  });

  it('members remove --json prints the member payload byte-exactly', async () => {
    const h = harness([{ body: MEMBER }]);
    expect(await run(['projects', 'members', 'remove', 'p-1', 'u2', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(MEMBER, null, 2)}\n`);
  });

  // ── the refusals, one per server code, each one a sentence ─────────────────

  const REFUSALS: Array<{ code: string; status: number; argv: string[]; says: string }> = [
    {
      code: 'not_found',
      status: 404,
      argv: ['projects', 'get', 'p-1'],
      says: 'No such project, or it is not yours to read.'
    },
    {
      code: 'insufficient_project_role',
      status: 403,
      argv: ['projects', 'update', 'p-1', '--name', 'x'],
      says: 'You need the manager role on this project to do that.'
    },
    {
      code: 'guest_forbidden',
      status: 403,
      argv: ['projects', 'list'],
      says: 'guests do not take part in projects'
    },
    {
      code: 'project_archived',
      status: 409,
      argv: ['projects', 'update', 'p-1', '--name', 'x'],
      says: 'This project is archived and read-only. Unarchive it first to change it.'
    },
    {
      code: 'project_not_archived',
      status: 409,
      argv: ['projects', 'unarchive', 'p-1'],
      says: 'This project is not archived, so there is nothing to unarchive.'
    },
    {
      code: 'already_member',
      status: 409,
      argv: ['projects', 'members', 'add', 'p-1', 'u2', '--role', 'viewer'],
      says: 'already a member of this project'
    },
    {
      code: 'member_not_found',
      status: 404,
      argv: ['projects', 'members', 'add', 'p-1', 'u9', '--role', 'viewer'],
      says: 'No active member of this workspace matches'
    },
    {
      code: 'guest_target',
      status: 403,
      argv: ['projects', 'members', 'add', 'p-1', 'g@x.co', '--role', 'viewer'],
      says: 'a guest cannot be a project member'
    }
  ];

  for (const { code, status, argv, says } of REFUSALS) {
    it(`${code} (${status}) reads as a sentence, and exits 1`, async () => {
      const h = harness([refusal(status, code)]);
      expect(await run([...argv, ...WIRED], h.io)).toBe(1);
      expect(h.err()).toContain(says);
      // The terse wire message never reaches the human.
      expect(h.err()).not.toContain('terse wire message');
    });
  }

  it('insufficient_project_role names the role the wire names: a tool route may gate on editor', async () => {
    const h = harness([
      refusal(403, 'insufficient_project_role', 'This needs the editor role on the project')
    ]);
    expect(await run(['projects', 'update', 'p-1', '--name', 'x', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('You need the editor role on this project to do that.');
  });

  it('member_not_found on a member route names the PROJECT, not the workspace', async () => {
    const h = harness([refusal(404, 'member_not_found')]);
    expect(await run(['projects', 'members', 'remove', 'p-1', 'u9', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('That person is not a member of this project.');
  });

  it('an unmapped refusal keeps the server message', async () => {
    const h = harness([refusal(400, 'validation_error', 'name must be at most 200 characters')]);
    expect(await run(['projects', 'create', 'Atlas', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('name must be at most 200 characters');
  });

  it('every project command needs an API key', async () => {
    // With no key, the runner probes discovery once; a non-cloud answer keeps
    // the classic error and nothing else is requested.
    const h = harness([
      {
        body: {
          name: 'Acme',
          version: '1.0.0',
          edition: 'oss',
          setupRequired: false,
          auth: { methods: ['api-key'], passwordReset: false }
        }
      }
    ]);
    expect(await run(['projects', 'list', '--url', 'http://x'], h.io)).toBe(1);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/instance']);
    expect(h.err()).toContain('API key is required');
  });

  // ── the human sinks are sanitized, `--json` is not ─────────────────────────

  it('a project name carrying terminal control bytes is sanitized in the human output', async () => {
    const nasty = { ...PROJECT, name: 'Atlas\u001b[2KHIDDEN' };
    const h = harness([{ body: { projects: [nasty], nextCursor: null } }]);
    expect(await run(['projects', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.out()).not.toContain('\u001b');
    expect(h.out()).toContain('AtlasHIDDEN');
  });

  it('--json keeps the same bytes the server sent, escapes included', async () => {
    const nasty = { ...PROJECT, name: 'Atlas\u001b[2KHIDDEN' };
    const h = harness([{ body: { projects: [nasty], nextCursor: null } }]);
    expect(await run(['projects', 'list', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify({ projects: [nasty], nextCursor: null }, null, 2)}\n`);
    expect(h.out()).toContain('\\u001b');
  });

  // ── the command tree ───────────────────────────────────────────────────────

  it('completion enumerates the new group from the live tree', async () => {
    const h = harness();
    expect(await run(['completion', 'zsh'], h.io)).toBe(0);
    expect(h.out()).toContain('projects');
    expect(h.out()).toContain('list get create update archive unarchive members');
  });
});
