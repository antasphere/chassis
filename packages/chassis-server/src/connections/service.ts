import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  connectionDeliveries,
  connections,
  user as userTable,
  type ConnectionDeliveryRow,
  type ConnectionRow,
  type Db
} from '@antasphere/chassis-db';
import type {
  Connection,
  ConnectionDelivery,
  ConnectionDeliveryOutcome,
  ConnectionFields,
  ConnectionFieldValue
} from '@antasphere/chassis-contract';
import { CONNECTION_HOOK_PATH } from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import { createSecretBox, SecretBoxError, type SecretBox } from '../secret-box.js';
import { createdAtText, decodeKeysetCursor, encodeKeysetCursor, keysetBeforeValue } from '../pagination.js';
import {
  declaredToWire,
  holdsKey,
  takesDeliveries,
  type ConnectionCatalogIndex,
  type ConnectionSourceDeclaration,
  type ConnectionVerifier
} from './catalog.js';
import { NAMED_VERIFIERS } from './verifiers.js';

/**
 * The connections of a workspace (PRDCT-3773): the generic machinery over the
 * tool's declared sources. Nothing here names a tool; the sources, their
 * handlers and their probes arrive through the catalog.
 *
 *  - The secret or key is sealed under the instance's auth secret (the
 *    chassis's secret box, info `chassis:connection`), never answered,
 *    logged, audited or exported; `readable` says whether it still opens.
 *  - The receiving URL carries a random token; only its SHA-256 is kept, so
 *    the URL is answered once, at its making or its rotation, and the
 *    previous URL answers 404 from then on.
 *  - The DOOR (`receive`): the source by key, the row by the token's hash
 *    (404 otherwise), the secret opened (401 `secret_not_set`), the named or
 *    custom verifier on the RAW body (401, nothing written), the body parsed
 *    (400), then ONE transaction: the delivery row taken by (workspace,
 *    source, the sender's id) (a repeat answers 200 `duplicate` and writes
 *    nothing; a delivery whose handler FAILED is taken again), the row's
 *    last delivery stamped, the handler run. A handler that throws rolls its
 *    writes back and the delivery is recorded `failed` outside the
 *    transaction, so the sender's retry runs it again.
 */

export const CONNECTION_SECRET_BOX_INFO = 'chassis:connection';
export const CONNECTION_DELIVERIES_PURGE_QUEUE = 'connection-deliveries-purge';
const MAX_ERROR_TEXT = 500;

export class ConnectionRefusedError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_inbound'
      | 'not_connected'
      | 'secret_invalid'
      | 'secret_refused'
      | 'source_unavailable'
      | 'unknown_field'
      | 'field_required',
    message: string
  ) {
    super(message);
    this.name = 'ConnectionRefusedError';
  }
}

export interface ConnectionServiceDeps<TDomain = unknown> {
  db: Db;
  logger: Logger;
  authSecret: string;
  /** `PUBLIC_BASE_URL`: the receiving URL is built on it. */
  publicBaseUrl: string;
  catalog: ConnectionCatalogIndex<TDomain>;
  /** The tool's `services` result, read lazily (a handler runs at request time). */
  getTool: () => TDomain | null;
  now?: () => Date;
}

/** Who acts: the principal's workspace and user. */
export interface ConnectionActor {
  workspaceId: string;
  userId: string;
}

/** What the door answers: a status and a short body naming no secret. */
export interface ConnectionReceipt {
  status: 200 | 400 | 401 | 404;
  body: {
    ok: boolean;
    code?: string;
    outcome?: ConnectionDeliveryOutcome;
    duplicate?: boolean;
    detail?: string;
  };
}

