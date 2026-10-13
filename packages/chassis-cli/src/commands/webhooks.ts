import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import type {
  WebhookCatalog,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointCreate,
  WebhookEndpointUpdate,
  WebhookFilters
} from '@antasphere/chassis-contract';
import { CliApiRefusal, CliUsageError, drainPages, printJson, table, type CliIo } from '../context.js';
import type { CliIdentity } from '../identity.js';
import type { CliKit } from '../kit.js';

/**
 * The webhook commands (PRDCT-3482): the URLs a workspace registers to be
 * told, by a signed POST, when one of the tool's events happens. Owners and
 * admins manage them; every non-guest member reads the catalog. A key needs
 * the tool's webhooks scope (`identity.webhooksScope`), the catalog its read
 * scope. The signing secret is printed twice in an endpoint's life, at the
 * create and at a rotation, and never again. Every human line goes through
 * the sanitizing sinks the runner installed (a URL, a description and a
 * receiver's error are somebody else's text), and `--json` is the API
 * payload verbatim, the secret included.
 *
 * The endpoint's address is a POSITIONAL argument of `create` and
 * `--endpoint-url` on `update`: the program's own `--url` (the instance)
 * would take a `--url` given anywhere on the line.
 */

/** What a refusal was about: an endpoint, one of its deliveries, or the catalog. */
export type WebhookLookup = 'webhook' | 'delivery' | 'catalog';

/**
 * The server's webhook refusals as sentences. Returns the line, or null when
 * the error is not one of them (the runner's generic handling is then the
 * honest answer).
 */
export function explainWebhookRefusal(
  e: PlatformApiError,
  lookup: WebhookLookup,
  identity: Pick<CliIdentity, 'displayName' | 'webhooksScope'>
): string | null {
  switch (e.code) {
    case 'forbidden':
      return e.status === 403 ? 'Only an owner or an admin manages webhooks.' : null;
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not manage its webhooks.';
    case 'not_found':
      if (lookup === 'catalog') return null;
      return lookup === 'delivery' ? 'No such delivery.' : 'No such webhook in this workspace.';
    case 'url_refused':
    case 'demo_session':
      return e.message;
    case 'plan_required': {
      const url = (e.details as { upgradeUrl?: unknown } | undefined)?.upgradeUrl;
      return typeof url === 'string' && url ? `${e.message} — upgrade the plan at ${url}` : e.message;
    }
    case 'insufficient_scope':
    case 'endpoint_not_allowed':
      // The catalog is a read: a key refused there lacks the READ scope, and
      // the server's own sentence names it.
      if (lookup === 'catalog') return null;
      return identity.webhooksScope
        ? `This key cannot manage webhooks: create one with the ${identity.webhooksScope} scope on the API keys page.`
        : `${identity.displayName} opens webhooks to no API key: manage them signed in, in the dashboard.`;
    default:
      return null;
  }
}

/** Run a webhook call, turning the known refusals into sentences. */
async function explained<T>(
  identity: Pick<CliIdentity, 'displayName' | 'webhooksScope'>,
  lookup: WebhookLookup,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      const line = explainWebhookRefusal(e, lookup, identity);
      if (line) throw new CliApiRefusal(line, e.status);
    }
    throw e;
  }
}

/** Every endpoint of the workspace, page after page. */
async function allWebhooks(client: ChassisClient<string>): Promise<WebhookEndpoint[]> {
  const first = await client.webhooks();
  return drainPages({ rows: first.webhooks, nextCursor: first.nextCursor }, async (cursor) => {
    const page = await client.webhooks({ cursor });
    return { rows: page.webhooks, nextCursor: page.nextCursor };
  });
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/**
 * `--filter subject=id`, repeatable: several on the same subject OR together
 * (the ids accumulate under one key), different subjects AND.
 */
export function parseWebhookFilters(values: string[]): WebhookFilters {
  const filters: Record<string, string[]> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    const subject = at > 0 ? value.slice(0, at).trim() : '';
    const id = at > 0 ? value.slice(at + 1).trim() : '';
    if (!subject || !id) {
      throw new CliUsageError(`--filter takes <subject>=<id> (e.g. thing=<id>), not "${value}".`);
    }
    const ids = (filters[subject] ??= []);
    if (!ids.includes(id)) ids.push(id);
  }
  return filters;
}

const DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = ['pending', 'delivered', 'failed', 'held'];

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new CliUsageError(`--limit takes a whole number from 1 to 100, not "${value}".`);
  }
  return n;
}

