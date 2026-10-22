import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import type {
  Connection,
  ConnectionDelivery,
  ConnectionFieldValue,
  ConnectionFields
} from '@antasphere/chassis-contract';
import { CliApiRefusal, CliUsageError, drainPages, printJson, table, type CliIo } from '../context.js';
import type { CliIdentity } from '../identity.js';
import type { CliKit } from '../kit.js';
import { readSecretFromStdin } from '../stdin.js';

/**
 * The connection commands (PRDCT-3773): every inbound webhook source the
 * tool receives from and every outbound key it holds, one source per card of
 * Settings › Connections. Every non-guest member reads them; an owner or an
 * admin connects, sets the secret, the fields, tests and disconnects. A key
 * reads under the tool's read scope and writes under its webhooks scope
 * (`identity.webhooksScope`). The receiving URL is printed once, alone on
 * stdout, when it is made or rotated, and never again; the secret is read
 * from stdin or a file, never from an argument, and never printed. Every
 * human line goes through the sanitizing sinks the runner installed (a
 * detail, a field value, an event type are somebody else's text), and
 * `--json` is the API payload verbatim.
 */

/** What a refusal was about: a source (its connection), or its delivery log. */
export type ConnectionLookup = 'connection' | 'delivery';

/**
 * The server's connection refusals as sentences. Returns the line, or null
 * when the error is not one of them (the runner's generic handling is then
 * the honest answer).
 */
export function explainConnectionRefusal(
  e: PlatformApiError,
  lookup: ConnectionLookup,
  identity: Pick<CliIdentity, 'displayName' | 'webhooksScope'>
): string | null {
  switch (e.code) {
    case 'forbidden':
      return e.status === 403 ? 'Only an owner or an admin changes connections.' : null;
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not manage its connections.';
    case 'not_found':
      return 'No such connection source on this instance (`connections list` names them).';
    case 'not_inbound':
      return 'This source holds a key and has no receiving URL: set its key with `connections secret`.';
    case 'not_connected':
      return 'Nothing is connected yet for this source: `connections connect` makes the receiving URL, `connections secret` sets the key.';
    case 'secret_invalid':
    case 'secret_refused':
    case 'source_unavailable':
    case 'unknown_field':
    case 'field_required':
    case 'demo_session':
      return e.message;
    case 'insufficient_scope':
    case 'endpoint_not_allowed':
      // The delivery log is a read: a key refused there lacks the READ scope,
      // and the server's own sentence names it.
      if (lookup === 'delivery') return null;
      return identity.webhooksScope
        ? `This key cannot change connections: create one with the ${identity.webhooksScope} scope on the API keys page.`
        : 'This instance opens no connection write to a key.';
    default:
      return null;
  }
}

/** The scope refusals, which only a write may word as the webhooks scope. */
const SCOPE_CODES = new Set(['insufficient_scope', 'endpoint_not_allowed']);

/**
 * Run a connection call, turning the known refusals into sentences. A read
 * (`list`, `show`) keeps the server's sentence for a scope refusal: it names
 * the read scope, which the webhooks wording would get wrong.
 */
async function explained<T>(
  identity: Pick<CliIdentity, 'displayName' | 'webhooksScope'>,
  lookup: ConnectionLookup,
  run: () => Promise<T>,
  opts: { read?: boolean } = {}
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError && !(opts.read && SCOPE_CODES.has(e.code))) {
      const line = explainConnectionRefusal(e, lookup, identity);
      if (line) throw new CliApiRefusal(line, e.status);
    }
    throw e;
  }
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/**
 * `--set key=value` (repeatable: the same key twice makes a list) and
 * `--clear key` (null), as the `{ fields }` of the PATCH.
 */
