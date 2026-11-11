import type { Logger } from '../logger.js';
import { personOfRequest, type PersonOfRequest } from '../middleware/person-scope.js';
import type { FleetTool } from '../webhooks/fleet-origins.js';
import {
  SIBLING_METHODS,
  type SiblingAnswer,
  type SiblingBudget,
  type SiblingConnector,
  type SiblingMethod,
  type SiblingOutcome,
  type SiblingRefusal
} from './sibling.js';

/**
 * The sibling call (PRDCT-4393): a tool's service runs one or a few requests
 * on a sibling tool of the same hub AS THE PERSON of the request being
 * served, with nothing but that person's own rights. It is the sibling
 * connect's conversation (PRDCT-3774, `sibling.ts`) opened to the tool's
 * code:
 *
 *  1. the sibling must be DECLARED by the tool (the `siblings` slot): any
 *     other slug is refused before the hub, the fleet list or the database
 *     is read;
 *  2. the instance must be on a hub (a cloud boot): a local instance answers
 *     `not_on_hub`;
 *  3. the person is the request's principal, read from the request's own
 *     scope (`middleware/person-scope.ts`), never from an argument: a call
 *     outside a person's request answers `no_person`, and no parameter can
 *     name another person; no service key exists anywhere on the path (the
 *     no-service-key rule of identity/hub-grant.ts);
 *  4. the hub's two-minute connect token for the sibling, bought with the
 *     person's own grant on this tool; the key the sibling mints for the
 *     person; the sibling workspace whose `centralAccountId` is the hub
 *     organization of the request's workspace;
 *  5. the tool's work, handed a handle that sends requests as the person in
 *     that workspace: the key never reaches the tool's code, and the handle
 *     refuses everything once the call is over;
 *  6. the key revoked in a `finally`, whatever the work did: answered,
 *     refused, timed out or thrown.
 *
 * Every refusal is ANSWERED as an outcome, never thrown; a work that throws
 * has its own error rethrown once the key is revoked (a bug of the tool is
 * not a refusal of the sibling). The whole call, the work included, runs
 * under the connect's overall budget (DEFAULT_SIBLING_OVERALL_MS): past it
 * the call answers `unavailable` and the key is revoked even if the work has
 * not finished. Nothing here logs a token, a key, a secret or a query string.
 */

/** One sibling a tool may call: its registry slug at the hub. */
export interface SiblingDeclaration {
  toolSlug: string;
}

/** The refusals of the call: the connect's, plus the three that come before any conversation. */
export type SiblingCallRefusal =
  | SiblingRefusal
  /** The tool declares no sibling of that slug (`siblings` slot): nothing was asked of anyone. */
  | { kind: 'sibling_not_declared'; message: string }
  /** This instance is not on a hub (a local stack, password accounts): there is no sibling to reach. */
  | { kind: 'not_on_hub'; message: string }
  /** The call runs outside a person's request (a job, a timer, a public route): there is nobody to act as. */
  | { kind: 'no_person'; message: string };

export type SiblingCallOutcome<T> = { kind: 'ok'; value: T } | SiblingCallRefusal;

/** What the work is handed: the sibling and its workspace, and a way to send requests there as the person. */
export interface SiblingHandle {
  /** The sibling as the hub lists it. */
  readonly tool: { readonly slug: string; readonly name: string };
  /** The sibling workspace of the same hub organization, where every request runs. */
  readonly workspaceId: string;
  /**
   * One request on the sibling's API, as the person, in that workspace.
   * `path` is relative to the sibling's `/api/v1` (`/things`,
   * `/things/abc?view=full`); a path that would leave it (an absolute URL,
   * `//host`, a `..` segment) is a programming error and is thrown, as a
   * `TypeError`. A 2xx answers `ok` with the status and the JSON body; any
   * other 4xx is `sibling_refused` with the sibling's status, error code and
   * message; a 5xx, no answer, the budget spent or the call over is
   * `unavailable`.
   */
  request(
    method: SiblingMethod,
    path: string,
    opts?: { body?: unknown }
  ): Promise<SiblingOutcome<SiblingAnswer>>;
}

