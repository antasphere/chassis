import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin, webhooksScope } = cli.identity;

/**
 * The connection commands (PRDCT-3773): the method, path and body each one
 * sends (recording fake fetch, as every file of this suite), the receiving
 * URL printed alone on stdout with its notes on stderr, the secret read from
 * stdin or a file and never printed, `--json` byte-exactness, the usage
 * errors that never reach the wire, the exit code of a failed test, and the
 * refusals read as sentences. The server side of each answer is the chassis
 * integration suite's; here the answers are canned.
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

function harness(responses: Canned[] = [{ status: 200, body: {} }], stdin?: string) {
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
    fetch,
    ...(stdin !== undefined ? { readStdin: () => Promise.resolve(stdin) } : {})
  };
  return { io, calls, out: () => out.join(''), err: () => err.join('') };
}

const WIRED = ['--url', 'http://x', '--api-key', 'k'];

const SECRET = 'whsec_c2VjcmV0LW9mLXRoZS1jb25uZWN0aW9ucw';
const RECEIVING_URL = 'http://x/hooks/meet/tok_receiving_url_of_the_suite';

const MEMBER = { id: 'u1', name: 'Ada Owner', email: 'ada@example.test' };

const MEET = {
  source: 'meet',
  name: 'Meet',
  kind: 'inbound',
  declared: {
    description: 'Calls and their transcripts',
    verifier: 'standard-webhooks',
    events: ['meeting.ended', 'transcript.ready'],
    secretHint: 'whsec_…',
    fields: [
      { key: 'calendar', label: 'Calendar', description: null, required: false, multiple: false },
      { key: 'rooms', label: 'Rooms', description: null, required: false, multiple: true }
    ],
    sibling: null
  },
  connected: true,
  receiving: { madeAt: '2026-10-01T10:00:00.000Z', madeBy: MEMBER },
  secretState: { set: true, readable: true, setAt: '2026-10-01T10:05:00.000Z', setBy: MEMBER },
  fields: { calendar: 'team', rooms: ['a', 'b'] },
  connectedAt: '2026-10-01T10:00:00.000Z',
  connectedBy: MEMBER,
  lastDelivery: { at: '2026-10-02T09:30:00.000Z', type: 'meeting.ended', outcome: 'processed' },
  check: { at: '2026-10-02T09:00:00.000Z', ok: true, detail: 'URL made, secret opens' },
  sibling: null
};

const FRESH = {
  ...MEET,
  connected: false,
  receiving: null,
  secretState: { set: false, readable: false, setAt: null, setBy: null },
  fields: {},
  connectedAt: null,
  connectedBy: null,
  lastDelivery: null,
  check: null
};

const LEMLIST = {
  ...FRESH,
  source: 'lemlist',
  name: 'Lemlist',
  kind: 'key',
  declared: { ...MEET.declared, verifier: null, events: [], fields: [] },
  connected: true,
  secretState: { set: true, readable: false, setAt: '2026-10-01T10:00:00.000Z', setBy: MEMBER },
  check: { at: '2026-10-02T09:00:00.000Z', ok: false, detail: 'the key was refused' }
};

/** A sibling tool of the same hub, connected as the person: an endpoint registered there. */
const TWIN = {
  ...MEET,
  source: 'twin',
  name: 'Twin',
  declared: {
    ...MEET.declared,
    description: 'A sibling tool of this hub',
    events: ['thing.created'],
    fields: [],
    sibling: { toolSlug: 'twin', events: ['thing.created'] }
  },
  fields: {},
  sibling: { endpointId: 'ep_twin_1' }
};

/** The same sibling before it is connected. */
const TWIN_FRESH = {
  ...FRESH,
  source: 'twin',
  name: 'Twin',
  declared: TWIN.declared,
  sibling: { endpointId: null }
};

const DELIVERY = {
  id: 'd1',
  source: 'meet',
  deliveryId: 'msg_1',
  type: 'meeting.ended',
  receivedAt: '2026-10-02T09:30:00.000Z',
  outcome: 'processed',
  detail: 'filed the call',
  error: null
};

