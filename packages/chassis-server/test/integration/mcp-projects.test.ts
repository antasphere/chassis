import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  SETUP_TOKEN,
  host
} from './helpers.js';

/**
 * The nine PROJECT tools the chassis registers beside `<toolPrefix>whoami`,
 * driven as a real MCP client would: raw JSON-RPC POSTs against the stateless
 * /mcp (Phase 7's harness), authenticated with the host's own API keys.
 *
 * A manager runs the whole life of a project through the tools alone —
 * create, list, read, update, add a member by email, raise their role, remove
 * them, archive, bring it back — and the two refusals that matter read as
 * SENTENCES rather than as codes: a viewer told which role the act needs, a
 * non-member told the project is not visible to them.
 *
 * Nothing here spells a tool's prefix or scope names: both come from `host`,
 * because this file runs twice (this package's minimal host, and the tool's
 * app over its real composition).
 */
const PASSWORD = 'a-long-mcp-projects-password-1';
const OWNER = { email: 'owner@mcp-projects.test', name: 'Poppy Owner', password: PASSWORD };

const PREFIX = host.identity.mcp.toolPrefix;
const TOOL = {
  list: `${PREFIX}list_projects`,
  get: `${PREFIX}get_project`,
  create: `${PREFIX}create_project`,
  update: `${PREFIX}update_project`,
  archive: `${PREFIX}archive_project`,
  listMembers: `${PREFIX}list_project_members`,
  addMember: `${PREFIX}add_project_member`,
  setRole: `${PREFIX}set_project_member_role`,
  removeMember: `${PREFIX}remove_project_member`
};

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
/** The manager's key drives the life of the project; the other two prove the refusals. */
let managerKey = '';
let viewerKey = '';
let outsiderKey = '';
let viewerUserId = '';
const viewerEmail = 'viewer@mcp-projects.test';

let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let rpcId = 0;

/** JSON-RPC result over the stateless /mcp (throws on protocol-level errors). */
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

/** Parse a tool's JSON text block; an error text is not JSON → null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMaybe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Call one tool; `data` is the parsed JSON text block (an error text is not JSON). */
async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(key, 'tools/call', { name, arguments: args });
  const text: string = result.content?.[0]?.text ?? '';
  return { isError: result.isError === true, text, data: parseMaybe(text) };
}

/**
 * A refusal must READ as a sentence, not stop at a code: `wrapToolErrors`
 * appends ` — Next: <hint>` from the instance's hint table, and the chassis
 * puts one there for every project code (`PROJECT_ERROR_HINTS`). The WORDS are
 * the host's — a tool that words a code for its own domain overrides the
 * chassis (`buildMcpServer`) — so what is pinned here is the shape: a hint
 * exists, it is prose of some length, and it names `expected`.
 */
function expectSentence(text: string, expected: RegExp): void {
  const hint = text.split(' — Next: ')[1];
  expect(hint, `no "Next:" sentence in: ${text}`).toBeTruthy();
  expect(hint!.length, `the hint is not a sentence: ${hint}`).toBeGreaterThan(20);
  expect(hint, `the hint does not name ${expected}: ${hint}`).toMatch(expected);
}

/** The tool call must have succeeded — the text is shown when it did not. */
async function ok(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await callTool(key, name, args);
  expect(res.isError, `${name}: ${res.text}`).toBe(false);
  return res.data;
}

async function mintKey(cookie: string, name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie }));
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