/** The work of a call: requests on the handle, then its own outcome. */
export type SiblingWork<T> = (sibling: SiblingHandle) => Promise<SiblingOutcome<T>>;

/** What a tool's services receive as `core.siblings`. */
export interface ToolSiblings {
  /** The slugs the tool declared, in order. */
  readonly declared: readonly string[];
  /** Run `work` on the sibling `toolSlug` as the person of the request being served. */
  call<T>(toolSlug: string, work: SiblingWork<T>): Promise<SiblingCallOutcome<T>>;
}

export interface SiblingCallsDeps {
  declared: readonly SiblingDeclaration[];
  /** The connect's conversations; null on an instance that is not on a hub. */
  connector: SiblingConnector | null;
  /** The hub organization of one of our workspaces; null for a local workspace. */
  centralAccountOf: (workspaceId: string) => Promise<string | null>;
  logger: Logger;
  /** The person of the request being served; the request scope by default (a unit test stands in). */
  person?: (() => PersonOfRequest | null) | undefined;
}

/** A registry slug: lowercase letters, digits and dashes, starting with a letter or a digit. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The `siblings` slot checked once at boot: a list of `{ toolSlug }`, each a
 * registry slug, none twice. A wrong declaration stops the boot naming the
 * slot, never a silent call refused at run time.
 */
export function buildSiblingDeclarations(declared: unknown): readonly SiblingDeclaration[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new Error('tool definition: `siblings` must be a list of { toolSlug }');
  }
  const seen = new Set<string>();
  return declared.map((entry: unknown, i) => {
    const slug = (entry as { toolSlug?: unknown } | null)?.toolSlug;
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw new Error(
        `tool definition: \`siblings[${i}].toolSlug\` must be a registry slug (lowercase letters, digits, dashes)`
      );
    }
    if (seen.has(slug)) throw new Error(`tool definition: \`siblings\` declares "${slug}" twice`);
    seen.add(slug);
    return Object.freeze({ toolSlug: slug });
  });
}

/** The request path checked against the sibling's API: relative to `/api/v1`, never leaving it. */
function checkedPath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('#') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\s]/.test(path)
  ) {
    throw new TypeError('sibling request: the path must be a path of the sibling’s /api/v1, like "/things"');
  }
  const bare = path.split('?', 1)[0]!;
  for (const segment of bare.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError('sibling request: the path is not a valid URL path');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new TypeError('sibling request: the path may not leave the sibling’s /api/v1');
    }
  }
  return path;
}

/** The handle a work is given: the key held privately, closed when the call ends. */
class Handle implements SiblingHandle {
  readonly tool: { readonly slug: string; readonly name: string };
  readonly #connector: SiblingConnector;
  readonly #fleetTool: FleetTool;
  readonly #key: string;
  readonly #budget: SiblingBudget;
  #closed = false;

  constructor(
    connector: SiblingConnector,
    fleetTool: FleetTool,
    key: string,
    readonly workspaceId: string,
    budget: SiblingBudget
  ) {
    this.tool = Object.freeze({ slug: fleetTool.slug, name: fleetTool.name });
    this.#connector = connector;
    this.#fleetTool = fleetTool;
    this.#key = key;
    this.#budget = budget;
  }

  close(): void {
    this.#closed = true;
  }

  async request(
    method: SiblingMethod,
    path: string,
    opts: { body?: unknown } = {}
  ): Promise<SiblingOutcome<SiblingAnswer>> {
    if (!SIBLING_METHODS.has(method)) {
      throw new TypeError(`sibling request: ${String(method)} is not one of GET, POST, PUT, PATCH, DELETE`);
    }
    const checked = checkedPath(path);
    if (this.#closed) {
      return { kind: 'unavailable', message: `the call to ${this.tool.name} is over` };
    }
    return this.#connector.request(
      this.#fleetTool,
      this.#key,
      this.workspaceId,
      method,
      checked,
      opts.body,
      this.#budget
    );
  }

  toJSON(): { tool: { slug: string; name: string }; workspaceId: string } {
    return { tool: { ...this.tool }, workspaceId: this.workspaceId };
  }
}