type Member = { id: string; name: string; email: string };
type ConnectionProbeOutcome = {
  ok: boolean;
  detail: string;
  fields?: Partial<Record<string, ConnectionFieldValue>> | undefined;
  unavailable?: boolean | undefined;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const iso = (d: Date) => d.toISOString();

export class ConnectionService<TDomain = unknown> {
  private readonly box: SecretBox;

  constructor(private readonly deps: ConnectionServiceDeps<TDomain>) {
    this.box = createSecretBox(deps.authSecret, CONNECTION_SECRET_BOX_INFO);
  }

  get catalog(): ConnectionCatalogIndex<TDomain> {
    return this.deps.catalog;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** The declared source, or a `not_found` refusal. */
  source(key: string): ConnectionSourceDeclaration<TDomain> {
    const source = this.deps.catalog.sources.get(key);
    if (!source) throw new ConnectionRefusedError('not_found', 'No such connection source');
    return source;
  }

  private async row(workspaceId: string, source: string): Promise<ConnectionRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(connections)
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.source, source)));
    return row ?? null;
  }

  private open(row: ConnectionRow | null): string | null {
    if (!row?.secretSealed) return null;
    try {
      return this.box.open(row.secretSealed);
    } catch (e) {
      if (e instanceof SecretBoxError) return null;
      throw e;
    }
  }

  /**
   * The secret opened, the migration hook tried when the box refuses (a
   * value a migration carried from before the slot): on its success the row
   * is re-sealed under the chassis's box, once.
   */
  private async openOrMigrate(
    source: ConnectionSourceDeclaration<TDomain>,
    row: ConnectionRow | null
  ): Promise<string | null> {
    const opened = this.open(row);
    if (opened !== null || !row?.secretSealed || !source.migrateSecret) return opened;
    let legacy: string | null;
    try {
      legacy = source.migrateSecret(row.secretSealed, { authSecret: this.deps.authSecret });
    } catch {
      legacy = null;
    }
    if (legacy === null) return null;
    await this.deps.db
      .update(connections)
      .set({ secretSealed: this.box.seal(legacy), updatedAt: this.now() })
      .where(and(eq(connections.id, row.id), eq(connections.secretSealed, row.secretSealed)));
    this.deps.logger.info(
      { source: source.key },
      'connections: a secret carried by a migration was re-sealed'
    );
    return legacy;
  }

  // ── What a tool reads of its own connections ──────────────────────────────

  /** The source's secret or key, opened, or null when none is set or it no longer opens. */
  async secretOf(workspaceId: string, key: string): Promise<string | null> {
    const source = this.source(key);
    return this.openOrMigrate(source, await this.row(workspaceId, key));
  }

  /** The stored fields of the source (empty when nothing is connected). */
  async fieldsOf(workspaceId: string, key: string): Promise<ConnectionFields> {
    this.source(key);
    return (await this.row(workspaceId, key))?.fields ?? {};
  }

  /** Fields the tool learned or changed itself, merged like a PATCH (undeclared keys refused). */
  async setFieldsOf(workspaceId: string, key: string, patch: ConnectionFields): Promise<ConnectionFields> {
    const source = this.source(key);
    const existing = await this.row(workspaceId, key);
    const fields = this.mergeFields(source, existing?.fields ?? {}, patch, { strict: true });
    if (existing) {
      await this.deps.db
        .update(connections)
        .set({ fields, updatedAt: this.now() })
        .where(eq(connections.id, existing.id));
    } else {
      await this.deps.db.insert(connections).values({ workspaceId, source: key, fields });
    }
    await this.fieldsChanged(source, workspaceId, fields);
    return fields;
  }

  /** A check the tool made itself (a sync's read of the source), kept as the card's last check. */
  async recordCheck(workspaceId: string, key: string, ok: boolean, detail: string): Promise<void> {
    this.source(key);
    const now = this.now();
    await this.deps.db
      .update(connections)
      .set({ checkedAt: now, checkOk: ok, checkDetail: detail.slice(0, MAX_ERROR_TEXT), updatedAt: now })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.source, key)));
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Every declared source with its state in the workspace, in the declared order. */
  async list(workspaceId: string): Promise<Connection[]> {
    const rows = await this.deps.db
      .select()
      .from(connections)
      .where(eq(connections.workspaceId, workspaceId));
    const byKey = new Map(rows.map((r) => [r.source, r]));
    const members = await this.members(rows);
    return [...this.deps.catalog.sources.values()].map((source) =>
      this.toWire(source, byKey.get(source.key) ?? null, members)
    );
  }

  async get(workspaceId: string, key: string): Promise<Connection> {
    const source = this.source(key);
    const row = await this.row(workspaceId, key);
    return this.toWire(source, row, await this.members(row ? [row] : []));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Make the receiving URL of an inbound source, or rotate it: a new random
   * token, its hash stored, the previous URL answering 404 from now on. The
   * secret and the fields stay. The URL is answered this once.
   */
  async connect(
    actor: ConnectionActor,
    key: string
  ): Promise<{ connection: Connection; receivingUrl: string }> {
    const source = this.source(key);
    if (!takesDeliveries(source.kind)) {
      throw new ConnectionRefusedError('not_inbound', 'A key source has no receiving URL');
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = this.now();
    await this.deps.db
      .insert(connections)
      .values({
        workspaceId: actor.workspaceId,
        source: key,
        tokenHash,
        urlMadeAt: now,
        urlMadeBy: actor.userId,
        connectedBy: actor.userId
      })
      .onConflictDoUpdate({
        target: [connections.workspaceId, connections.source],
        set: { tokenHash, urlMadeAt: now, urlMadeBy: actor.userId, updatedAt: now }
      });
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    return {
      connection: await this.get(actor.workspaceId, key),
      receivingUrl: `${base}${CONNECTION_HOOK_PATH}/${key}/${token}`
    };
  }

  /**
   * Store the secret or the key, sealed. An inbound source needs its URL made
   * first (`not_connected`); a value off the declared shape is `secret_invalid`;
   * a key source with a probe is probed first, and a refused key is
   * `secret_refused` (the detail is the source's), an unanswering source
   * `source_unavailable`; a probe's fields are stored with the key.
   */
  async setSecret(actor: ConnectionActor, key: string, secret: string): Promise<Connection> {
    const source = this.source(key);
    if (source.secretPattern && !source.secretPattern.test(secret)) {
      throw new ConnectionRefusedError(
        'secret_invalid',
        source.secretHint
          ? `The secret does not look like ${source.secretHint}`
          : 'The secret has not the expected shape'
      );
    }
    const existing = await this.row(actor.workspaceId, key);
    if (source.kind === 'inbound' && !existing?.tokenHash) {
      throw new ConnectionRefusedError('not_connected', 'Make the receiving URL first');
    }
    let learned: Partial<Record<string, ConnectionFieldValue>> = {};
    let check: { ok: boolean; detail: string } | null = null;
    if (holdsKey(source.kind) && source.probe) {
      const probed = await this.runProbe(source, actor.workspaceId, secret, existing?.fields ?? {});
      if (probed.unavailable) {
        throw new ConnectionRefusedError('source_unavailable', probed.detail || 'The source did not answer');
      }
      if (!probed.ok) {
        throw new ConnectionRefusedError('secret_refused', probed.detail || 'The source refused the key');
      }
      learned = probed.fields ?? {};
      check = { ok: true, detail: probed.detail };
    }
    const now = this.now();
    const fields = this.mergeFields(source, existing?.fields ?? {}, learned);
    await this.deps.db
      .insert(connections)
      .values({
        workspaceId: actor.workspaceId,
        source: key,
        secretSealed: this.box.seal(secret),
        secretSetAt: now,
        secretSetBy: actor.userId,
        connectedBy: actor.userId,
        fields,
        ...(check ? { checkedAt: now, checkOk: check.ok, checkDetail: check.detail } : {})
      })
      .onConflictDoUpdate({
        target: [connections.workspaceId, connections.source],
        set: {
          secretSealed: this.box.seal(secret),
          secretSetAt: now,
          secretSetBy: actor.userId,
          fields,
          updatedAt: now,
          ...(check ? { checkedAt: now, checkOk: check.ok, checkDetail: check.detail } : {})
        }
      });
    return this.get(actor.workspaceId, key);
  }

  /** Store the declared fields: a key absent keeps its value, null clears it; an undeclared key is refused. */
  async setFields(actor: ConnectionActor, key: string, patch: ConnectionFields): Promise<Connection> {
    const source = this.source(key);
    const existing = await this.row(actor.workspaceId, key);
    if (!existing) throw new ConnectionRefusedError('not_connected', 'Connect the source first');
    const fields = this.mergeFields(source, existing.fields, patch, { strict: true });
    await this.deps.db
      .update(connections)
      .set({ fields, updatedAt: this.now() })
      .where(eq(connections.id, existing.id));
    await this.fieldsChanged(source, actor.workspaceId, fields);
    return this.get(actor.workspaceId, key);
  }

  /** The tool's hook after a change of the stored fields; a hook that throws is logged and the change stands. */
  private async fieldsChanged(
    source: ConnectionSourceDeclaration<TDomain>,
    workspaceId: string,
    fields: ConnectionFields
  ): Promise<void> {
    if (!source.onFieldsChanged) return;
    try {
      await source.onFieldsChanged({
        workspaceId,
        source: source.key,
        fields,
        logger: this.deps.logger,
        tool: this.deps.getTool
      });
    } catch (e) {
      this.deps.logger.warn({ err: e, source: source.key }, 'connections: the fields hook threw');
    }
  }

  /** The row and its deliveries are gone; the declared source stays on the page, disconnected. */
  async disconnect(actor: ConnectionActor, key: string): Promise<Connection> {
    this.source(key);
    await this.deps.db
      .delete(connections)
      .where(and(eq(connections.workspaceId, actor.workspaceId), eq(connections.source, key)));
    return this.get(actor.workspaceId, key);
  }

  /**
   * The test: a key source is probed with the stored key; an inbound source
   * checks that its URL is made and its secret opens. The result is kept as
   * the last check and answered.
   */
  async test(
    actor: ConnectionActor,
    key: string
  ): Promise<{ ok: boolean; detail: string; connection: Connection }> {
    const source = this.source(key);
    const row = await this.row(actor.workspaceId, key);
    if (!row) throw new ConnectionRefusedError('not_connected', 'Nothing to test yet');
    const secret = await this.openOrMigrate(source, row);
    let ok: boolean;
    let detail: string;
    if (holdsKey(source.kind) && source.probe) {
      if (secret === null) {
        ok = false;
        detail = row.secretSealed ? 'The stored key no longer opens: set it again' : 'No key is set';
      } else {
        const probed = await this.runProbe(source, actor.workspaceId, secret, row.fields);
        ok = probed.ok;
        detail = probed.detail;
        if (probed.ok && probed.fields) {
          await this.deps.db
            .update(connections)
            .set({ fields: this.mergeFields(source, row.fields, probed.fields) })
            .where(eq(connections.id, row.id));
        }
      }
    } else if (takesDeliveries(source.kind)) {
      if (!row.tokenHash) {
        ok = false;
        detail = 'The receiving URL is not made yet';
      } else if (secret === null) {
        ok = false;
        detail = row.secretSealed
          ? 'The stored secret no longer opens: set it again'
          : 'The signing secret is not set';
      } else {
        ok = true;
        detail = row.lastDeliveryAt
          ? `Ready: the last delivery was ${row.lastDeliveryType ?? 'unknown'} at ${iso(row.lastDeliveryAt)}`
          : 'Ready: the URL is made and the secret set; no delivery received yet';
      }
    } else {
      ok = secret !== null;
      detail = ok
        ? 'The key is set'
        : row.secretSealed
          ? 'The stored key no longer opens: set it again'
          : 'No key is set';
    }
    await this.deps.db
      .update(connections)
      .set({ checkedAt: this.now(), checkOk: ok, checkDetail: detail, updatedAt: this.now() })
      .where(eq(connections.id, row.id));
    return { ok, detail, connection: await this.get(actor.workspaceId, key) };
  }

  private async runProbe(
    source: ConnectionSourceDeclaration<TDomain>,
    workspaceId: string,
    secret: string,
    fields: ConnectionFields
  ): Promise<ConnectionProbeOutcome> {
    try {
      const result = await source.probe!({
        workspaceId,
        secret,
        fields,
        logger: this.deps.logger,
        tool: this.deps.getTool
      });
      return { ok: result.ok, detail: result.detail, fields: result.fields, unavailable: result.unavailable };
    } catch (e) {
      this.deps.logger.warn({ err: e, source: source.key }, 'connections: the probe threw');
      return { ok: false, detail: 'The probe failed', unavailable: true };
    }
  }

  private mergeFields(
    source: ConnectionSourceDeclaration<TDomain>,
    current: ConnectionFields,
    patch: Partial<Record<string, ConnectionFieldValue>>,
    opts: { strict?: boolean } = {}
  ): ConnectionFields {
    const declared = new Map((source.fields ?? []).map((f) => [f.key, f]));
    const next: ConnectionFields = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      const field = declared.get(k);
      if (!field) {
        if (opts.strict)
          throw new ConnectionRefusedError('unknown_field', `"${k}" is not a field of this source`);
        continue;
      }
      if (v === undefined) continue;
      if (v === null) {
        delete next[k];
        continue;
      }
      next[k] = field.multiple ? (Array.isArray(v) ? v : [v]) : Array.isArray(v) ? (v[0] ?? '') : v;
    }
    if (opts.strict) {
      for (const field of source.fields ?? []) {
        if (field.required && (next[field.key] === undefined || next[field.key] === '')) {
          throw new ConnectionRefusedError('field_required', `"${field.key}" is required`);
        }
      }
    }
    return next;
  }

  // ── The door ──────────────────────────────────────────────────────────────

  async receive(
    key: string,
    token: string,
    header: (name: string) => string | undefined,
    rawBody: string
  ): Promise<ConnectionReceipt> {
    const source = this.deps.catalog.sources.get(key);
    if (!source || !takesDeliveries(source.kind))
      return { status: 404, body: { ok: false, code: 'not_found' } };
    const [row] = await this.deps.db
      .select()
      .from(connections)
      .where(and(eq(connections.source, key), eq(connections.tokenHash, hashToken(token))));
    if (!row) return { status: 404, body: { ok: false, code: 'not_found' } };
    const secret = await this.openOrMigrate(source, row);
    if (secret === null) return { status: 401, body: { ok: false, code: 'secret_not_set' } };
    const verifier: ConnectionVerifier =
      typeof source.verifier === 'function'
        ? source.verifier
        : NAMED_VERIFIERS[source.verifier ?? 'standard-webhooks'];
    const verdict = await verifier({
      secret,
      header,
      rawBody,
      nowSeconds: Math.floor(this.now().getTime() / 1000)
    });
    if (!verdict.ok) return { status: 401, body: { ok: false, code: verdict.code } };

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return { status: 400, body: { ok: false, code: 'invalid_json' } };
    }
    const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const idFromBody = typeof body?.id === 'string' && body.id !== '' ? body.id : null;
    const deliveryId = (verdict.id ?? idFromBody)?.slice(0, 200);
    if (!deliveryId) return { status: 400, body: { ok: false, code: 'invalid_event' } };
    const type = typeof body?.type === 'string' && body.type !== '' ? body.type.slice(0, 100) : 'unknown';
    const workspaceId = row.workspaceId;
    const isPing = type === 'webhook.ping';

    // One transaction: the dedupe row, the stamp, the handler.
    type Outcome =
      { kind: 'duplicate' } | { kind: 'done'; outcome: ConnectionDeliveryOutcome; detail: string | null };
    let failure: string | null = null;
    let result: Outcome;
    try {
      result = await this.deps.db.transaction(async (tx): Promise<Outcome> => {
        const [taken] = await tx
          .insert(connectionDeliveries)
          .values({ connectionId: row.id, workspaceId, source: key, deliveryId, type, outcome: 'ignored' })
          .onConflictDoNothing()
          .returning({ id: connectionDeliveries.id });
        let deliveryRowId = taken?.id ?? null;
        if (!deliveryRowId) {
          // A repeat of a delivery already taken: 200, nothing written, unless the handler had failed.
          const [previous] = await tx
            .select({ id: connectionDeliveries.id, outcome: connectionDeliveries.outcome })
            .from(connectionDeliveries)
            .where(
              and(
                eq(connectionDeliveries.workspaceId, workspaceId),
                eq(connectionDeliveries.source, key),
                eq(connectionDeliveries.deliveryId, deliveryId)
              )
            );
          if (!previous || previous.outcome !== 'failed') return { kind: 'duplicate' };
          deliveryRowId = previous.id;
        }
        let outcome: ConnectionDeliveryOutcome = 'ignored';
        let detail: string | null = null;
        if (!isPing && source.handler) {
          const answered = await source.handler({
            tx,
            workspaceId,
            source: key,
            delivery: { id: deliveryId, type, payload, rawBody },
            fields: row.fields,
            logger: this.deps.logger,
            tool: this.deps.getTool
          });
          outcome = 'processed';
          detail = answered?.detail?.slice(0, MAX_ERROR_TEXT) ?? null;
        }
        const now = this.now();
        await tx
          .update(connectionDeliveries)
          .set({ outcome, detail, error: null, receivedAt: now })
          .where(eq(connectionDeliveries.id, deliveryRowId));
        await tx
          .update(connections)
          .set({ lastDeliveryAt: now, lastDeliveryType: type, lastDeliveryOutcome: outcome, updatedAt: now })
          .where(eq(connections.id, row.id));
        return { kind: 'done', outcome, detail };
      });
    } catch (e) {
      failure = String((e as Error).message ?? e).slice(0, MAX_ERROR_TEXT);
      this.deps.logger.warn({ err: e, source: key, type }, 'connections: a delivery handler failed');
      // Recorded outside the rolled-back transaction: the log shows the failure, and the sender's retry runs again.
      const now = this.now();
      await this.deps.db
        .insert(connectionDeliveries)
        .values({
          connectionId: row.id,
          workspaceId,
          source: key,
          deliveryId,
          type,
          outcome: 'failed',
          error: failure
        })
        .onConflictDoUpdate({
          target: [
            connectionDeliveries.workspaceId,
            connectionDeliveries.source,
            connectionDeliveries.deliveryId
          ],
          set: { outcome: 'failed', error: failure, receivedAt: now }
        });
      await this.deps.db
        .update(connections)
        .set({ lastDeliveryAt: now, lastDeliveryType: type, lastDeliveryOutcome: 'failed', updatedAt: now })
        .where(eq(connections.id, row.id));
      return { status: 200, body: { ok: false, code: 'handler_failed', outcome: 'failed' } };
    }
    if (result.kind === 'duplicate') return { status: 200, body: { ok: true, duplicate: true } };
    return {
      status: 200,
      body: { ok: true, outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}) }
    };
  }

  // ── The log ───────────────────────────────────────────────────────────────

  async listDeliveries(
    workspaceId: string,
    key: string,
    query: { cursor?: string | undefined; limit: number }
  ): Promise<{ deliveries: ConnectionDelivery[]; nextCursor: string | null }> {
    this.source(key);
    const after = decodeKeysetCursor(query.cursor);
    const rows = await this.deps.db
      .select({ row: connectionDeliveries, createdAtText: createdAtText(connectionDeliveries.receivedAt) })
      .from(connectionDeliveries)
      .where(
        and(
          eq(connectionDeliveries.workspaceId, workspaceId),
          eq(connectionDeliveries.source, key),
          ...(after
            ? [
                keysetBeforeValue({
                  id: connectionDeliveries.id,
                  createdAt: connectionDeliveries.receivedAt,
                  cursor: after
                })
              ]
            : [])
        )
      )
      .orderBy(desc(connectionDeliveries.receivedAt), desc(connectionDeliveries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      deliveries: page.map((r) => deliveryToWire(r.row)),
      nextCursor: last ? encodeKeysetCursor({ id: last.row.id, createdAtText: last.createdAtText }) : null
    };
  }

  /** Deliveries older than the retention are deleted in batches; the rows' count. */
  async purge(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const BATCH = 5000;
    let total = 0;
    for (;;) {
      const res = await this.deps.db.execute(sql`
        DELETE FROM connection_deliveries WHERE id IN (
          SELECT id FROM connection_deliveries
          WHERE received_at < now() - make_interval(days => ${retentionDays})
          ORDER BY received_at
          LIMIT ${BATCH}
        )
      `);
      const deleted = res.rowCount ?? 0;
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  }

  // ── The wire ──────────────────────────────────────────────────────────────

  private async members(rows: ConnectionRow[]): Promise<Map<string, Member>> {
    const ids = new Set<string>();
    for (const r of rows) for (const id of [r.urlMadeBy, r.secretSetBy, r.connectedBy]) if (id) ids.add(id);
    if (ids.size === 0) return new Map();
    const named = await this.deps.db
      .select({ id: userTable.id, name: userTable.name, email: userTable.email })
      .from(userTable)
      .where(inArray(userTable.id, [...ids]));
    return new Map(named.map((u) => [u.id, u]));
  }

  /** Whether the migration hook opens the row's value (read-only: the re-seal happens on the first use). */
  private migratable(source: ConnectionSourceDeclaration<TDomain>, row: ConnectionRow | null): boolean {
    if (!row?.secretSealed || !source.migrateSecret) return false;
    try {
      return source.migrateSecret(row.secretSealed, { authSecret: this.deps.authSecret }) !== null;
    } catch {
      return false;
    }
  }

  private toWire(
    source: ConnectionSourceDeclaration<TDomain>,
    row: ConnectionRow | null,
    members: Map<string, Member>
  ): Connection {
    const who = (id: string | null | undefined) => (id ? (members.get(id) ?? null) : null);
    const set = row?.secretSealed != null;
    const readable = set && (this.open(row) !== null || this.migratable(source, row));
    const url =
      row?.tokenHash && row.urlMadeAt ? { madeAt: iso(row.urlMadeAt), madeBy: who(row.urlMadeBy) } : null;
    return {
      source: source.key,
      name: source.name,
      kind: source.kind,
      declared: declaredToWire(source),
      connected: set && (source.kind === 'key' || url !== null),
      receiving: url,
      secretState: {
        set,
        readable,
        setAt: row?.secretSetAt ? iso(row.secretSetAt) : null,
        setBy: set ? who(row?.secretSetBy) : null
      },
      fields: row?.fields ?? {},
      connectedAt: row ? iso(row.createdAt) : null,
      connectedBy: who(row?.connectedBy),
      lastDelivery:
        row?.lastDeliveryAt && row.lastDeliveryType && row.lastDeliveryOutcome
          ? { at: iso(row.lastDeliveryAt), type: row.lastDeliveryType, outcome: row.lastDeliveryOutcome }
          : null,
      check:
        row?.checkedAt && row.checkOk !== null
          ? { at: iso(row.checkedAt), ok: row.checkOk, detail: row.checkDetail }
          : null,
      sibling: source.sibling ? { endpointId: row?.siblingEndpointId ?? null } : null
    };
  }
}

/** The service with its domain parameter erased: what the door, the routes and the jobs take (they never call a handler). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConnectionService = ConnectionService<any>;

export function deliveryToWire(row: ConnectionDeliveryRow): ConnectionDelivery {
  return {
    id: row.id,
    source: row.source,
    deliveryId: row.deliveryId,
    type: row.type,
    receivedAt: row.receivedAt.toISOString(),
    outcome: row.outcome,
    detail: row.detail,
    error: row.error
  };
}