export function parseConnectionFields(sets: string[], clears: string[]): ConnectionFields {
  const fields: Record<string, string | string[] | null> = {};
  for (const value of sets) {
    const at = value.indexOf('=');
    const key = at > 0 ? value.slice(0, at).trim() : '';
    if (!key) {
      throw new CliUsageError(`--set takes <key>=<value> (e.g. --set calendar=team), not "${value}".`);
    }
    const v = value.slice(at + 1);
    const prior = fields[key];
    fields[key] = prior === undefined ? v : Array.isArray(prior) ? [...prior, v] : [prior as string, v];
  }
  for (const key of clears) {
    if (!key.trim()) throw new CliUsageError('--clear takes a field key.');
    if (fields[key.trim()] !== undefined) {
      throw new CliUsageError(`--set and --clear both name "${key.trim()}": pass one of them.`);
    }
    fields[key.trim()] = null;
  }
  return fields;
}

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

function fmtBy(m: { name: string; email: string } | null): string {
  return m ? ` by ${m.name} <${m.email}>` : '';
}

function fmtValue(v: ConnectionFieldValue | undefined): string {
  if (v === null || v === undefined) return '-';
  return Array.isArray(v) ? v.join(', ') : v;
}

function secretState(c: Connection): string {
  if (!c.secret.set) return 'missing';
  return c.secret.readable ? 'set' : 'UNREADABLE';
}

function lastDeliveryText(c: Connection): string {
  return c.lastDelivery ? `${c.lastDelivery.type} at ${fmtWhen(c.lastDelivery.at)}` : 'none';
}

function checkText(c: Connection): string {
  if (!c.check) return 'none';
  return c.check.ok ? 'ok' : `failed: ${c.check.detail}`;
}

/** One source on one line, as `list` prints it. */
function connectionLine(c: Connection): string {
  return (
    `${c.name} (${c.source}) · ${c.connected ? 'connected' : 'not connected'}` +
    ` · secret ${secretState(c)}` +
    ` · last delivery ${lastDeliveryText(c)}` +
    ` · last check ${checkText(c)}\n`
  );
}

/** One source, as the human sees it. */
function connectionLines(c: Connection): string {
  const d = c.declared;
  const secret = !c.secret.set
    ? 'missing'
    : c.secret.readable
      ? `set${c.secret.setAt ? ` ${c.secret.setAt}` : ''}${fmtBy(c.secret.setBy)}`
      : 'UNREADABLE (the instance can no longer open it: set it again)';
  return (
    `${c.name} (${c.source}) · ${c.kind} · ${c.connected ? 'connected' : 'not connected'}\n` +
    (d.description ? `  description:   ${d.description}\n` : '') +
    (d.verifier ? `  verifier:      ${d.verifier}\n` : '') +
    (d.events.length > 0 ? `  events:        ${d.events.join(', ')}\n` : '') +
    (c.kind !== 'key'
      ? `  url:           ${c.url ? `made ${c.url.madeAt}${fmtBy(c.url.madeBy)}` : 'not made'}\n`
      : '') +
    `  secret:        ${secret}\n` +
    d.fields.map((f) => `  ${f.label}: ${fmtValue(c.fields[f.key])}\n`).join('') +
    `  last delivery: ${c.lastDelivery ? `${lastDeliveryText(c)} (${c.lastDelivery.outcome})` : 'none'}\n` +
    `  last check:    ${c.check ? `${c.check.ok ? 'ok' : 'failed'} at ${fmtWhen(c.check.at)}: ${c.check.detail}` : 'none'}\n` +
    (c.sibling
      ? `  sibling:       ${c.sibling.endpointId ? `endpoint ${c.sibling.endpointId}` : 'no endpoint registered yet'}${d.sibling ? ` on ${d.sibling.toolSlug}` : ''}\n`
      : '')
  );
}

function deliveryRow(d: ConnectionDelivery): string[] {
  return [fmtWhen(d.receivedAt), d.type, d.outcome, d.error ? `error: ${d.error}` : (d.detail ?? '-')];
}