/** The date and minute of an ISO 8601 timestamp (`2026-10-23 14:05`). */
function fmtWhen(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function fmtFilters(filters: Record<string, string[]>): string {
  const keys = Object.keys(filters);
  return keys.length === 0 ? 'none' : keys.map((k) => `${k}=${(filters[k] ?? []).join('|')}`).join(' ');
}

function lastDelivery(w: WebhookEndpoint): string {
  return w.lastDeliveryStatus && w.lastDeliveryAt
    ? `${w.lastDeliveryStatus} ${fmtWhen(w.lastDeliveryAt)}`
    : '-';
}

/** One endpoint, as the human sees it. */
function endpointLines(w: WebhookEndpoint): string {
  return (
    `${w.url}\n` +
    `  id:           ${w.id}\n` +
    (w.description ? `  description:  ${w.description}\n` : '') +
    `  events:       ${w.events.join(', ')}\n` +
    `  filters:      ${fmtFilters(w.filters)}\n` +
    `  enabled:      ${w.enabled ? 'yes' : 'no'}\n` +
    (w.disabledAt
      ? `  disabled:     ${w.disabledAt}${w.disabledReason ? ` (${w.disabledReason})` : ''}\n`
      : '') +
    `  failures:     ${w.consecutiveFailures} in a row\n` +
    `  last:         ${lastDelivery(w)}\n` +
    (w.previousSecretExpiresAt ? `  old secret:   signs until ${w.previousSecretExpiresAt}\n` : '') +
    `  created:      ${w.createdAt}\n`
  );
}

/** One delivery, as the human sees it. */
function deliveryLines(d: WebhookDelivery): string {
  return (
    `Delivery ${d.id}\n` +
    `  event:     ${d.eventType} (${d.eventId})\n` +
    `  status:    ${d.status}\n` +
    `  attempt:   ${d.attempt}\n` +
    `  HTTP code: ${d.lastStatusCode ?? '-'}\n` +
    (d.lastError ? `  error:     ${d.lastError}\n` : '') +
    (d.nextAttemptAt ? `  next try:  ${d.nextAttemptAt}\n` : '') +
    (d.deliveredAt ? `  delivered: ${d.deliveredAt}\n` : '') +
    `  created:   ${d.createdAt}\n`
  );
}

function catalogLines(catalog: WebhookCatalog): string {
  if (catalog.events.length === 0) return 'No event types.\n';
  let out = table([
    ['TYPE', 'SUBJECTS', 'DESCRIPTION'],
    ...catalog.events.map((e) => [e.type, e.subjects.join(',') || '-', e.description])
  ]);
  if (catalog.subjects.length > 0) {
    out +=
      '\nSubjects (what --filter <subject>=<id> matches on):\n' +
      table(catalog.subjects.map((s) => [`  ${s.key}`, `subjects.${s.field}`, s.description]));
  }
  return out;
}

export function registerWebhookCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext, identity } = kit;
  const scopeLine = identity.webhooksScope
    ? `A key needs the ${identity.webhooksScope} scope.`
    : `${identity.displayName} opens webhooks to no API key.`;

  const webhooks = program
    .command('webhooks')
    .description("The workspace's webhooks (signed POSTs to your URLs when an event happens)")
    .addHelpText(
      'after',
      '\nAn owner or an admin manages the webhooks; every member reads the event catalog\n' +
        `(\`webhooks events\`). ${scopeLine}\n` +
        'The signing secret is printed once, at `create` and at `rotate-secret`: store it then.\n'
    );

  // ── webhooks list ─────────────────────────────────────────────────────────
  webhooks
    .command('list')
    .description("List the workspace's webhook endpoints (every page)")
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const rows = await explained(identity, 'webhook', () => allWebhooks(ctx.client));
      if (ctx.json) return printJson(io, { webhooks: rows, nextCursor: null });
      if (rows.length === 0) {
        io.out.write('No webhooks.\n');
        return;
      }
      io.out.write(
        table([
          ['ID', 'URL', 'EVENTS', 'ENABLED', 'LAST DELIVERY', 'FAILURES'],
          ...rows.map((w) => [
            w.id,
            w.url,
            w.events.join(','),
            w.enabled ? 'yes' : 'no',
            lastDelivery(w),
            String(w.consecutiveFailures)
          ])
        ])
      );
    });

  // ── webhooks events ───────────────────────────────────────────────────────
  webhooks
    .command('events')
    .description('The event catalog: every event type, the subjects it carries, what it means')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const catalog = await explained(identity, 'catalog', () => ctx.client.webhookEvents());
      if (ctx.json) return printJson(io, catalog);
      io.out.write(catalogLines(catalog));
    });

  // ── webhooks create ───────────────────────────────────────────────────────
  webhooks
    .command('create <url>')
    .description('Register an endpoint (owner or admin); its signing secret is printed once')
    .option(
      '--event <type>',
      'an event type (thing.created), a family (thing.*) or everything (*); repeatable, at least one',
      collect,
      []
    )
    .option('--description <text>', 'what the endpoint is for')
    .option(
      '--filter <subject>=<id>',
      'only events about this subject id; repeatable (same subject: OR, different subjects: AND)',
      collect,
      []
    )
    .option('--disabled', 'register it switched off', false)
    .action(
      async (
        url: string,
        opts: { event: string[]; description?: string; filter: string[]; disabled: boolean },
        cmd: Command
      ) => {
        if (opts.event.length === 0) {
          throw new CliUsageError(
            'Name at least one event: --event <type> (e.g. --event thing.created), repeatable.'
          );
        }
        const filters = parseWebhookFilters(opts.filter);
        const req: WebhookEndpointCreate = {
          url,
          events: opts.event,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
          ...(opts.disabled ? { enabled: false } : {})
        };
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const created = await explained(identity, 'webhook', () => ctx.client.createWebhook(req));
        if (ctx.json) return printJson(io, created);
        io.out.write(
          `Created webhook ${created.id}.\n` +
            'Its signing secret is shown this once, never again: store it now.\n' +
            `${created.secret}\n`
        );
      }
    );

  // ── webhooks get ──────────────────────────────────────────────────────────
  webhooks
    .command('get <id>')
    .description('Show one endpoint')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const endpoint = await explained(identity, 'webhook', () => ctx.client.webhook(id));
      if (ctx.json) return printJson(io, endpoint);
      io.out.write(endpointLines(endpoint));
    });

  // ── webhooks update ───────────────────────────────────────────────────────
  webhooks
    .command('update <id>')
    .description('Change an endpoint (owner or admin); only what is passed changes')
    .option('--endpoint-url <url>', 'the new address the deliveries go to')
    .option('--description <text>', 'the new description')
    .option('--event <type>', 'replace the events with these; repeatable', collect, [])
    .option('--filter <subject>=<id>', 'replace the filters with these; repeatable', collect, [])
    .option('--clear-filters', 'remove every filter', false)
    .option('--enable', 'switch the endpoint on', false)
    .option('--disable', 'switch the endpoint off', false)
    .action(
      async (
        id: string,
        opts: {
          endpointUrl?: string;
          description?: string;
          event: string[];
          filter: string[];
          clearFilters: boolean;
          enable: boolean;
          disable: boolean;
        },
        cmd: Command
      ) => {
        if (opts.enable && opts.disable) {
          throw new CliUsageError('Pass --enable or --disable, not both.');
        }
        if (opts.clearFilters && opts.filter.length > 0) {
          throw new CliUsageError('Pass --filter or --clear-filters, not both.');
        }
        const req: WebhookEndpointUpdate = {
          ...(opts.endpointUrl !== undefined ? { url: opts.endpointUrl } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.event.length > 0 ? { events: opts.event } : {}),
          ...(opts.filter.length > 0 ? { filters: parseWebhookFilters(opts.filter) } : {}),
          ...(opts.clearFilters ? { filters: {} } : {}),
          ...(opts.enable ? { enabled: true } : {}),
          ...(opts.disable ? { enabled: false } : {})
        };
        if (Object.keys(req).length === 0) {
          throw new CliUsageError(
            'Nothing to change — pass --endpoint-url, --description, --event, --filter, --clear-filters, --enable or --disable.'
          );
        }
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const updated = await explained(identity, 'webhook', () => ctx.client.updateWebhook(id, req));
        if (ctx.json) return printJson(io, updated);
        io.out.write(`Updated webhook ${updated.id}.\n${endpointLines(updated)}`);
      }
    );

  // ── webhooks delete ───────────────────────────────────────────────────────
  webhooks
    .command('delete <id>')
    .description('Delete an endpoint and its delivery history (owner or admin)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deleted = await explained(identity, 'webhook', () => ctx.client.deleteWebhook(id));
      if (ctx.json) return printJson(io, deleted);
      io.out.write(`Deleted webhook ${deleted.id} (${deleted.url}) and its delivery history.\n`);
    });

  // ── webhooks rotate-secret ────────────────────────────────────────────────
  webhooks
    .command('rotate-secret <id>')
    .description("Replace an endpoint's signing secret (owner or admin); the new one is printed once")
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const rotated = await explained(identity, 'webhook', () => ctx.client.rotateWebhookSecret(id));
      if (ctx.json) return printJson(io, rotated);
      io.out.write(
        `New signing secret for webhook ${rotated.id}, shown this once, never again: store it now.\n` +
          `${rotated.secret}\n` +
          `The previous secret keeps signing until ${rotated.previousSecretExpiresAt}.\n`
      );
    });

  // ── webhooks test ─────────────────────────────────────────────────────────
  webhooks
    .command('test <id>')
    .description('Send a signed webhook.ping now and print its outcome (exit 1 when not delivered)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const { delivery } = await explained(identity, 'webhook', () => ctx.client.testWebhook(id));
      if (ctx.json) printJson(io, { delivery });
      else
        io.out.write(
          `Ping ${delivery.status}` +
            (delivery.lastStatusCode !== null ? `, HTTP ${delivery.lastStatusCode}` : '') +
            (delivery.lastError ? `: ${delivery.lastError}` : '') +
            ` (delivery ${delivery.id}).\n`
        );
      // The one way this kit ends a command non-zero: a usage error carries
      // the exit code to the runner, which writes it on stderr.
      if (delivery.status !== 'delivered') {
        throw new CliUsageError(`The ping was not delivered (${delivery.status}).`);
      }
    });

  // ── webhooks deliveries ───────────────────────────────────────────────────
  webhooks
    .command('deliveries <id>')
    .description("List one page of an endpoint's deliveries, newest first")
    .option('--status <status>', `only these: ${DELIVERY_STATUSES.join(', ')}`)
    .option('--limit <n>', 'page size, 1 to 100 (server default 50)')
    .option('--cursor <cursor>', 'the next page, as the previous one printed it')
    .action(async (id: string, opts: { status?: string; limit?: string; cursor?: string }, cmd: Command) => {
      if (opts.status !== undefined && !DELIVERY_STATUSES.includes(opts.status as WebhookDeliveryStatus)) {
        throw new CliUsageError(
          `--status takes one of ${DELIVERY_STATUSES.join(', ')}, not "${opts.status}".`
        );
      }
      const params = {
        ...(opts.status !== undefined ? { status: opts.status as WebhookDeliveryStatus } : {}),
        ...(opts.limit !== undefined ? { limit: parseLimit(opts.limit) } : {}),
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {})
      };
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const page = await explained(identity, 'webhook', () => ctx.client.webhookDeliveries(id, params));
      if (ctx.json) return printJson(io, page);
      if (page.deliveries.length === 0) {
        io.out.write('No deliveries.\n');
        return;
      }
      io.out.write(
        table([
          ['ID', 'EVENT', 'STATUS', 'ATTEMPT', 'CODE', 'CREATED'],
          ...page.deliveries.map((d) => [
            d.id,
            d.eventType,
            d.status,
            String(d.attempt),
            d.lastStatusCode !== null ? String(d.lastStatusCode) : '-',
            fmtWhen(d.createdAt)
          ])
        ])
      );
      if (page.nextCursor) io.out.write(`More: --cursor ${page.nextCursor}\n`);
    });

  // ── webhooks delivery ─────────────────────────────────────────────────────
  webhooks
    .command('delivery <id> <deliveryId>')
    .description('Show one delivery: its status, its latest attempt (--json: the payload as sent)')
    .action(async (id: string, deliveryId: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const delivery = await explained(identity, 'delivery', () =>
        ctx.client.webhookDelivery(id, deliveryId)
      );
      if (ctx.json) return printJson(io, delivery);
      io.out.write(deliveryLines(delivery));
    });

  // ── webhooks redeliver ────────────────────────────────────────────────────
  webhooks
    .command('redeliver <id> <deliveryId>')
    .description('Queue the same event again as a new delivery (same event id, same payload)')
    .action(async (id: string, deliveryId: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const delivery = await explained(identity, 'delivery', () =>
        ctx.client.redeliverWebhook(id, deliveryId)
      );
      if (ctx.json) return printJson(io, delivery);
      io.out.write(`Queued delivery ${delivery.id} of ${delivery.eventType} (event ${delivery.eventId}).\n`);
    });
}
