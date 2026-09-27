import { describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin } = cli.identity;

/**
 * The team commands (PRDCT-2813) and the team side of `projects members`
 * (PRDCT-2794): the method + path each one hits (recording fake fetch), a
 * `<team>` resolved by slug through the list or read directly by id,
 * `--json` byte-exactness, and the refusals read as sentences.
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

const WIRED = ['--url', 'http://x', '--api-key', 'k'];

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const TEAM = {
  id: TEAM_ID,
  slug: 'design',
  name: 'Design',
  membersCount: 2,
  isMember: true,
  hubTeamId: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z'
};
const HUB_TEAM = {
  ...TEAM,
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'sales',
  name: 'Sales',
  isMember: false,
  hubTeamId: 'hub-t-1'
};
const TEAM_MEMBER = {
  userId: 'u2',
  email: 'ada@x.co',
  name: 'Ada',
  role: 'member',
  isActive: true,
  addedAt: '2026-09-02T10:00:00.000Z'
};
const PROJECT_TEAM = {
  kind: 'team',
  teamId: TEAM_ID,
  slug: 'design',
  name: 'Design',
  membersCount: 2,
  hubTeamId: null,
  role: 'editor',
  addedBy: 'u1',
  createdAt: '2026-09-03T10:00:00.000Z'
};

/** A C1 CSI and a DEL: bytes `JSON.stringify` keeps as they are (see projects.test.ts). */
const RAW_NAME = 'Design\u009b2K\u007fHIDDEN';

const LIST = { body: { teams: [TEAM, HUB_TEAM], nextCursor: null } };

const refusal = (status: number, code: string, details?: unknown): Canned => ({
  status,
  body: { error: { code, message: 'terse wire message', ...(details ? { details } : {}) } }
});

