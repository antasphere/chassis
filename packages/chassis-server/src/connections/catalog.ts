import type { DbConn } from '@antasphere/chassis-db';
import type {
  ConnectionDeclared,
  ConnectionFields,
  ConnectionFieldValue,
  ConnectionKind
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';

/**
 * The connections catalog (PRDCT-3773): what a tool declares through the
 * `connections` slot of its definition, checked once at boot. A SOURCE is
 * something the tool connects to: an INBOUND one posts signed deliveries to
 * this instance's door (`POST /hooks/<source>/<token>`), a KEY one is a key
 * this instance holds and presents, `both` is both. The chassis stores the
 * secret sealed, the token hashed, the declared fields and the delivery log,
 * and serves the page, the CLI and the MCP tools; what a delivery MEANS stays
 * the tool's (`handler`), as does what a key is good for (`probe`).
 */

/** The verifiers the chassis knows by name. */
export type ConnectionVerifierName = 'standard-webhooks' | 'stripe';

export interface ConnectionVerifierContext {
  /** The stored secret, opened. */
  secret: string;
  /** A request header, lower-cased name. */
  header: (name: string) => string | undefined;
  /** The body exactly as received: what the signature covers. */
  rawBody: string;
  nowSeconds: number;
}

export type ConnectionVerifierVerdict =
  | {
      ok: true;
      /** The sender's own id of the delivery, when the scheme carries it in a header; else the body's `id`. */
      id?: string | undefined;
    }
  | { ok: false; code: 'missing_headers' | 'invalid_signature' };

/** A tool's own verifier: the signature scheme of a source the chassis does not know. */
export type ConnectionVerifier = (
  ctx: ConnectionVerifierContext
) => ConnectionVerifierVerdict | Promise<ConnectionVerifierVerdict>;

/** One declared field of a source: a value the page and the CLI show and set, never a secret. */
export interface ConnectionFieldDeclaration {
  /** `folder`, `inboxes`: lowercase, digits and underscores. */
  key: string;
  label: string;
  description?: string | undefined;
  required?: boolean | undefined;
  /** The value is a list of strings. */
  multiple?: boolean | undefined;
}

/** What a handler receives: inside the delivery's transaction, after the dedupe row is written. */
export interface ConnectionDeliveryContext<TDomain = unknown> {
  tx: DbConn;
  workspaceId: string;
  source: string;
  delivery: {
    /** The sender's own id (the dedupe key). */
    id: string;
    type: string;
    /** The parsed JSON body. */
    payload: unknown;
    rawBody: string;
  };
  fields: ConnectionFields;
  logger: Logger;
  /** The tool's `services` result, or null before that slot has run. */
  tool: () => TDomain | null;
}

/** What a handler may answer: a detail the delivery log keeps. */
export interface ConnectionDeliveryResult {
  detail?: string | undefined;
}

/** What a probe receives: the key as stored (opened), the fields, the tool. */
export interface ConnectionProbeContext<TDomain = unknown> {
  workspaceId: string;
  secret: string;
  fields: ConnectionFields;
  logger: Logger;
  tool: () => TDomain | null;
}

/** What `onFieldsChanged` receives: the fields as stored after the change. */
export interface ConnectionFieldsChangedContext<TDomain = unknown> {
  workspaceId: string;
  source: string;
  fields: ConnectionFields;
  logger: Logger;
  tool: () => TDomain | null;
}

/** What a probe answers: whether the source accepted the key, what it said, and fields it learned (a team's name). */
export interface ConnectionProbeResult {
  ok: boolean;
  detail: string;
  fields?: Partial<Record<string, ConnectionFieldValue>> | undefined;
  /** The source did not answer (a 502 rather than a refusal). */
  unavailable?: boolean | undefined;
}

export interface ConnectionSourceDeclaration<TDomain = unknown> {
  /** `meet`, `lemlist`: lowercase, digits and underscores; unique in the tool. */
  key: string;
  /** The name the card shows (`Antasphere Meet`). */
  name: string;
  description?: string | undefined;
  kind: ConnectionKind;
  /** An inbound source's signature scheme; `standard-webhooks` when absent. */
  verifier?: ConnectionVerifierName | ConnectionVerifier | undefined;
  /** The event types the source sends; informative, shown on the card. */
  events?: readonly string[] | undefined;
  /** What the secret looks like (`whsec_…`), for the form's placeholder. */
  secretHint?: string | undefined;
  /** The shape a secret must have; a value off it is refused before it is stored. */
  secretPattern?: RegExp | undefined;
  fields?: readonly ConnectionFieldDeclaration[] | undefined;
  /** What a verified, deduplicated delivery does; absent, every delivery is recorded as `ignored`. */
  handler?:
    ((ctx: ConnectionDeliveryContext<TDomain>) => Promise<ConnectionDeliveryResult | void>) | undefined;
  /** How a key is checked against the source, at set and at test; absent, a key is stored unchecked. */
  probe?: ((ctx: ConnectionProbeContext<TDomain>) => Promise<ConnectionProbeResult>) | undefined;
  /**
   * Called after the stored fields changed through the page, the CLI, an
   * agent or the tool itself (a folder picked anew, inboxes chosen), with the
   * fields as stored: what the tool resets or re-reads when they do (a
   * sync's resume point). Not called when a probe fills fields at a key's set.
   */
  onFieldsChanged?: ((ctx: ConnectionFieldsChangedContext<TDomain>) => Promise<void>) | undefined;
  /** The source is a sibling tool of the same hub (PRDCT-3774): its registry slug and the events to subscribe. */
  sibling?: { toolSlug: string; events: readonly string[] } | undefined;
  /**
   * A sealed value carried by a migration from a table the tool kept before
   * the slot (sealed under another box): how to open it. The chassis tries
   * it when its own box refuses, and re-seals the value under its box on
   * the first success, so the row heals on its first use and the hook can
   * go in a later release. Null: the value does not open. `authSecret` is
   * the instance's, so a declaration (static, written before boot) can open
   * a value sealed under a box derived from it.
   */
  migrateSecret?: ((sealed: string, ctx: { authSecret: string }) => string | null) | undefined;
}

/** The `connections` slot of a tool definition. */
export interface ConnectionCatalogDeclaration<TDomain = unknown> {
  sources: readonly ConnectionSourceDeclaration<TDomain>[];
}

export interface ConnectionCatalogIndex<TDomain = unknown> {
  /** By key, in the declared order. */
  sources: Map<string, ConnectionSourceDeclaration<TDomain>>;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const VERIFIER_NAMES: readonly ConnectionVerifierName[] = ['standard-webhooks', 'stripe'];

/** Whether a source takes deliveries at the door. */
export const takesDeliveries = (kind: ConnectionKind): boolean => kind !== 'key';
/** Whether a source holds a key the tool presents (a probe makes sense). */
export const holdsKey = (kind: ConnectionKind): boolean => kind !== 'inbound';

/** The catalog, checked: a bad declaration stops the boot naming the source. */
export function buildConnectionCatalog<TDomain>(
  declaration: ConnectionCatalogDeclaration<TDomain> | undefined
): ConnectionCatalogIndex<TDomain> {
  const sources = new Map<string, ConnectionSourceDeclaration<TDomain>>();
  for (const source of declaration?.sources ?? []) {
    if (!KEY.test(source.key)) {
      throw new Error(
        `connections: the source key "${source.key}" is not lowercase letters, digits and underscores`
      );
    }
    if (sources.has(source.key)) throw new Error(`connections: the source "${source.key}" is declared twice`);
    if (!source.name || source.name.trim() === '') {
      throw new Error(`connections: the source "${source.key}" has no name`);
    }
    if (source.kind !== 'inbound' && source.kind !== 'key' && source.kind !== 'both') {
      throw new Error(`connections: the source "${source.key}" has an unknown kind "${String(source.kind)}"`);
    }
    if (typeof source.verifier === 'string' && !VERIFIER_NAMES.includes(source.verifier)) {
      throw new Error(
        `connections: the source "${source.key}" names an unknown verifier "${source.verifier}"`
      );
    }
    if (source.verifier !== undefined && !takesDeliveries(source.kind)) {
      throw new Error(`connections: the source "${source.key}" is a key source and declares a verifier`);
    }
    if (source.handler !== undefined && !takesDeliveries(source.kind)) {
      throw new Error(`connections: the source "${source.key}" is a key source and declares a handler`);
    }
    if (source.probe !== undefined && !holdsKey(source.kind)) {
      throw new Error(`connections: the source "${source.key}" is an inbound source and declares a probe`);
    }
    const seen = new Set<string>();
    for (const field of source.fields ?? []) {
      if (!KEY.test(field.key)) {
        throw new Error(`connections: the field "${field.key}" of "${source.key}" is not a lowercase key`);
      }
      if (seen.has(field.key))
        throw new Error(`connections: the field "${field.key}" of "${source.key}" is declared twice`);
      seen.add(field.key);
    }
    sources.set(source.key, source);
  }
  return { sources };
}

/** The declared, static half of a source as the wire shows it. */
export function declaredToWire<TDomain>(source: ConnectionSourceDeclaration<TDomain>): ConnectionDeclared {
  return {
    description: source.description ?? null,
    verifier: takesDeliveries(source.kind)
      ? typeof source.verifier === 'function'
        ? 'custom'
        : (source.verifier ?? 'standard-webhooks')
      : null,
    events: [...(source.events ?? [])],
    secretHint: source.secretHint ?? null,
    fields: (source.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      description: f.description ?? null,
      required: f.required ?? false,
      multiple: f.multiple ?? false
    })),
    sibling: source.sibling ? { toolSlug: source.sibling.toolSlug, events: [...source.sibling.events] } : null
  };
}