export class SiblingCalls implements ToolSiblings {
  readonly declared: readonly string[];
  private readonly declaredSet: ReadonlySet<string>;
  private readonly person: () => PersonOfRequest | null;

  constructor(private readonly deps: SiblingCallsDeps) {
    this.declared = Object.freeze(deps.declared.map((d) => d.toolSlug));
    this.declaredSet = new Set(this.declared);
    this.person = deps.person ?? personOfRequest;
  }

  async call<T>(toolSlug: string, work: SiblingWork<T>): Promise<SiblingCallOutcome<T>> {
    if (!this.declaredSet.has(toolSlug)) {
      return {
        kind: 'sibling_not_declared',
        message: `This tool declares no sibling named "${String(toolSlug)}"`
      };
    }
    const connector = this.deps.connector;
    if (!connector) {
      return {
        kind: 'not_on_hub',
        message: 'This instance is not on an Antasphere hub, so it has no sibling tool to act on'
      };
    }
    const person = this.person();
    if (!person) {
      return {
        kind: 'no_person',
        message: 'A sibling is called as the person of a request, and this code runs outside one'
      };
    }
    const outcome = await this.converse(connector, toolSlug, person, work);
    const level = outcome.kind === 'ok' ? 'info' : 'warn';
    this.deps.logger[level](
      { sibling: toolSlug, outcome: outcome.kind, via: person.via },
      'siblings: a call as the person ended'
    );
    return outcome;
  }

  private async converse<T>(
    connector: SiblingConnector,
    toolSlug: string,
    person: PersonOfRequest,
    work: SiblingWork<T>
  ): Promise<SiblingCallOutcome<T>> {
    const tool = connector.resolve(toolSlug);
    if (!tool) {
      if (!connector.fleetRead()) {
        return { kind: 'unavailable', message: 'the hub has not answered the fleet list yet' };
      }
      return { kind: 'sibling_unknown', message: `The hub lists no tool named "${toolSlug}" in its fleet` };
    }
    let centralAccountId: string | null;
    try {
      centralAccountId = await this.deps.centralAccountOf(person.workspaceId);
    } catch (err) {
      this.deps.logger.warn({ err, sibling: toolSlug }, 'siblings: the workspace could not be read');
      return { kind: 'unavailable', message: 'the workspace could not be read' };
    }
    if (!centralAccountId) return { kind: 'sibling_workspace_missing' };

    const budget = connector.budget();
    const token = await connector.connectToken(person.userId, tool.resourceUrl, budget);
    if (token.kind !== 'ok') return token;
    return connector.withPersonKey(
      tool,
      token.value,
      async (key) => {
        const twin = await connector.workspaceOf(tool, key, centralAccountId, budget);
        if (twin.kind !== 'ok') return twin;
        const handle = new Handle(connector, tool, key, twin.value, budget);
        try {
          return await this.withinBudget(tool, budget, () => work(handle));
        } finally {
          handle.close();
        }
      },
      budget
    );
  }

  /** The work, cut at the call's deadline: past it the call answers `unavailable`, whatever the work still does. */
  private async withinBudget<T>(
    tool: FleetTool,
    budget: SiblingBudget,
    run: () => Promise<SiblingOutcome<T>>
  ): Promise<SiblingOutcome<T>> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<SiblingOutcome<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'unavailable', message: `the call to ${tool.name} took too long` }),
        Math.max(0, budget.deadlineAt - Date.now())
      );
    });
    const running = Promise.resolve().then(run);
    // A work abandoned at the deadline may still reject later: that is not an unhandled error of the process.
    running.catch(() => {});
    try {
      return await Promise.race([running, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