async function signIn(email: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password: PASSWORD }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** A plain workspace member with a read+write key of their own. */
async function addMember(name: string, email: string): Promise<{ userId: string; key: string }> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: created.user.id, role: 'member', origin: 'local' });
  const key = await mintKey(await signIn(email), `${name}-rw`, [host.scopes.read, host.scopes.write]);
  return { userId: created.user.id, key };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'mcp_projects'));

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: SETUP_TOKEN, instanceName: 'MCP Projects', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  const ownerCookie = await signIn(OWNER.email);
  // The owner acts as a manager on every project: they are the "manager" here.
  managerKey = await mintKey(ownerCookie, 'manager-rw', [host.scopes.read, host.scopes.write]);
  workspaceId = (await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } })))
    .workspace.id;

  const viewer = await addMember('Vera Viewer', viewerEmail);
  viewerUserId = viewer.userId;
  viewerKey = viewer.key;
  outsiderKey = (await addMember('Otto Outsider', 'outsider@mcp-projects.test')).key;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the nine project tools are served under the host prefix', () => {
  it('tools/list carries all nine, with the read ones flagged read-only', async () => {
    interface ToolInfo {
      name: string;
      description: string;
      inputSchema?: { properties?: Record<string, unknown> };
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }
    const tools = (await rpc(managerKey, 'tools/list')).tools as ToolInfo[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of Object.values(TOOL)) {
      expect(byName.has(name), `missing tool ${name}`).toBe(true);
      // Org as a parameter: every tool of the set takes the workspace argument.
      expect(byName.get(name)!.inputSchema?.properties?.workspace, `${name} lacks workspace`).toBeDefined();
    }
    for (const name of [TOOL.list, TOOL.get, TOOL.listMembers]) {
      expect(byName.get(name)!.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
    }
    for (const name of [TOOL.archive, TOOL.removeMember]) {
      expect(byName.get(name)!.annotations?.destructiveHint, `${name} destructiveHint`).toBe(true);
    }
    // The writes describe themselves confirm-first, and the set explains what a
    // project IS to an agent that has never seen one.
    for (const name of [
      TOOL.create,
      TOOL.update,
      TOOL.archive,
      TOOL.addMember,
      TOOL.setRole,
      TOOL.removeMember
    ]) {
      expect(byName.get(name)!.description, `${name} confirm-first`).toContain('confirm with the user');
    }
    expect(byName.get(TOOL.list)!.description).toContain('subgroup of an organization');
    expect(byName.get(TOOL.get)!.description).toContain('viewer');
    expect(byName.get(TOOL.get)!.description).toContain('manager');
  });
});

