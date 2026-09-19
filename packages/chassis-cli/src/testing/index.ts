import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChassisClient } from '@antasphere/chassis-sdk';
import type { CliIo } from '../context.js';
import type { Cli } from '../kit.js';

/**
 * The test harness of a CLI built on this package, shared by the chassis suite
 * and by the tool's own tests. `./testing` is a test-only entry: it is built
 * (the tool's tests read it from `dist`) and kept out of the packed artefact
 * (`files` in package.json) and out of the tool's bundle (nothing under a
 * tool's `src` imports it).
 *
 * Router-style fake fetch: handlers matched by method + path regex, so
 * order-insensitive flows (parallel uploads) stay assertable. Records every
 * call with its parsed body (JSON / FormData summary).
 */

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * The full wire view of a call — origin + authorization header included.
 * Kept in a SEPARATE array (`wire`) so the legacy strict `toEqual` asserts
 * on `calls` keep their exact shape; the connect tests use this to prove
 * which credential went to which host.
 */
export interface WireCall {
  method: string;
  origin: string;
  path: string;
  auth: string | undefined;
  /** The `x-workspace-id` header, present only when the request carried one. */
  workspace?: string;
  body?: unknown;
}

export interface Route {
  method: string;
  path: RegExp;
  reply: (call: { path: string; body?: unknown; form?: FormData; headers: Headers }) => {
    status?: number;
    body?: unknown;
    raw?: Response;
  };
}

export function routedHarness(routes: Route[], env: Record<string, string | undefined> = {}) {
  const calls: RecordedCall[] = [];
  const wire: WireCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname + url.search;
    let body: unknown;
    let form: FormData | undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      form = init.body;
      body = { sha256: form.get('sha256') };
    }
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? undefined;
    const workspace = headers.get('x-workspace-id') ?? undefined;
    wire.push({
      method,
      origin: url.origin,
      path,
      auth,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(body !== undefined ? { body } : {})
    });
    const route = routes.find((r) => r.method === method && r.path.test(url.pathname));
    if (!route) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: `no fake route ${method} ${path}` } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' }
        }
      );
    }
    const result = route.reply({ path, body, headers, ...(form ? { form } : {}) });
    if (result.raw) return result.raw;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;

  const io: CliIo = {
    env,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    fetch
  };
  return { io, calls, wire, out: () => out.join(''), err: () => err.join('') };
}

/** A temp HOME-like config root, isolated per test. */
export async function tempConfigEnv(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-cfg-'));
  return { XDG_CONFIG_HOME: dir };
}

/**
 * What the chassis suite (`test/suite`) reads from `@chassis-cli-test/host`:
 * one instantiated CLI and its runner, with the tool's groups and version
 * already bound. The chassis package aliases the specifier to its minimal
 * `things` tool; a tool's own CLI package aliases it to its real kit, and the
 * same files run a second time there. Every literal that spells the tool in
 * the suite is read from `cli.identity`.
 */
export interface CliTestHost<TClient extends ChassisClient<string>> {
  cli: Cli<TClient>;
  run(argv: string[], io: CliIo): Promise<number>;
}
