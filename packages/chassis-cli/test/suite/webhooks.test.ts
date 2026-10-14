import { describe, expect, it } from 'vitest';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli, run } from '@chassis-cli-test/host';

// The literals that spell the tool come from the host (its identity).
const { bin, displayName, webhooksScope } = cli.identity;

/**
 * The webhook commands (PRDCT-3482): the method, path and body each one
 * sends (recording fake fetch, as every file of this suite), the secret
 * printed once on its own line, `--json` byte-exactness, the usage errors
 * that never reach the wire, the exit code of a ping that was not delivered,
 * and the refusals read as sentences. The server side of each answer
 * (delivery to a loopback receiver included) is the chassis integration
 * suite's `webhooks.test.ts`; here the answers are canned.
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

const HOOK_ID = '11111111-1111-4111-8111-111111111111';
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'whsec_c2VjcmV0LW9mLXRoZS1zdWl0ZQ';

const ENDPOINT = {
  id: HOOK_ID,
  url: 'https://receiver.example/hooks',
  description: 'The audit mirror',
  events: ['thing.created', 'thing.deleted'],
  filters: {},
  enabled: true,
  createdBy: 'u1',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  disabledAt: null,
  disabledReason: null,
  consecutiveFailures: 0,
  lastDeliveryAt: '2026-10-02T09:30:00.000Z',
  lastDeliveryStatus: 'delivered',
  previousSecretExpiresAt: null
};

const DELIVERY = {
  id: DELIVERY_ID,
  endpointId: HOOK_ID,
  eventId: 'evt_1',
  eventType: 'webhook.ping',
  status: 'delivered',
  attempt: 1,
  lastStatusCode: 200,
  lastError: null,
  nextAttemptAt: null,
  deliveredAt: '2026-10-02T09:30:01.000Z',
  createdAt: '2026-10-02T09:30:00.000Z',
  updatedAt: '2026-10-02T09:30:01.000Z',
  payload: { type: 'webhook.ping', data: {} }
};

const CATALOG = {
  subjects: [{ key: 'thing', field: 'thingId', description: 'A thing of the workspace, by id' }],
  events: [
    { type: 'webhook.ping', description: 'A test delivery.', subjects: [], schema: { type: 'object' } },
    {
      type: 'thing.created',
      description: 'A thing was created.',
      subjects: ['thing'],
      schema: { type: 'object' }
    }
  ]
};

const refusal = (
  status: number,
  code: string,
  message = 'terse wire message',
  details?: unknown
): Canned => ({
  status,
  body: { error: { code, message, ...(details ? { details } : {}) } }
});

describe(`${bin} webhooks`, () => {
  it('list says so when there is nothing', async () => {
    const h = harness([{ body: { webhooks: [], nextCursor: null } }]);
    expect(await run(['webhooks', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/webhooks']);
    expect(h.out()).toBe('No webhooks.\n');
  });

  it('list reads every page and prints the columns', async () => {
    const second = { ...ENDPOINT, id: 'w2', enabled: false, lastDeliveryAt: null, lastDeliveryStatus: null };
    const h = harness([
      { body: { webhooks: [ENDPOINT], nextCursor: 'c1' } },
      { body: { webhooks: [second], nextCursor: null } }
    ]);
    expect(await run(['webhooks', 'list', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/webhooks', '/api/v1/webhooks?cursor=c1']);
    const lines = h.out().split('\n');
    expect(lines[0]).toMatch(/^ID\s+URL\s+EVENTS\s+ENABLED\s+LAST DELIVERY\s+FAILURES$/);
    expect(h.out()).toMatch(
      /11111111-\S+\s+https:\/\/receiver\.example\/hooks\s+thing\.created,thing\.deleted\s+yes\s+delivered 2026-10-02 09:30\s+0/
    );
    expect(h.out()).toMatch(/w2\s+\S+\s+\S+\s+no\s+-\s+0/);
  });

  it('create sends the URL, the events, the description, the filters (OR on a subject) and the switch', async () => {
    const h = harness([{ status: 201, body: { ...ENDPOINT, secret: SECRET } }]);
    const code = await run(
      [
        'webhooks',
        'create',
        'https://receiver.example/hooks',
        '--event',
        'thing.created',
        '--event',
        'thing.*',
        '--description',
        'The audit mirror',
        '--filter',
        'thing=a1',
        '--filter',
        'thing=a2',
        '--filter',
        'project=p1',
        '--disabled',
        ...WIRED
      ],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/webhooks',
        body: {
          url: 'https://receiver.example/hooks',
          events: ['thing.created', 'thing.*'],
          description: 'The audit mirror',
          filters: { thing: ['a1', 'a2'], project: ['p1'] },
          enabled: false
        }
      }
    ]);
  });

  it('create prints the id, then the secret alone on its line, said to be shown once', async () => {
    const h = harness([{ status: 201, body: { ...ENDPOINT, secret: SECRET } }]);
    const argv = ['webhooks', 'create', 'https://receiver.example/hooks', '--event', 'thing.created'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ url: 'https://receiver.example/hooks', events: ['thing.created'] });
    const lines = h.out().split('\n');
    expect(lines[0]).toContain(HOOK_ID);
    expect(h.out()).toContain('shown this once');
    expect(lines).toContain(SECRET);
    expect(h.out().indexOf(HOOK_ID)).toBeLessThan(h.out().indexOf(SECRET));
  });

  it('create --json prints the payload byte-exactly, the secret included', async () => {
    const created = { ...ENDPOINT, description: 'Mirror\u001b[2KHIDDEN', secret: SECRET };
    const h = harness([{ status: 201, body: created }]);
    const argv = ['webhooks', 'create', 'https://receiver.example/hooks', '--event', 'thing.created'];
    expect(await run([...argv, '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(created, null, 2)}\n`);
  });

  it('create without --event is a usage error that never reaches the wire', async () => {
    const h = harness();
    expect(await run(['webhooks', 'create', 'https://receiver.example/hooks', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Name at least one event');
  });

  it('create refuses a --filter that is not <subject>=<id> before any request', async () => {
    const h = harness();
    const argv = ['webhooks', 'create', 'https://r.example', '--event', 'thing.created', '--filter', 'thing'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('--filter takes <subject>=<id>');
  });

  it('events prints the catalog, webhook.ping among the types, and the subjects', async () => {
    const h = harness([{ body: CATALOG }]);
    expect(await run(['webhooks', 'events', ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/webhooks/events']);
    expect(h.out()).toMatch(/^TYPE\s+SUBJECTS\s+DESCRIPTION/);
    expect(h.out()).toMatch(/webhook\.ping\s+-\s+A test delivery\./);
    expect(h.out()).toMatch(/thing\.created\s+thing\s+A thing was created\./);
    expect(h.out()).toMatch(/thing\s+subjects\.thingId\s+A thing of the workspace, by id/);
  });

  it('events --json is the catalog verbatim', async () => {
    const h = harness([{ body: CATALOG }]);
    expect(await run(['webhooks', 'events', '--json', ...WIRED], h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(CATALOG, null, 2)}\n`);
  });

  it('get reads the endpoint and shows it, its text sanitized', async () => {
    const h = harness([{ body: { ...ENDPOINT, description: 'Mirror\u001b[2KHIDDEN' } }]);
    expect(await run(['webhooks', 'get', HOOK_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/webhooks/${HOOK_ID}`]);
    expect(h.out()).toContain('https://receiver.example/hooks');
    expect(h.out()).toContain('thing.created, thing.deleted');
    expect(h.out()).not.toContain('\u001b');
    expect(h.out()).toContain('MirrorHIDDEN');
  });

  it('update sends only what was passed', async () => {
    const h = harness([{ body: { ...ENDPOINT, events: ['thing.deleted'], enabled: false } }]);
    const code = await run(
      ['webhooks', 'update', HOOK_ID, '--event', 'thing.deleted', '--disable', ...WIRED],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'PATCH',
        path: `/api/v1/webhooks/${HOOK_ID}`,
        body: { events: ['thing.deleted'], enabled: false }
      }
    ]);
    expect(h.out()).toContain(`Updated webhook ${HOOK_ID}.`);
  });

  it('update --endpoint-url and --clear-filters send the url and an empty filter set', async () => {
    const h = harness([{ body: ENDPOINT }]);
    const argv = ['webhooks', 'update', HOOK_ID, '--endpoint-url', 'https://r2.example', '--clear-filters'];
    expect(await run([...argv, '--enable', ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ url: 'https://r2.example', filters: {}, enabled: true });
  });

  it('update with nothing to change, or --enable with --disable, never reaches the wire', async () => {
    const h = harness();
    expect(await run(['webhooks', 'update', HOOK_ID, ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('Nothing to change');

    const h2 = harness();
    expect(await run(['webhooks', 'update', HOOK_ID, '--enable', '--disable', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('--enable or --disable, not both');

    const h3 = harness();
    const both = ['webhooks', 'update', HOOK_ID, '--filter', 'thing=a1', '--clear-filters'];
    expect(await run([...both, ...WIRED], h3.io)).toBe(1);
    expect([...h.calls, ...h2.calls, ...h3.calls]).toEqual([]);
  });

  it('deliveries reads one page with the status and the limit, and says when it is empty', async () => {
    const h = harness([{ body: { deliveries: [], nextCursor: null } }]);
    const argv = ['webhooks', 'deliveries', HOOK_ID, '--status', 'failed', '--limit', '10'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      `/api/v1/webhooks/${HOOK_ID}/deliveries?limit=10&status=failed`
    ]);
    expect(h.out()).toBe('No deliveries.\n');
  });

  it('deliveries prints the columns and the next cursor; --json is the page verbatim', async () => {
    const page = { deliveries: [DELIVERY], nextCursor: 'd1' };
    const h = harness([{ body: page }]);
    expect(await run(['webhooks', 'deliveries', HOOK_ID, ...WIRED], h.io)).toBe(0);
    expect(h.out()).toMatch(/^ID\s+EVENT\s+STATUS\s+ATTEMPT\s+CODE\s+CREATED/);
    expect(h.out()).toMatch(/22222222-\S+\s+webhook\.ping\s+delivered\s+1\s+200\s+2026-10-02 09:30/);
    expect(h.out()).toContain('More: --cursor d1');

    const h2 = harness([{ body: page }]);
    expect(await run(['webhooks', 'deliveries', HOOK_ID, '--cursor', 'd1', '--json', ...WIRED], h2.io)).toBe(
      0
    );
    expect(h2.calls[0]!.path).toBe(`/api/v1/webhooks/${HOOK_ID}/deliveries?cursor=d1`);
    expect(h2.out()).toBe(`${JSON.stringify(page, null, 2)}\n`);
  });

  it('deliveries refuses an unknown --status before any request', async () => {
    const h = harness();
    expect(await run(['webhooks', 'deliveries', HOOK_ID, '--status', 'lost', ...WIRED], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('--status takes one of pending, delivered, failed, held');
  });

  it('test prints the delivered ping and exits 0', async () => {
    const h = harness([{ body: { delivery: DELIVERY } }]);
    expect(await run(['webhooks', 'test', HOOK_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /api/v1/webhooks/${HOOK_ID}/test`]);
    expect(h.out()).toContain('Ping delivered, HTTP 200');
  });

  it('test prints a failed ping, its code and its error, and exits 1', async () => {
    const failed = {
      ...DELIVERY,
      status: 'failed',
      lastStatusCode: 500,
      lastError: 'HTTP 500',
      deliveredAt: null
    };
    const h = harness([{ body: { delivery: failed } }]);
    expect(await run(['webhooks', 'test', HOOK_ID, ...WIRED], h.io)).toBe(1);
    expect(h.out()).toContain('Ping failed, HTTP 500: HTTP 500');
    expect(h.err()).toContain('The ping was not delivered (failed).');

    const h2 = harness([{ body: { delivery: failed } }]);
    expect(await run(['webhooks', 'test', HOOK_ID, '--json', ...WIRED], h2.io)).toBe(1);
    expect(h2.out()).toBe(`${JSON.stringify({ delivery: failed }, null, 2)}\n`);
  });

  it('rotate-secret prints the new secret once and the date the previous one stops signing', async () => {
    const rotated = { ...ENDPOINT, secret: SECRET, previousSecretExpiresAt: '2026-10-03T10:00:00.000Z' };
    const h = harness([{ body: rotated }]);
    expect(await run(['webhooks', 'rotate-secret', HOOK_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /api/v1/webhooks/${HOOK_ID}/rotate-secret`
    ]);
    expect(h.out().split('\n')).toContain(SECRET);
    expect(h.out()).toContain('shown this once');
    expect(h.out()).toContain('The previous secret keeps signing until 2026-10-03T10:00:00.000Z.');

    const h2 = harness([{ body: rotated }]);
    expect(await run(['webhooks', 'rotate-secret', HOOK_ID, '--json', ...WIRED], h2.io)).toBe(0);
    expect(h2.out()).toBe(`${JSON.stringify(rotated, null, 2)}\n`);
  });

  it('delete deletes; a get after it reads the not-found sentence and exits 1', async () => {
    const h = harness([{ body: ENDPOINT }]);
    expect(await run(['webhooks', 'delete', HOOK_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'DELETE', path: `/api/v1/webhooks/${HOOK_ID}`, body: undefined }]);
    expect(h.out()).toContain(`Deleted webhook ${HOOK_ID}`);

    const h2 = harness([refusal(404, 'not_found', 'Webhook not found')]);
    expect(await run(['webhooks', 'get', HOOK_ID, ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('No such webhook in this workspace.');
  });

  it('delivery and redeliver hit the delivery paths; an unknown delivery reads as such', async () => {
    const h = harness([{ body: DELIVERY }]);
    expect(await run(['webhooks', 'delivery', HOOK_ID, DELIVERY_ID, ...WIRED], h.io)).toBe(0);
    expect(h.calls[0]!.path).toBe(`/api/v1/webhooks/${HOOK_ID}/deliveries/${DELIVERY_ID}`);
    expect(h.out()).toContain('status:    delivered');

    const h2 = harness([{ status: 201, body: { ...DELIVERY, id: 'd-new', status: 'pending' } }]);
    expect(await run(['webhooks', 'redeliver', HOOK_ID, DELIVERY_ID, ...WIRED], h2.io)).toBe(0);
    expect(h2.calls[0]).toEqual({
      method: 'POST',
      path: `/api/v1/webhooks/${HOOK_ID}/deliveries/${DELIVERY_ID}/redeliver`,
      body: undefined
    });
    expect(h2.out()).toContain('Queued delivery d-new of webhook.ping (event evt_1).');

    const h3 = harness([refusal(404, 'not_found', 'Delivery not found')]);
    expect(await run(['webhooks', 'redeliver', HOOK_ID, DELIVERY_ID, ...WIRED], h3.io)).toBe(1);
    expect(h3.err()).toContain('No such delivery.');
  });

  // ── the refusals ─────────────────────────────────────────────────────────

  it('a key without the webhooks scope reads the scope sentence', async () => {
    const expected = webhooksScope
      ? `This key cannot manage webhooks: create one with the ${webhooksScope} scope on the API keys page.`
      : `${displayName} opens webhooks to no API key`;
    const h = harness([refusal(403, 'insufficient_scope')]);
    expect(await run(['webhooks', 'list', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain(expected);
    expect(h.err()).not.toContain('terse wire message');

    const h2 = harness([refusal(403, 'endpoint_not_allowed')]);
    expect(await run(['webhooks', 'test', HOOK_ID, ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain(expected);
  });

  it('the catalog keeps the server sentence for a key without the read scope', async () => {
    const h = harness([refusal(403, 'insufficient_scope', 'This credential was not granted "x:read"')]);
    expect(await run(['webhooks', 'events', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('This credential was not granted "x:read"');
  });

  it('403 forbidden and guest_forbidden read as sentences', async () => {
    const h = harness([refusal(403, 'forbidden')]);
    expect(await run(['webhooks', 'list', ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('Only an owner or an admin manages webhooks.');

    const h2 = harness([refusal(403, 'guest_forbidden')]);
    expect(await run(['webhooks', 'list', ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('guests do not manage its webhooks');
  });

  it('url_refused and demo_session keep the server message verbatim', async () => {
    const h = harness([refusal(400, 'url_refused', 'This address is on a private network')]);
    const argv = ['webhooks', 'create', 'http://10.0.0.1/hook', '--event', 'thing.created'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain('Error: This address is on a private network');

    const h2 = harness([refusal(403, 'demo_session', 'A demonstration session cannot do this')]);
    expect(await run(['webhooks', 'rotate-secret', HOOK_ID, ...WIRED], h2.io)).toBe(1);
    expect(h2.err()).toContain('A demonstration session cannot do this');
  });

  it('unknown_event points at `webhooks events` and the family form; unknown_subject at the subject keys (N-R2-1)', async () => {
    const h = harness([refusal(400, 'unknown_event', 'Unknown event type or family: nothing.*')]);
    const argv = ['webhooks', 'create', 'https://r.example', '--event', 'nothing.*'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.err()).toContain('Unknown event type or family: nothing.*');
    expect(h.err()).toContain('The exact types are in `webhooks events`');
    expect(h.err()).toContain('a family is its first word plus `.*`');

    const h2 = harness([refusal(400, 'unknown_subject', 'Unknown filter subject: bogus')]);
    const argv2 = [
      'webhooks',
      'create',
      'https://r.example',
      '--event',
      'thing.created',
      '--filter',
      'bogus=x'
    ];
    expect(await run([...argv2, ...WIRED], h2.io)).toBe(1);
    expect(h2.calls).toHaveLength(1);
    expect(h2.err()).toContain('Unknown filter subject: bogus');
    expect(h2.err()).toContain('The subject keys are in `webhooks events`');
  });

  it('plan_required carries the upgrade link', async () => {
    const h = harness([
      refusal(403, 'plan_required', 'Webhooks need a paid plan', {
        upgradeUrl: 'https://account.example/orgs/o1'
      })
    ]);
    const argv = ['webhooks', 'create', 'https://r.example', '--event', 'thing.created'];
    expect(await run([...argv, ...WIRED], h.io)).toBe(1);
    expect(h.err()).toContain(
      'Webhooks need a paid plan — upgrade the plan at https://account.example/orgs/o1'
    );
  });
});
