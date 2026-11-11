import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@antasphere/chassis-contract';

/**
 * The person a request runs as (PRDCT-4393), for the code that acts AS that
 * person beyond this tool: the sibling call (`connections/sibling-call.ts`).
 * `authContext` opens the scope once the principal is admitted (a session,
 * an API key or an OAuth bearer; an MCP tool reaches the tool through its
 * own API in process, so it is covered by the same line), and everything the
 * route runs inherits it. Nothing else opens one: a job, a timer or a public
 * route runs outside any person, and the sibling call answers `no_person`
 * there. This module is internal on purpose (no package export names it): a
 * tool reads the person through the call, never sets one, so no argument of
 * any service can name another person.
 */
export interface PersonOfRequest {
  readonly userId: string;
  /** The workspace the request selected: the sibling workspace is matched on its hub organization. */
  readonly workspaceId: string;
  readonly via: Principal['via'];
}

const scope = new AsyncLocalStorage<PersonOfRequest>();

/** Run `fn` as the principal's person: what `authContext` wraps the rest of the request in. */
export function runAsPerson<T>(principal: Principal, fn: () => T): T {
  return scope.run(
    Object.freeze({ userId: principal.userId, workspaceId: principal.workspaceId, via: principal.via }),
    fn
  );
}

/** Run `fn` with no person, whatever scope it was called from: a request that carries no principal. */
export function runWithoutPerson<T>(fn: () => T): T {
  return scope.exit(fn);
}

/** The person of the request being served, or null outside one. */
export function personOfRequest(): PersonOfRequest | null {
  return scope.getStore() ?? null;
}