describe(`${bin} teams`, () => {
  it('list reads every page and prints the columns, the account site marked', async () => {
    const h = harness([
      { body: { teams: [TEAM], nextCursor: 'c1' } },
      { body: { teams: [HUB_TEAM], nextCursor: null } }
    ]);
    expect(await run(['teams', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/teams',
      'GET /api/v1/teams?cursor=c1'
    ]);
    const lines = h.out().split('\n');
    expect(lines[0]).toMatch(/^SLUG\s+NAME\s+MEMBERS\s+YOURS\s+CREATED$/);
    expect(h.out()).toMatch(/design\s+Design\s+2\s+yes\s+2026-09-01/);
    expect(h.out()).toContain('Sales (Antasphere)');
  });

  it('list says so when there is nothing', async () => {
    const h = harness([{ body: { teams: [], nextCursor: null } }]);
    expect(await run(['teams', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe('No teams.\n');
  });

  it('list --json prints the wire shape byte-exactly', async () => {
    const raw = { ...TEAM, name: RAW_NAME };
    const h = harness([{ body: { teams: [raw], nextCursor: null } }]);
    expect(await run(['teams', 'list', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify({ teams: [raw], nextCursor: null }, null, 2)}\n`);
  });

  it('get <id> reads the team directly; get <slug> searches the list', async () => {
    const h = harness([{ body: TEAM }]);
    expect(await run(['teams', 'get', TEAM_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([`/api/v1/teams/${TEAM_ID}`]);
    expect(h.out()).toContain('slug:     design');

    const h2 = harness([LIST]);
    expect(await run(['teams', 'get', 'sales', ...WIRED], h2.io)).toBe(0);
    expect(h2.calls.map((c) => c.path)).toEqual(['/api/v1/teams']);
    expect(h2.out()).toContain('on the Antasphere account site');
  });

  it('get of an unknown slug says so', async () => {
    const h = harness([LIST]);
    expect(await run(['teams', 'get', 'nope', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('No team of this workspace has the slug or id "nope".');
  });

  it('create sends the name alone, the slug derived by the server', async () => {
    const h = harness([{ status: 201, body: TEAM }]);
    expect(await run(['teams', 'create', 'Design', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/v1/teams', body: { name: 'Design' } }]);
    expect(h.out()).toContain('Created team design.');
  });

  it('create --slug sends the slug', async () => {
    const h = harness([{ status: 201, body: TEAM }]);
    expect(await run(['teams', 'create', 'Design', '--slug', 'design', ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ name: 'Design', slug: 'design' });
  });

  it('rename resolves the slug, then PATCHes only what was passed', async () => {
    const h = harness([LIST, { body: { ...TEAM, name: 'Design Ops' } }]);
    expect(await run(['teams', 'rename', 'design', '--name', 'Design Ops', ...WIRED], h.io)).toBe(0);
    expect(h.calls[1]).toEqual({
      method: 'PATCH',
      path: `/api/v1/teams/${TEAM_ID}`,
      body: { name: 'Design Ops' }
    });
    expect(h.out()).toBe('Team design: Design Ops\n');
  });

  it('rename with nothing to change never reaches the wire', async () => {
    const h = harness();
    expect(await run(['teams', 'rename', 'design', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Nothing to change');
  });

  it('delete without --yes is refused before any request', async () => {
    const h = harness();
    expect(await run(['teams', 'delete', 'design', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('rerun with --yes');
  });

  it('delete --yes → DELETE /api/v1/teams/:id', async () => {
    const h = harness([{ body: TEAM }, { body: TEAM }]);
    expect(await run(['teams', 'delete', TEAM_ID, '--yes', ...WIRED], h.io)).toBe(0);
    expect(h.calls[1]).toEqual({ method: 'DELETE', path: `/api/v1/teams/${TEAM_ID}`, body: undefined });
    expect(h.out()).toContain('Deleted team design.');
  });

  it('members lists every page of the team', async () => {
    const h = harness([
      { body: TEAM },
      { body: { members: [TEAM_MEMBER], nextCursor: 'm1' } },
      { body: { members: [{ ...TEAM_MEMBER, userId: 'u3', email: 'bo@x.co' }], nextCursor: null } }
    ]);
    expect(await run(['teams', 'members', TEAM_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      `/api/v1/teams/${TEAM_ID}`,
      `/api/v1/teams/${TEAM_ID}/members`,
      `/api/v1/teams/${TEAM_ID}/members?cursor=m1`
    ]);
    expect(h.out()).toContain('ada@x.co');
    expect(h.out()).toContain('bo@x.co');
  });

  it('add by email sends { email }', async () => {
    const h = harness([LIST, { status: 201, body: TEAM_MEMBER }]);
    expect(await run(['teams', 'add', 'design', 'ada@x.co', ...WIRED], h.io)).toBe(0);
    expect(h.calls[1]).toEqual({
      method: 'POST',
      path: `/api/v1/teams/${TEAM_ID}/members`,
      body: { email: 'ada@x.co' }
    });
    expect(h.out()).toBe('Added Ada <ada@x.co> to team design.\n');
  });

  it('add by user id sends { userId }', async () => {
    const h = harness([LIST, { status: 201, body: TEAM_MEMBER }]);
    expect(await run(['teams', 'add', 'design', 'u2', ...WIRED], h.io)).toBe(0);
    expect(h.calls[1]!.body).toEqual({ userId: 'u2' });
  });

  it('remove by email looks the person up among the team members', async () => {
    const h = harness([LIST, { body: { members: [TEAM_MEMBER], nextCursor: null } }, { body: TEAM_MEMBER }]);
    expect(await run(['teams', 'remove', 'design', 'ADA@x.co', ...WIRED], h.io)).toBe(0);
    expect(h.calls[2]).toEqual({
      method: 'DELETE',
      path: `/api/v1/teams/${TEAM_ID}/members/u2`,
      body: undefined
    });
    expect(h.out()).toContain('Removed Ada <ada@x.co> from team design.');
  });

  it('add --json prints the member payload byte-exactly', async () => {
    const raw = { ...TEAM_MEMBER, name: RAW_NAME };
    const h = harness([LIST, { status: 201, body: raw }]);
    expect(await run(['teams', 'add', 'design', 'u2', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(raw, null, 2)}\n`);
  });

  // ── the refusals ─────────────────────────────────────────────────────────

  it('403 forbidden reads as the owner-or-admin sentence', async () => {
    const h = harness([refusal(403, 'forbidden')]);
    expect(await run(['teams', 'create', 'Design', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('Only an owner or an admin manages teams.');
    expect(h.err()).not.toContain('terse wire message');
  });

  it('403 hub_managed names the account site and prints its url', async () => {
    const h = harness([refusal(403, 'hub_managed', { manageUrl: 'https://account.example/orgs/o1/teams' })]);
    expect(await run(['teams', 'create', 'Design', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain(
      'Teams of this workspace are managed on the Antasphere account site: https://account.example/orgs/o1/teams'
    );
  });

  it('409 slug_taken names the slug passed, or asks for --slug', async () => {
    const h = harness([refusal(409, 'slug_taken')]);
    expect(await run(['teams', 'create', 'Design', '--slug', 'design', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('A team of this workspace already uses the slug "design".');

    const h2 = harness([refusal(409, 'slug_taken')]);
    expect(await run(['teams', 'create', 'Design', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('already uses the slug this name makes; pass --slug.');
  });

  it('409 already_member names the person', async () => {
    const h = harness([LIST, refusal(409, 'already_member')]);
    expect(await run(['teams', 'add', 'design', 'ada@x.co', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('ada@x.co is already in this team.');
  });
});

describe(`${bin} projects members, a team as a member`, () => {
  it('add --team resolves the team and sends { teamId, role }', async () => {
    const h = harness([LIST, { status: 201, body: PROJECT_TEAM }]);
    const code = await run(
      ['projects', 'members', 'add', 'p-1', '--team', 'design', '--role', 'editor', ...WIRED],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls[1]).toEqual({
      method: 'POST',
      path: '/api/v1/projects/p-1/members',
      body: { teamId: TEAM_ID, role: 'editor' }
    });
    expect(h.out()).toContain('Added team Design (design) is an editor of this project for its 2 members');
  });

  it('add refuses both a person and --team, or neither, before any request', async () => {
    const h = harness();
    const both = ['projects', 'members', 'add', 'p-1', 'u2', '--team', 'design', '--role', 'editor'];
    expect(await run([...both, ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Name exactly one');

    const h2 = harness();
    expect(await run(['projects', 'members', 'add', 'p-1', '--role', 'editor', ...WIRED], h2.io)).toBe(1);
    expect(h2.calls).toEqual([]);
  });

  it('list prints both kinds', async () => {
    const person = {
      kind: 'person',
      userId: 'u2',
      email: 'ada@x.co',
      name: 'Ada',
      role: 'viewer',
      addedBy: 'u1',
      createdAt: '2026-09-03T10:00:00.000Z'
    };
    const h = harness([{ body: { members: [person, PROJECT_TEAM], nextCursor: null } }]);
    expect(await run(['projects', 'members', 'list', 'p-1', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toMatch(/person\s+u2\s+viewer\s+ada@x\.co\s+Ada/);
    expect(h.out()).toMatch(/team\s+design\s+editor\s+2 members\s+Design/);
  });

  it('role --team → PATCH /projects/:id/teams/:teamId', async () => {
    const h = harness([LIST, { body: { ...PROJECT_TEAM, role: 'manager' } }]);
    expect(
      await run(['projects', 'members', 'role', 'p-1', 'design', 'manager', '--team', ...WIRED], h.io)
    ).toBe(0);
    expect(h.calls[1]).toEqual({
      method: 'PATCH',
      path: `/api/v1/projects/p-1/teams/${TEAM_ID}`,
      body: { role: 'manager' }
    });
  });

  it('remove --team → DELETE /projects/:id/teams/:teamId', async () => {
    const h = harness([{ body: TEAM }, { body: PROJECT_TEAM }]);
    expect(await run(['projects', 'members', 'remove', 'p-1', TEAM_ID, '--team', ...WIRED], h.io)).toBe(0);
    expect(h.calls[1]).toEqual({
      method: 'DELETE',
      path: `/api/v1/projects/p-1/teams/${TEAM_ID}`,
      body: undefined
    });
    expect(h.out()).toContain('Its people keep their own entries.');
  });

  it('team_not_found on a project team route says the team is not on the project', async () => {
    const h = harness([{ body: TEAM }, refusal(404, 'team_not_found')]);
    expect(await run(['projects', 'members', 'remove', 'p-1', TEAM_ID, '--team', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('That team is not a member of this project.');
  });
});