describe('a manager runs the life of a project through the tools', () => {
  let projectId = '';

  it('creates one, and the creator is its manager', async () => {
    const created = await ok(managerKey, TOOL.create, {
      name: 'Atlas',
      description: 'The map work',
      metadata: { tier: 'gold' }
    });
    expect(created.name).toBe('Atlas');
    expect(created.description).toBe('The map work');
    expect(created.metadata).toEqual({ tier: 'gold' });
    expect(created.myRole).toBe('manager');
    expect(created.archivedAt).toBeNull();
    expect(created.memberCount).toBe(1);
    projectId = created.id;
  });

  it('lists it, and reads it back with the caller’s own role', async () => {
    const list = await ok(managerKey, TOOL.list);
    expect(list.projects.map((p: { id: string }) => p.id)).toContain(projectId);
    expect(list).toHaveProperty('nextCursor');

    const one = await ok(managerKey, TOOL.get, { projectId });
    expect(one.id).toBe(projectId);
    expect(one.myRole).toBe('manager');
  });

  it('updates the name and replaces the metadata object', async () => {
    const updated = await ok(managerKey, TOOL.update, {
      projectId,
      name: 'Atlas II',
      metadata: { tier: 'platinum' }
    });
    expect(updated.name).toBe('Atlas II');
    expect(updated.metadata).toEqual({ tier: 'platinum' });
    // Untouched fields stay as they were.
    expect(updated.description).toBe('The map work');
  });

  it('refuses an update that changes nothing, before any API call', async () => {
    const res = await callTool(managerKey, TOOL.update, { projectId });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('at least one of name, description or metadata');
  });

  it('adds a member by email, and the member list shows their role', async () => {
    const added = await ok(managerKey, TOOL.addMember, {
      projectId,
      email: viewerEmail,
      role: 'viewer'
    });
    expect(added.userId).toBe(viewerUserId);
    expect(added.role).toBe('viewer');

    const members = await ok(managerKey, TOOL.listMembers, { projectId });
    const roles = new Map(members.members.map((m: { userId: string; role: string }) => [m.userId, m.role]));
    expect(roles.get(viewerUserId)).toBe('viewer');
    expect(members).toHaveProperty('nextCursor');
  });

  it('refuses a member named both ways, or neither, before any API call', async () => {
    for (const args of [
      { projectId, role: 'viewer' },
      { projectId, role: 'viewer', userId: viewerUserId, email: viewerEmail }
    ]) {
      const res = await callTool(managerKey, TOOL.addMember, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain('exactly one way');
    }
  });

  it('raises the member to editor, then removes them from the project', async () => {
    const raised = await ok(managerKey, TOOL.setRole, {
      projectId,
      userId: viewerUserId,
      role: 'editor'
    });
    expect(raised.role).toBe('editor');

    const removed = await ok(managerKey, TOOL.removeMember, { projectId, userId: viewerUserId });
    expect(removed.userId).toBe(viewerUserId);
    const after = await ok(managerKey, TOOL.listMembers, { projectId });
    expect(after.members.map((m: { userId: string }) => m.userId)).not.toContain(viewerUserId);
  });

  it('archives it: out of the default list, and read-only in plain words', async () => {
    const archived = await ok(managerKey, TOOL.archive, { projectId });
    expect(archived.archivedAt).not.toBeNull();

    const live = await ok(managerKey, TOOL.list);
    expect(live.projects.map((p: { id: string }) => p.id)).not.toContain(projectId);
    const all = await ok(managerKey, TOOL.list, { archived: 'true' });
    expect(all.projects.map((p: { id: string }) => p.id)).toContain(projectId);

    const refused = await callTool(managerKey, TOOL.update, { projectId, name: 'Atlas III' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('project_archived');
    // The code is followed by a SENTENCE, not left as a code: a hint saying
    // what to do about it. The chassis words every project code
    // (`PROJECT_ERROR_HINTS`), and a host that words one for its own domain
    // wins — so the words are the host's and only the shape is pinned here.
    expectSentence(refused.text, /unarchiv|archived/i);
  });

  it('brings it back with the same tool, and it is writable again', async () => {
    const back = await ok(managerKey, TOOL.archive, { projectId, archived: false });
    expect(back.archivedAt).toBeNull();
    const renamed = await ok(managerKey, TOOL.update, { projectId, name: 'Atlas III' });
    expect(renamed.name).toBe('Atlas III');
  });
});

describe('the refusals read as sentences', () => {
  let projectId = '';

  beforeAll(async () => {
    projectId = (await ok(managerKey, TOOL.create, { name: 'Bastion' })).id;
    await ok(managerKey, TOOL.addMember, { projectId, email: viewerEmail, role: 'viewer' });
  });

  it('a viewer reads the project but is told which role the change needs', async () => {
    const read = await ok(viewerKey, TOOL.get, { projectId });
    expect(read.myRole).toBe('viewer');

    const refused = await callTool(viewerKey, TOOL.update, { projectId, name: 'Bastion II' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('insufficient_project_role');
    // Words, not a bare code — and the role the act needs is named.
    expectSentence(refused.text, /manager/i);
  });

  it('a viewer may not manage the members either', async () => {
    const refused = await callTool(viewerKey, TOOL.addMember, {
      projectId,
      email: OWNER.email,
      role: 'editor'
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('insufficient_project_role');
    expectSentence(refused.text, /manager/i);
  });

  it('a non-member is told not found, never that the project exists', async () => {
    const refused = await callTool(outsiderKey, TOOL.get, { projectId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('HTTP 404');
    expect(refused.text).toContain('not_found');
    // Never the shape of a permission refusal: existence is not probeable. The
    // 404's own WORDS are the host's (`not_found` is the whole instance's code,
    // which a tool words for its domain), so only the tier is pinned here.
    expect(refused.text).not.toContain('403');
    expect(refused.text).not.toContain('insufficient_project_role');

    const mine = await ok(outsiderKey, TOOL.list);
    expect(mine.projects.map((p: { id: string }) => p.id)).not.toContain(projectId);
  });

  it('a key without the write scope is told so before the API is reached', async () => {
    const readOnly = await mintKey(await signIn(OWNER.email), 'manager-ro', [host.scopes.read]);
    const refused = await callTool(readOnly, TOOL.create, { name: 'Never' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Missing scope "${host.scopes.write}"`);
    // The read half of the set still works on the same key.
    expect((await ok(readOnly, TOOL.list)).projects).toBeInstanceOf(Array);
  });
});