/** The secret, from the first line of stdin or of a file: never from an argument. */
async function readConnectionSecret(
  io: CliIo,
  opts: { stdin: boolean; secretFile?: string }
): Promise<string> {
  if (opts.stdin === (opts.secretFile !== undefined)) {
    throw new CliUsageError(
      'Name exactly one of --stdin or --secret-file <path>: the secret is never taken from an argument.'
    );
  }
  if (opts.stdin) return readSecretFromStdin(io, 'connection secret');
  let raw: string;
  try {
    raw = await readFile(opts.secretFile!, 'utf8');
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new CliUsageError(
      `Cannot read --secret-file ${opts.secretFile}${typeof code === 'string' ? ` (${code})` : ''}.`
    );
  }
  const value = raw.split('\n')[0]?.trim() ?? '';
  if (!value)
    throw new CliUsageError(`Nothing on the first line of ${opts.secretFile} to read the secret from.`);
  return value;
}

export function registerConnectionCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext, identity } = kit;
  const scopeLine = identity.webhooksScope
    ? `A key reads them with the read scope and changes them with the ${identity.webhooksScope} scope.`
    : `A key reads them with the read scope; ${identity.displayName} opens no connection write to a key.`;

  const connections = program
    .command('connections')
    .description('The sources the workspace receives from and the keys it holds (Settings › Connections)')
    .addHelpText(
      'after',
      '\nEvery member reads the connections; an owner or an admin changes them.\n' +
        `${scopeLine}\n` +
        'The receiving URL is printed once, by `connect`: give it to the source then.\n' +
        'The secret is read from --stdin or --secret-file, never from an argument, and never shown.\n'
    );

  // ── connections list ──────────────────────────────────────────────────────
  connections
    .command('list')
    .description('Every source this instance declares, with its state in the workspace')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const list = await explained(identity, 'connection', () => ctx.client.connections(), { read: true });
      if (ctx.json) return printJson(io, list);
      if (list.connections.length === 0) {
        io.out.write('No connection sources.\n');
        return;
      }
      io.out.write(list.connections.map(connectionLine).join(''));
    });

  // ── connections show ──────────────────────────────────────────────────────
  connections
    .command('show <source>')
    .description('Show one source: what it is, its URL and secret state, its fields, its last delivery')
    .action(async (source: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const c = await explained(identity, 'connection', () => ctx.client.connection(source), { read: true });
      if (ctx.json) return printJson(io, c);
      io.out.write(connectionLines(c));
    });

  // ── connections connect ───────────────────────────────────────────────────
  connections
    .command('connect <source>')
    .description('Make the receiving URL of a source (owner or admin); printed once, alone on stdout')
    .option('--rotate', 'replace the current URL: the old one stops working at once', false)
    .action(async (source: string, opts: { rotate: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (!opts.rotate) {
        const current = await explained(identity, 'connection', () => ctx.client.connection(source), {
          read: true
        });
        if (current.url !== null) {
          throw new CliUsageError(
            `${current.name} already has a receiving URL. Pass --rotate to make a new one: the old URL stops working at once.`
          );
        }
      }
      const made = await explained(identity, 'connection', () => ctx.client.connectSource(source));
      if (ctx.json) return printJson(io, made);
      io.out.write(`${made.receivingUrl}\n`);
      const c = made.connection;
      io.err.write(
        (opts.rotate ? 'The previous receiving URL no longer works.\n' : '') +
          `The receiving URL of ${c.name} is shown this once, never again: only its fingerprint is kept.\n` +
          `Give it to ${c.name} as the address it posts to.\n` +
          (c.secret.set && c.secret.readable
            ? 'The secret stays as it was.\n'
            : `Then set the secret: \`${identity.bin} connections secret ${c.source} --stdin\`.\n`)
      );
    });

  // ── connections secret ────────────────────────────────────────────────────
  connections
    .command('secret <source>')
    .description(
      "Set the source's signing secret or key (owner or admin), read from stdin or a file, never from an argument"
    )
    // A secret given as an argument is refused, not ignored: argv is what the value must never ride.
    .allowExcessArguments(false)
    .option('--stdin', 'read the secret from the first line of standard input', false)
    .option('--secret-file <path>', 'read the secret from the first line of this file')
    .action(async (source: string, opts: { stdin: boolean; secretFile?: string }, cmd: Command) => {
      const secret = await readConnectionSecret(io, opts);
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const c = await explained(identity, 'connection', () =>
        ctx.client.setConnectionSecret(source, { secret })
      );
      if (ctx.json) return printJson(io, c);
      io.out.write(`Secret set (stored sealed, never shown again).\n${connectionLines(c)}`);
    });

  // ── connections fields ────────────────────────────────────────────────────
  connections
    .command('fields <source>')
    .description("Store the source's declared fields (owner or admin); a key not named keeps its value")
    .option('--set <key=value>', 'set a field; repeat the same key for a list', collect, [])
    .option('--clear <key>', 'clear a field; repeatable', collect, [])
    .action(async (source: string, opts: { set: string[]; clear: string[] }, cmd: Command) => {
      const fields = parseConnectionFields(opts.set, opts.clear);
      if (Object.keys(fields).length === 0) {
        throw new CliUsageError('Nothing to change — pass --set <key>=<value> or --clear <key>.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const c = await explained(identity, 'connection', () =>
        ctx.client.setConnectionFields(source, { fields })
      );
      if (ctx.json) return printJson(io, c);
      io.out.write(`Fields stored.\n${connectionLines(c)}`);
    });

  // ── connections test ──────────────────────────────────────────────────────
  connections
    .command('test <source>')
    .description('Test the connection now and print what it found (exit 1 when it fails)')
    .action(async (source: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const result = await explained(identity, 'connection', () => ctx.client.testConnection(source));
      if (ctx.json) printJson(io, result);
      else io.out.write(`${result.ok ? 'ok' : 'failed'}: ${result.detail}\n`);
      // The one way this kit ends a command non-zero: a usage error carries
      // the exit code to the runner, which writes it on stderr.
      if (!result.ok) {
        throw new CliUsageError(`The test of ${result.connection.name} did not pass.`);
      }
    });

  // ── connections disconnect ────────────────────────────────────────────────
  connections
    .command('disconnect <source>')
    .description('Disconnect the source (owner or admin): its secret, URL and delivery log are gone')
    .option('--yes', 'confirm: the secret, the receiving URL and the delivery log are deleted', false)
    .action(async (source: string, opts: { yes: boolean }, cmd: Command) => {
      if (!opts.yes) {
        throw new CliUsageError(
          `Disconnecting ${source} deletes its secret, its receiving URL and its delivery log in this workspace: pass --yes to confirm.`
        );
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const c = await explained(identity, 'connection', () => ctx.client.disconnectSource(source));
      if (ctx.json) return printJson(io, c);
      io.out.write(
        `Disconnected ${c.name} (${c.source}): its secret, its receiving URL and its delivery log are gone.\n`
      );
    });

  // ── connections deliveries ────────────────────────────────────────────────
  connections
    .command('deliveries <source>')
    .description('List the deliveries the source sent, newest first (owner or admin)')
    .option('--limit <n>', 'page size, 1 to 100 (server default 50)')
    .option('--cursor <cursor>', 'the next page, as the previous one printed it')
    .option('--all', 'read every page', false)
    .action(async (source: string, opts: { limit?: string; cursor?: string; all: boolean }, cmd: Command) => {
      const params = {
        ...(opts.limit !== undefined ? { limit: parseLimit(opts.limit) } : {}),
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {})
      };
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const first = await explained(identity, 'delivery', () =>
        ctx.client.connectionDeliveries(source, params)
      );
      let rows = first.deliveries;
      let nextCursor = first.nextCursor;
      if (opts.all) {
        rows = await drainPages({ rows: first.deliveries, nextCursor: first.nextCursor }, async (cursor) => {
          const page = await explained(identity, 'delivery', () =>
            ctx.client.connectionDeliveries(source, { ...params, cursor })
          );
          return { rows: page.deliveries, nextCursor: page.nextCursor };
        });
        nextCursor = null;
      }
      if (ctx.json) return printJson(io, opts.all ? { deliveries: rows, nextCursor: null } : first);
      if (rows.length === 0) {
        io.out.write('No deliveries.\n');
        return;
      }
      io.out.write(table([['RECEIVED', 'TYPE', 'OUTCOME', 'DETAIL'], ...rows.map(deliveryRow)]));
      if (nextCursor) io.out.write(`More: --cursor ${nextCursor} (or --all)\n`);
    });
}