const refusal = (status: number, code: string, message = 'terse wire message'): Canned => ({
  status,
  body: { error: { code, message } }
});

describe(`${bin} connections`, () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('list prints one line per source with its state; an empty list says so', async () => {
    const h = harness([{ body: { connections: [MEET, LEMLIST, FRESH] } }]);
    expect(await run(['connections', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/connections']);
    expect(h.out().split('\n')).toEqual([
      'Meet (meet) · connected · secret set · last delivery meeting.ended at 2026-10-02 09:30 · last check ok',
      'Lemlist (lemlist) · connected · secret UNREADABLE · last delivery none · last check failed: the key was refused',
      'Meet (meet) · not connected · secret missing · last delivery none · last check none',
      ''
    ]);

    const h2 = harness([{ body: { connections: [] } }]);
    expect(await run(['connections', 'list', ...WIRED], h2.io)).toBe(0);
    expect(h2.out()).toBe('No connection sources.\n');
  });

  it('list --json is the answer verbatim, its text unsanitized', async () => {
    const list = { connections: [{ ...MEET, name: 'Meet\u001b[2KHIDDEN' }] };
    const h = harness([{ body: list }]);
    expect(await run(['connections', 'list', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(list, null, 2)}\n`);
  });

  it('show reads the one source and prints its lines, somebody else’s text sanitized', async () => {
    const h = harness([
      { body: { ...MEET, fields: { calendar: 'team\u001b[2KHIDDEN', rooms: ['a', 'b'] } } }
    ]);
    expect(await run(['connections', 'show', 'meet', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/connections/meet']);
    const out = h.out();
    expect(out).toContain('Meet (meet) · inbound · connected');
    expect(out).toContain('Calls and their transcripts');
    expect(out).toContain('standard-webhooks');
    expect(out).toContain('meeting.ended, transcript.ready');
    expect(out).toContain('made 2026-10-01T10:00:00.000Z by Ada Owner <ada@example.test>');
    expect(out).toContain('Calendar: teamHIDDEN');
    expect(out).toContain('Rooms: a, b');
    expect(out).toContain('meeting.ended at 2026-10-02 09:30 (processed)');
    expect(out).toContain('ok at 2026-10-02 09:00: URL made, secret opens');
    expect(out).not.toContain('\u001b');

    const h2 = harness([{ body: FRESH }]);
    expect(await run(['connections', 'show', 'meet', ...WIRED], h2.io)).toBe(0);
    expect(h2.out()).toMatch(/url:\s+not made/);
    expect(h2.out()).toMatch(/secret:\s+missing/);
  });

  it('connect reads the source, then makes the URL and prints it alone on stdout, the notes on stderr', async () => {
    const h = harness([
      { body: FRESH },
      { body: { connection: { ...FRESH, receiving: MEET.receiving }, receivingUrl: RECEIVING_URL } }
    ]);
    expect(await run(['connections', 'connect', 'meet', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/meet', body: undefined },
      { method: 'POST', path: '/api/v1/connections/meet', body: undefined }
    ]);
    expect(h.out()).toBe(`${RECEIVING_URL}\n`);
    expect(h.err()).toContain('shown this once');
    expect(h.err()).toContain('fingerprint');
    expect(h.err()).toContain('Give it to Meet');
    expect(h.err()).toContain(`${bin} connections secret meet --stdin`);
    expect(h.err()).not.toContain(RECEIVING_URL);
  });

  it('connect --json prints the whole answer byte-exactly', async () => {
    const made = { connection: { ...FRESH, name: 'Meet\u001b[2KHIDDEN' }, receivingUrl: RECEIVING_URL };
    const h = harness([{ body: FRESH }, { body: made }]);
    expect(await run(['connections', 'connect', 'meet', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(made, null, 2)}\n`);
    expect(h.err()).toBe('');
  });

  it('connect without --rotate refuses when a URL exists, naming --rotate, and makes nothing', async () => {
    const h = harness([{ body: MEET }]);
    expect(await run(['connections', 'connect', 'meet', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/connections/meet', body: undefined }]);
    expect(h.err()).toContain('--rotate');
    expect(h.err()).toContain('the old URL stops working at once');
    expect(h.out()).toBe('');
  });

  it('connect --rotate makes a new URL over the existing one, and says the old one is dead', async () => {
    const h = harness([{ body: MEET }, { body: { connection: MEET, receivingUrl: RECEIVING_URL } }]);
    expect(await run(['connections', 'connect', 'meet', '--rotate', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/meet', body: undefined },
      { method: 'POST', path: '/api/v1/connections/meet', body: undefined }
    ]);
    expect(h.out()).toBe(`${RECEIVING_URL}\n`);
    expect(h.err()).toContain('The previous receiving URL no longer works.');
    expect(h.err()).toContain('The secret stays as it was.');
  });

  it('secret --stdin sends the first line of stdin in the body and never prints it', async () => {
    const h = harness([{ body: MEET }], `${SECRET}\nignored second line\n`);
    expect(await run(['connections', 'secret', 'meet', '--stdin', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'PUT', path: '/api/v1/connections/meet/secret', body: { secret: SECRET } }
    ]);
    expect(h.out()).toMatch(/^Secret set \(stored sealed, never shown again\)\.\nMeet \(meet\)/);
    expect(h.out()).not.toContain(SECRET);
    expect(h.err()).not.toContain(SECRET);
  });

  it('secret --secret-file sends the first line of the file and never prints it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chassis-cli-connections-'));
    const file = join(dir, 'secret');
    writeFileSync(file, `${SECRET}\n`);
    const h = harness([{ body: MEET }]);
    expect(await run(['connections', 'secret', 'meet', '--secret-file', file, ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ secret: SECRET });
    expect(h.out()).not.toContain(SECRET);
  });

  it('secret refuses both flags, neither, and a value as an argument, before any request', async () => {
    const both = harness([{ body: MEET }], SECRET);
    const argv = ['connections', 'secret', 'meet', '--stdin', '--secret-file', '/nowhere'];
    expect(await run([...argv, ...WIRED], both.io)).toBe(1);
    expect(both.err()).toContain('Name exactly one of --stdin or --secret-file <path>');

    const neither = harness([{ body: MEET }]);
    expect(await run(['connections', 'secret', 'meet', ...WIRED], neither.io)).toBe(1);
    expect(neither.err()).toContain('Name exactly one of --stdin or --secret-file <path>');

    const asArgument = harness([{ body: MEET }]);
    expect(await run(['connections', 'secret', 'meet', SECRET, ...WIRED], asArgument.io)).not.toBe(0);
    expect(asArgument.err()).toMatch(/too many arguments/);

    expect([...both.calls, ...neither.calls, ...asArgument.calls]).toEqual([]);
    expect(both.err() + neither.err()).not.toContain(SECRET);
  });

  it('fields builds a list from a repeated --set and null from --clear', async () => {
    const h = harness([{ body: MEET }]);
    const argv = [
      'connections',
      'fields',
      'meet',
      '--set',
      'rooms=a',
      '--set',
      'rooms=b',
      '--set',
      'calendar=team=one',
      '--clear',
      'owner'
    ];
    expect(await run([...argv, ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/v1/connections/meet',
        body: { fields: { rooms: ['a', 'b'], calendar: 'team=one', owner: null } }
      }
    ]);
    expect(h.out()).toContain('Fields stored.');
  });

  it('fields refuses a --set without =, and nothing to change, before any request', async () => {
    const h = harness();
    expect(await run(['connections', 'fields', 'meet', '--set', 'calendar', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('--set takes <key>=<value>');

    const h2 = harness();
    expect(await run(['connections', 'fields', 'meet', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('Nothing to change');
    expect([...h.calls, ...h2.calls]).toEqual([]);
  });

  it('test prints ok and exits 0; a failed test prints failed and exits 1', async () => {
    const h = harness([{ body: { ok: true, detail: 'URL made, secret opens', connection: MEET } }]);
    expect(await run(['connections', 'test', 'meet', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/connections/meet/test']);
    expect(h.out()).toBe('ok: URL made, secret opens\n');

    const failed = { ok: false, detail: 'the secret no longer opens', connection: MEET };
    const h2 = harness([{ body: failed }]);
    expect(await run(['connections', 'test', 'meet', ...WIRED], h2.io)).toBe(1);
    expect(h2.out()).toBe('failed: the secret no longer opens\n');
    expect(h2.err()).toContain('did not pass');

    const h3 = harness([{ body: failed }]);
    expect(await run(['connections', 'test', 'meet', '--json', ...WIRED], h3.io)).toBe(1);
    expect(h3.out()).toBe(`${JSON.stringify(failed, null, 2)}\n`);
  });

  it('disconnect refuses without --yes, saying what is lost; with it, reads the source and sends the DELETE', async () => {
    const h = harness();
    expect(await run(['connections', 'disconnect', 'meet', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('--yes');
    expect(h.err()).toContain('its secret, its receiving URL and its delivery log');
    expect(h.err()).toContain('its endpoint on the sibling too');

    const h2 = harness([{ body: MEET }, { body: FRESH }]);
    expect(await run(['connections', 'disconnect', 'meet', '--yes', ...WIRED], h2.io)).toBe(0);
    expect(h2.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/meet', body: undefined },
      { method: 'DELETE', path: '/api/v1/connections/meet', body: undefined }
    ]);
    expect(h2.out()).toContain('Disconnected Meet (meet)');

    // A source that is not a sibling ignores --local.
    const h3 = harness([{ body: MEET }, { body: FRESH }]);
    expect(await run(['connections', 'disconnect', 'meet', '--yes', '--local', ...WIRED], h3.io)).toBe(0);
    expect(h3.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/meet',
      'DELETE /api/v1/connections/meet'
    ]);
  });

  // ── a sibling tool of the same hub (PRDCT-3774) ──────────────────────────

  it('connect on a sibling connects it as the person: the sibling route, one sentence, no URL', async () => {
    const h = harness([{ body: TWIN_FRESH }, { body: TWIN }]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/twin', body: undefined },
      { method: 'POST', path: '/api/v1/connections/twin/sibling', body: undefined }
    ]);
    expect(h.out()).toBe(
      'Connected Twin as you: its endpoint is registered on Twin and the signing secret is stored here. Nothing to copy.\n'
    );
    expect(h.out() + h.err()).not.toMatch(/https?:\/\//);
    expect(h.err()).toBe('');
  });

  it('connect --rotate on a sibling re-runs the same route and says what is replaced', async () => {
    const h = harness([{ body: TWIN }, { body: { ...TWIN, sibling: { endpointId: 'ep_twin_2' } } }]);
    expect(await run(['connections', 'connect', 'twin', '--rotate', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/twin',
      'POST /api/v1/connections/twin/sibling'
    ]);
    expect(h.out()).toBe('Reconnected Twin as you: the previous endpoint, URL and secret are replaced.\n');

    // Without --rotate a connected sibling is re-run too: the re-run is the rotation.
    const h2 = harness([{ body: TWIN }, { body: TWIN }]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h2.io)).toBe(0);
    expect(h2.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/twin',
      'POST /api/v1/connections/twin/sibling'
    ]);
  });

  it('connect --json on a sibling prints the connection byte-exactly', async () => {
    const h = harness([{ body: TWIN_FRESH }, { body: TWIN }]);
    expect(await run(['connections', 'connect', 'twin', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(TWIN, null, 2)}\n`);
  });

  it('disconnect --yes on a sibling deletes the endpoint there through the sibling route', async () => {
    const h = harness([{ body: TWIN }, { body: TWIN_FRESH }]);
    expect(await run(['connections', 'disconnect', 'twin', '--yes', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/twin', body: undefined },
      { method: 'DELETE', path: '/api/v1/connections/twin/sibling', body: undefined }
    ]);
    expect(h.out()).toBe(
      'Disconnected Twin (twin): its endpoint on Twin is deleted, and its secret, URL and log here are gone.\n'
    );
  });

  it('disconnect --yes --local on a sibling drops the connection here only', async () => {
    const h = harness([{ body: TWIN }, { body: TWIN_FRESH }]);
    expect(await run(['connections', 'disconnect', 'twin', '--yes', '--local', ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/connections/twin', body: undefined },
      { method: 'DELETE', path: '/api/v1/connections/twin', body: undefined }
    ]);
    expect(h.out()).toContain(
      'Disconnected Twin (twin): its secret, its receiving URL and its delivery log are gone.'
    );
  });

  it('show prints the Sibling line: registered, or how to connect it as you', async () => {
    const h = harness([{ body: TWIN }]);
    expect(await run(['connections', 'show', 'twin', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toContain('Sibling: twin — endpoint registered\n');

    const h2 = harness([{ body: TWIN_FRESH }]);
    expect(await run(['connections', 'show', 'twin', ...WIRED], h2.io)).toBe(0);
    expect(h2.out()).toContain(
      'Sibling: twin — not registered yet (connections connect twin connects it as you)\n'
    );

    const h3 = harness([{ body: MEET }]);
    expect(await run(['connections', 'show', 'meet', ...WIRED], h3.io)).toBe(0);
    expect(h3.out()).not.toContain('Sibling');
  });

  it('deliveries reads one page with the limit and prints the columns and the next cursor', async () => {
    const failed = { ...DELIVERY, id: 'd2', outcome: 'failed', detail: null, error: 'no such call' };
    const h = harness([{ body: { deliveries: [DELIVERY, failed], nextCursor: 'c1' } }]);
    expect(await run(['connections', 'deliveries', 'meet', '--limit', '10', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/connections/meet/deliveries?limit=10']);
    expect(h.out()).toMatch(/^RECEIVED\s+TYPE\s+OUTCOME\s+DETAIL/);
    expect(h.out()).toMatch(/2026-10-02 09:30\s+meeting\.ended\s+processed\s+filed the call/);
    expect(h.out()).toMatch(/failed\s+error: no such call/);
    expect(h.out()).toContain('More: --cursor c1');
  });

  it('deliveries --all drains the pages', async () => {
    const second = { ...DELIVERY, id: 'd2', type: 'transcript.ready' };
    const h = harness([
      { body: { deliveries: [DELIVERY], nextCursor: 'c1' } },
      { body: { deliveries: [second], nextCursor: null } }
    ]);
    expect(await run(['connections', 'deliveries', 'meet', '--all', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/connections/meet/deliveries',
      '/api/v1/connections/meet/deliveries?cursor=c1'
    ]);
    expect(h.out()).toContain('meeting.ended');
    expect(h.out()).toContain('transcript.ready');
    expect(h.out()).not.toContain('More:');

    const h2 = harness([
      { body: { deliveries: [DELIVERY], nextCursor: 'c1' } },
      { body: { deliveries: [second], nextCursor: null } }
    ]);
    expect(await run(['connections', 'deliveries', 'meet', '--all', '--json', ...WIRED], h2.io)).toBe(0);
    expect(h2.out()).toBe(
      `${JSON.stringify({ deliveries: [DELIVERY, second], nextCursor: null }, null, 2)}\n`
    );
  });

  // ── the refusals ─────────────────────────────────────────────────────────

  it('not_found, not_inbound and not_connected read as sentences', async () => {
    const h = harness([refusal(404, 'not_found')]);
    expect(await run(['connections', 'show', 'nope', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('No such connection source on this instance (`connections list` names them).');
    expect(h.err()).not.toContain('terse wire message');

    const h2 = harness([{ body: { ...FRESH, kind: 'key' } }, refusal(409, 'not_inbound')]);
    expect(await run(['connections', 'connect', 'lemlist', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain(
      'This source holds a key and has no receiving URL: set its key with `connections secret`.'
    );

    const h3 = harness([refusal(409, 'not_connected')]);
    expect(await run(['connections', 'test', 'meet', ...WIRED], h3.io)).toBe(1);
    expect(h3.err()).toContain(
      'Nothing is connected yet for this source: `connections connect` makes the receiving URL, `connections secret` sets the key.'
    );
  });

  it('the sibling refusals: the server sentence, the oss sentence, the sign-in sentence, not_sibling', async () => {
    const scopeMissing =
      'Sign out and sign in again to this tool, so your grant carries the connect scope, then retry';
    const h = harness([{ body: TWIN_FRESH }, refusal(400, 'sibling_scope_missing', scopeMissing)]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain(scopeMissing);
    expect(h.out()).toBe('');

    // Off any hub the sibling connect is not available: the manual path takes over, the URL made here.
    const h2 = harness([
      { body: TWIN_FRESH },
      refusal(409, 'sibling_unavailable'),
      { body: { connection: TWIN_FRESH, receivingUrl: 'http://x/hooks/twin/tok_twin_by_hand' } }
    ]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h2.io)).toBe(0);
    expect(h2.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/twin',
      'POST /api/v1/connections/twin/sibling',
      'POST /api/v1/connections/twin'
    ]);
    expect(h2.out()).toBe('http://x/hooks/twin/tok_twin_by_hand\n');
    expect(h2.err()).toContain('This instance is not on a hub, so Twin is connected by hand');
    expect(h2.err()).toContain('shown this once');

    // The same for the disconnect: nothing on the sibling, the local half dropped.
    const h2b = harness([{ body: TWIN }, refusal(409, 'sibling_unavailable'), { body: TWIN_FRESH }]);
    expect(await run(['connections', 'disconnect', 'twin', '--yes', ...WIRED], h2b.io)).toBe(0);
    expect(h2b.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/twin',
      'DELETE /api/v1/connections/twin/sibling',
      'DELETE /api/v1/connections/twin'
    ]);
    expect(h2b.out()).toContain('its secret, its receiving URL and its delivery log are gone.');

    const h3 = harness([{ body: TWIN }, refusal(401, 'hub_reauth_required')]);
    expect(await run(['connections', 'disconnect', 'twin', '--yes', ...WIRED], h3.io)).toBe(1);
    expect(h3.err()).toContain(`Sign in again (\`${bin} login\`), then retry.`);

    const h4 = harness([{ body: TWIN_FRESH }, refusal(409, 'not_sibling')]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h4.io)).toBe(1);
    expect(h4.err()).toContain('This source is not a sibling tool of this hub');

    // Another connect of the source is running: the server's sentence, and no manual fallback (that is for an instance off any hub).
    const busy = 'Another connect of this source is running: wait for it, then retry';
    const h5 = harness([{ body: TWIN_FRESH }, refusal(409, 'sibling_busy', busy)]);
    expect(await run(['connections', 'connect', 'twin', ...WIRED], h5.io)).toBe(1);
    expect(h5.err()).toContain(busy);
    expect(h5.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/connections/twin',
      'POST /api/v1/connections/twin/sibling'
    ]);
  });

  it('forbidden and guest_forbidden read as sentences', async () => {
    const h = harness([refusal(403, 'forbidden')]);
    expect(await run(['connections', 'disconnect', 'meet', '--yes', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('Only an owner or an admin changes connections.');

    const h2 = harness([refusal(403, 'guest_forbidden')]);
    expect(await run(['connections', 'list', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('guests do not manage its connections');
  });

  it('secret_refused keeps the server message; a write without the scope reads the scope sentence', async () => {
    const h = harness(
      [refusal(400, 'secret_refused', 'The source refused the key: 401 Unauthorized')],
      SECRET
    );
    expect(await run(['connections', 'secret', 'lemlist', '--stdin', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('The source refused the key: 401 Unauthorized');

    const expected = webhooksScope
      ? `This key cannot change connections: create one with the ${webhooksScope} scope on the API keys page.`
      : 'This instance opens no connection write to a key.';
    const h2 = harness([refusal(403, 'insufficient_scope')]);
    expect(await run(['connections', 'test', 'meet', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain(expected);

    // A read keeps the server's sentence: it names the read scope.
    const h3 = harness([refusal(403, 'insufficient_scope', 'This credential was not granted "x:read"')]);
    expect(await run(['connections', 'list', ...WIRED], h3.io)).toBe(1);
    expect(h3.err()).toContain('This credential was not granted "x:read"');
  });
});
