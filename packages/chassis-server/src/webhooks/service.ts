import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { Counter } from 'prom-client';
import {
  user as userTable,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
  type Db,
  type DbConn,
  type WebhookDeliveryRow,
  type WebhookEndpointRow
} from '@antasphere/chassis-db';
import type {
  ToolIdentity,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreate,
  WebhookEndpointUpdate
} from '@antasphere/chassis-contract';
import type { Logger } from '../logger.js';
import type { EmailDriver } from '../email/driver.js';
import type { MailBrand } from '../email/shell.js';
import type { EventBus } from '../platform/events.js';
import { createSecretBox, type SecretBox } from '../secret-box.js';
import { createdAtText, decodeKeysetCursor, encodeKeysetCursor, keysetBeforeValue } from '../pagination.js';
import { WEBHOOK_PING_EVENT, type WebhookCatalogIndex, type WebhookSubjectValue } from './catalog.js';
import { endpointWants } from './match.js';
import { buildWebhookDisabledEmail } from './mail.js';
import {
  checkWebhookUrl,
  safePost,
  WebhookUrlRefusedError,
  type SafeFetchOptions,
  type SafeFetchPolicy
} from './safe-fetch.js';
import { generateWebhookSecret, webhookHeaders } from './signing.js';
import { sendInTx } from './tx-send.js';

/**
 * Outbound webhooks (PRDCT-3482): the chassis's machinery, tool-neutral.
 *
 * EMIT: a domain write calls `emit(tx, …)` INSIDE its own transaction; one
 * pg-boss job (the event's envelope) is written by the same connection, so
 * the event is durable with the write and never exists for a rolled-back
 * one. A per-replica cache of "does any enabled endpoint of this workspace
 * want this type" (`listenerTtlMs`) makes an emit nobody listens to cost
 * one map lookup: a view with no endpoint costs no job.
 *
 * FAN-OUT (`webhook-events`): the event is matched against the workspace's
 * enabled endpoints (type, then filters); one `webhook_deliveries` row and
 * one delivery job per match, in one transaction.
 *
 * DELIVERY (`webhook-deliveries`): the envelope is signed (Standard
 * Webhooks, two signatures during a rotation overlap) and POSTed through the
 * guarded fetch. A 2xx is `delivered`; anything else fails the job, which
 * pg-boss retries on the queue's budget (ten retries from thirty seconds,
 * about eight and a half hours), then moves to `webhook-deliveries-held`:
 * the row is marked `held`, logged, counted, and re-driven every hour until
 * the receiver takes it or the endpoint is disabled. A streak of
 * `disableAfterFailures` failures spanning `disableAfterMs` switches the
 * endpoint off and mails its creator once.
 *
 * The secret is stored sealed (`secret-box.ts`, info `chassis:webhook-endpoint`)
 * and shown once, at creation and at rotation.
 */

export const WEBHOOK_EVENTS_QUEUE = 'webhook-events';
export const WEBHOOK_DELIVERIES_QUEUE = 'webhook-deliveries';
export const WEBHOOK_DELIVERIES_HELD_QUEUE = 'webhook-deliveries-held';
export const WEBHOOK_PURGE_QUEUE = 'webhook-purge';
/** The HKDF info of the endpoints' secret box: never the idempotency one. */
export const WEBHOOK_SECRET_BOX_INFO = 'chassis:webhook-endpoint';

export interface WebhookDials {
  /** Delivery retries before a hold (pg-boss `retryLimit`). */
  retryLimit: number;
  /** The first retry's delay in seconds, doubled each time. */
  retryDelaySeconds: number;
  /** How long a held delivery waits before its next round. */
  heldDelaySeconds: number;
  /** The failure streak that switches an endpoint off… */
  disableAfterFailures: number;
  /** …once it has lasted this long. */
  disableAfterMs: number;
  /** How long "anyone listening?" is remembered per workspace and replica. */
  listenerTtlMs: number;
  /** How long the previous secret keeps signing after a rotation. */
  previousSecretOverlapMs: number;
  /** The guarded fetch's timeout. */
  timeoutMs: number;
}

export const DEFAULT_WEBHOOK_DIALS: WebhookDials = {
  retryLimit: 10,
  retryDelaySeconds: 30,
  heldDelaySeconds: 3600,
  disableAfterFailures: 20,
  disableAfterMs: 2 * 24 * 3600 * 1000,
  listenerTtlMs: 30_000,
  previousSecretOverlapMs: 24 * 3600 * 1000,
  timeoutMs: 10_000
};

/** What `emit` takes: the workspace, the type, the subjects by KEY, the data. */
export interface WebhookEmit {
  workspaceId: string;
  type: string;
  subjects?: Readonly<Record<string, WebhookSubjectValue>>;
  data: Record<string, unknown>;
}

/** The job the fan-out queue carries: the event as the envelope will say it (minus `attempt`). */
export interface WebhookEventJob {
  id: string;
  type: string;
  occurredAt: string;
  workspaceId: string;
  /** By subject KEY (`project`), the envelope writes them under each subject's FIELD. */
  subjects: Record<string, WebhookSubjectValue>;
  data: Record<string, unknown>;
}

export interface WebhookDeliveryJob {
  deliveryId: string;
}

/** The emitter a tool's services receive (`ServiceCore.webhooks`). */
export interface WebhookEmitter {
  /**
   * Record that something happened, inside the caller's transaction (or on
   * a plain handle, for a write the chassis does not own). Answers the
   * event id, or null when no endpoint of the workspace listens to the type,
   * or the data does not match the declared schema (logged, never thrown:
   * a webhook must never break the write it reports).
   */
  emit(conn: DbConn, event: WebhookEmit): Promise<string | null>;
}

export interface WebhookServiceDeps {
  db: Db;
  logger: Logger;
  authSecret: string;
  identity: ToolIdentity;
  version: string;
  policy: SafeFetchPolicy;
  email: EmailDriver;
  brand: MailBrand;
  publicBaseUrl: string;
  catalog: WebhookCatalogIndex;
  dials?: Partial<WebhookDials> | undefined;
  /** Test seams of the guarded fetch (a lookup, a transport). */
  fetchOptions?: SafeFetchOptions | undefined;
  now?: () => Date;
}

export class WebhookRefusedError extends Error {
  constructor(
    readonly code: 'url_refused' | 'not_found',
    message: string
  ) {
    super(message);
    this.name = 'WebhookRefusedError';
  }
}

/** Thrown by a retryable attempt that failed, so pg-boss retries the job. */
export class WebhookDeliveryFailed extends Error {
  constructor(
    readonly deliveryId: string,
    message: string
  ) {
    super(message);
    this.name = 'WebhookDeliveryFailed';
  }
}

type Listeners = { at: number; patterns: string[][] };

const MAX_ERROR_TEXT = 300;

export class WebhookService implements WebhookEmitter {
  readonly dials: WebhookDials;
  readonly promMetrics: Counter<string>[];
  private readonly box: SecretBox;
  private readonly listeners = new Map<string, Listeners>();
  private readonly deliveries: Counter<string>;
  private readonly held: Counter<string>;
  private readonly disabled: Counter<string>;
  private readonly now: () => Date;
  /** Filled by boot once pg-boss exists (`attach`); the jobs are declared before it. */
  private boss: PgBoss | null = null;

  constructor(private readonly deps: WebhookServiceDeps) {
    this.dials = { ...DEFAULT_WEBHOOK_DIALS, ...deps.dials };
    this.box = createSecretBox(deps.authSecret, WEBHOOK_SECRET_BOX_INFO);
    this.now = deps.now ?? (() => new Date());
    this.deliveries = new Counter({
      name: 'webhook_delivery_attempts_total',
      help: 'Webhook delivery attempts by outcome: delivered, failed (will retry), refused (the endpoint off or the address refused)',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.held = new Counter({
      name: 'webhook_deliveries_held_total',
      help: 'Webhook deliveries that ran out of retries and were held for an hourly re-drive',
      registers: []
    });
    this.disabled = new Counter({
      name: 'webhook_endpoints_disabled_total',
      help: 'Webhook endpoints switched off after a failure streak',
      registers: []
    });
    this.promMetrics = [this.deliveries, this.held, this.disabled];
  }

  attach(boss: PgBoss): void {
    this.boss = boss;
  }

  get catalog(): WebhookCatalogIndex {
    return this.deps.catalog;
  }

  // ── Emit ─────────────────────────────────────────────────────────────────

  async emit(conn: DbConn, event: WebhookEmit): Promise<string | null> {
    const declared = this.deps.catalog.events.get(event.type);
    if (!declared) {
      // A type the catalog does not know is a programming error, not a runtime condition.
      throw new Error(`webhooks: "${event.type}" is not a declared event type`);
    }
    if (!(await this.wants(event.workspaceId, event.type))) return null;
    const parsed = declared.data.safeParse(event.data);
    if (!parsed.success) {
      this.deps.logger.error(
        { type: event.type, issues: parsed.error.issues.slice(0, 3) },
        'webhooks: an emit carried data outside its declared schema — skipped'
      );
      return null;
    }
    const subjects: Record<string, WebhookSubjectValue> = {};
    for (const key of declared.subjects) {
      const value = event.subjects?.[key];
      if (value === undefined) {
        this.deps.logger.error(
          { type: event.type, subject: key },
          'webhooks: an emit left out a declared subject — skipped'
        );
        return null;
      }
      subjects[key] = typeof value === 'string' ? value : [...value];
    }
    const boss = this.requireBoss();
    const job: WebhookEventJob = {
      id: randomUUID(),
      type: event.type,
      occurredAt: this.now().toISOString(),
      workspaceId: event.workspaceId,
      subjects,
      data: parsed.data as Record<string, unknown>
    };
    // The fan-out's own retries are short: it only reads and inserts locally.
    const sent = await sendInTx(boss, conn, WEBHOOK_EVENTS_QUEUE, job, {
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true
    });
    if (sent === null) throw new Error(`webhooks: the queue ${WEBHOOK_EVENTS_QUEUE} does not exist`);
    return job.id;
  }

  /** Does any enabled endpoint of the workspace subscribe to this type? Cached per replica. */
  async wants(workspaceId: string, type: string): Promise<boolean> {
    const cached = this.listeners.get(workspaceId);
    const patterns =
      cached && this.now().getTime() - cached.at < this.dials.listenerTtlMs
        ? cached.patterns
        : await this.loadListeners(workspaceId);
    return patterns.some((p) => endpointWants({ enabled: true, events: p, filters: {} }, type, {}));
  }

  private async loadListeners(workspaceId: string): Promise<string[][]> {
    const rows = await this.deps.db
      .select({ events: webhookEndpoints.events })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.enabled, true)));
    const patterns = rows.map((r) => r.events);
    this.listeners.set(workspaceId, { at: this.now().getTime(), patterns });
    return patterns;
  }

  /** Forget the cached answer of a workspace (every write of its endpoints calls it). */
  invalidateListeners(workspaceId: string): void {
    this.listeners.delete(workspaceId);
  }

  /**
   * The chassis's own events, bridged from the in-process bus: fired after
   * the write committed, so never for a rolled-back one, and at most once
   * per replica that saw it. The events emitted inside a transaction the
   * chassis owns (projects) do not pass here.
   */
  bindBus(events: EventBus): void {
    const emit = async (event: WebhookEmit): Promise<void> => {
      try {
        await this.emit(this.deps.db, event);
      } catch (err) {
        this.deps.logger.error({ err, type: event.type }, 'webhooks: a bus-bridged emit failed');
      }
    };
    events.on('member.joined', ({ workspaceId, userId, role }) =>
      emit({ workspaceId, type: 'member.joined', data: { userId, role } })
    );
    events.on('member.removed', ({ workspaceId, userId }) =>
      emit({ workspaceId, type: 'member.removed', data: { userId } })
    );
    events.on('workspace.created', ({ workspaceId, ownerUserId }) =>
      emit({ workspaceId, type: 'workspace.created', data: { ownerUserId } })
    );
    events.on('apikey.created', ({ workspaceId, apiKeyId }) =>
      emit({ workspaceId, type: 'apikey.created', data: { apiKeyId } })
    );
    events.on('apikey.revoked', ({ workspaceId, apiKeyId }) =>
      emit({ workspaceId, type: 'apikey.revoked', data: { apiKeyId } })
    );
  }

  // ── Fan-out ───────────────────────────────────────────────────────────────

  /** One delivery row and one delivery job per endpoint that wants the event; answers how many. */
  async fanOut(job: WebhookEventJob): Promise<number> {
    const endpoints = await this.deps.db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.workspaceId, job.workspaceId), eq(webhookEndpoints.enabled, true)));
    const matching = endpoints.filter((e) =>
      endpointWants({ enabled: e.enabled, events: e.events, filters: e.filters }, job.type, job.subjects)
    );
    if (matching.length === 0) return 0;
    const payload = this.envelopeOf(job);
    await this.deps.db.transaction(async (tx) => {
      for (const endpoint of matching) {
        const [row] = await tx
          .insert(webhookDeliveries)
          .values({
            endpointId: endpoint.id,
            workspaceId: job.workspaceId,
            eventId: job.id,
            eventType: job.type,
            payload,
            status: 'pending'
          })
          .returning({ id: webhookDeliveries.id });
        await this.queueDelivery(tx, row!.id);
      }
    });
    return matching.length;
  }

  /** The envelope as the receiver reads it (without `attempt`, stamped at each send). */
  private envelopeOf(job: WebhookEventJob): Record<string, unknown> {
    const subjects: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(job.subjects)) {
      const field = this.deps.catalog.subjects[key]?.field ?? key;
      subjects[field] = value;
    }
    return {
      id: job.id,
      type: job.type,
      occurredAt: job.occurredAt,
      workspaceId: job.workspaceId,
      subjects,
      data: job.data
    };
  }

  private async queueDelivery(conn: DbConn, deliveryId: string, startAfterSeconds = 0): Promise<void> {
    const sent = await sendInTx(
      this.requireBoss(),
      conn,
      WEBHOOK_DELIVERIES_QUEUE,
      { deliveryId } satisfies WebhookDeliveryJob,
      {
        retryLimit: this.dials.retryLimit,
        retryDelay: this.dials.retryDelaySeconds,
        retryBackoff: true,
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {})
      }
    );
    if (sent === null) throw new Error(`webhooks: the queue ${WEBHOOK_DELIVERIES_QUEUE} does not exist`);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * One attempt of a delivery. `retryable` (the queue's worker): a failure
   * throws `WebhookDeliveryFailed` so pg-boss retries. Not retryable (the
   * test ping, run inline): a failure marks the row `failed` and answers it.
   * Answers the row as it is after the attempt.
   */
  async attempt(deliveryId: string, opts: { retryable: boolean }): Promise<WebhookDeliveryRow | null> {
    const [delivery] = await this.deps.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!delivery) return null; // the endpoint (and its rows) are gone
    if (delivery.status === 'delivered') return delivery;
    const [endpoint] = await this.deps.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1);
    const now = this.now();
    if (!endpoint || !endpoint.enabled) {
      this.deliveries.inc({ outcome: 'refused' });
      return this.finish(delivery, {
        status: 'failed',
        lastError: 'endpoint_disabled',
        lastStatusCode: null,
        now
      });
    }
    const attempt = delivery.attempt + 1;
    const body = JSON.stringify({ ...delivery.payload, attempt });
    const secrets = [this.box.open(endpoint.secret)];
    if (
      endpoint.previousSecret &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt > now
    ) {
      secrets.push(this.box.open(endpoint.previousSecret));
    }
    const headers = {
      ...webhookHeaders(secrets, delivery.eventId, Math.floor(now.getTime() / 1000), body),
      'user-agent': `${this.deps.identity.slug}-webhooks/${this.deps.version}`
    };
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await safePost(endpoint.url, headers, body, this.deps.policy, {
        timeoutMs: this.dials.timeoutMs,
        ...this.deps.fetchOptions
      });
      statusCode = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error =
        e instanceof WebhookUrlRefusedError
          ? `url_refused:${e.code}`
          : (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
            ? 'timeout'
            : String((e as Error).message ?? e).slice(0, MAX_ERROR_TEXT);
    }
    if (error === null) {
      this.deliveries.inc({ outcome: 'delivered' });
      await this.deps.db
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: 0,
          firstFailureAt: null,
          lastDeliveryAt: now,
          lastDeliveryStatus: 'delivered',
          updatedAt: now
        })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return this.finish(delivery, {
        status: 'delivered',
        attempt,
        lastStatusCode: statusCode,
        lastError: null,
        now,
        deliveredAt: now
      });
    }
    this.deliveries.inc({ outcome: 'failed' });
    const streak = endpoint.consecutiveFailures + 1;
    const firstFailureAt = endpoint.firstFailureAt ?? now;
    const disable =
      streak >= this.dials.disableAfterFailures &&
      now.getTime() - firstFailureAt.getTime() >= this.dials.disableAfterMs;
    await this.deps.db
      .update(webhookEndpoints)
      .set({
        consecutiveFailures: streak,
        firstFailureAt,
        lastDeliveryAt: now,
        lastDeliveryStatus: 'failed',
        updatedAt: now,
        ...(disable ? { enabled: false, disabledAt: now, disabledReason: 'delivery_failures' } : {})
      })
      .where(eq(webhookEndpoints.id, endpoint.id));
    if (disable) {
      this.invalidateListeners(endpoint.workspaceId);
      this.disabled.inc();
      this.deps.logger.error(
        {
          endpointId: endpoint.id,
          workspaceId: endpoint.workspaceId,
          streak,
          since: firstFailureAt.toISOString()
        },
        'webhooks: an endpoint was switched off after a failure streak (webhook_endpoints_disabled_total)'
      );
      await this.mailDisabled(endpoint, streak, firstFailureAt).catch((err) =>
        this.deps.logger.error({ err, endpointId: endpoint.id }, 'webhooks: the auto-disable mail failed')
      );
    }
    const nextAttemptAt =
      opts.retryable && attempt <= this.dials.retryLimit
        ? new Date(now.getTime() + this.dials.retryDelaySeconds * 2 ** (attempt - 1) * 1000)
        : null;
    const row = await this.finish(delivery, {
      status: opts.retryable ? 'pending' : 'failed',
      attempt,
      lastStatusCode: statusCode,
      lastError: error,
      nextAttemptAt,
      now
    });
    if (opts.retryable) throw new WebhookDeliveryFailed(delivery.id, error);
    return row;
  }

  private async finish(
    delivery: WebhookDeliveryRow,
    patch: {
      status: WebhookDeliveryRow['status'];
      attempt?: number;
      lastStatusCode: number | null;
      lastError: string | null;
      nextAttemptAt?: Date | null;
      deliveredAt?: Date;
      now: Date;
    }
  ): Promise<WebhookDeliveryRow> {
    const [row] = await this.deps.db
      .update(webhookDeliveries)
      .set({
        status: patch.status,
        attempt: patch.attempt ?? delivery.attempt,
        lastStatusCode: patch.lastStatusCode,
        lastError: patch.lastError,
        nextAttemptAt: patch.nextAttemptAt ?? null,
        deliveredAt: patch.deliveredAt ?? null,
        updatedAt: patch.now
      })
      .where(eq(webhookDeliveries.id, delivery.id))
      .returning();
    return row!;
  }

  /**
   * The held queue's work: mark the row held and queue it again after the
   * hold, in ONE transaction, so a re-send that fails leaves the row pending
   * and the held job's own retry finds it again (the chassis suite's round 1:
   * a row marked held outside the transaction was never re-driven once its
   * send had failed). A row already delivered, failed or gone is left alone.
   */
  async hold(deliveryId: string): Promise<void> {
    const now = this.now();
    const row = await this.deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'held',
          nextAttemptAt: new Date(now.getTime() + this.dials.heldDelaySeconds * 1000),
          updatedAt: now
        })
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'pending')))
        .returning({ id: webhookDeliveries.id, endpointId: webhookDeliveries.endpointId });
      if (!updated) return null;
      await this.queueDelivery(tx, deliveryId, this.dials.heldDelaySeconds);
      return updated;
    });
    if (!row) return;
    // Counted and logged once the hold committed: a rolled-back hold is not one.
    this.held.inc();
    this.deps.logger.error(
      { deliveryId, endpointId: row.endpointId, retryAfterSeconds: this.dials.heldDelaySeconds },
      'webhooks: a delivery exhausted its retries — held, re-driven after the hold (webhook_deliveries_held_total)'
    );
  }

  private async mailDisabled(endpoint: WebhookEndpointRow, streak: number, since: Date): Promise<void> {
    if (!endpoint.createdBy || !this.deps.email.delivers) return;
    const [creator] = await this.deps.db
      .select({ email: userTable.email, name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, endpoint.createdBy))
      .limit(1);
    if (!creator) return;
    const [workspace] = await this.deps.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, endpoint.workspaceId))
      .limit(1);
    const mail = buildWebhookDisabledEmail({
      brand: this.deps.brand,
      recipientName: creator.name,
      url: endpoint.url,
      description: endpoint.description,
      workspaceName: workspace?.name ?? 'your workspace',
      consecutiveFailures: streak,
      firstFailureAt: since,
      manageUrl: `${this.deps.publicBaseUrl}/webhooks?endpoint=${endpoint.id}`
    });
    await this.deps.email.send({ to: creator.email, ...mail });
  }

  /** The nightly purge: deliveries older than `retentionDays`, in bounded batches. */
  async purge(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const BATCH = 5000;
    let total = 0;
    for (let i = 0; i < 10_000; i++) {
      const res = await this.deps.db.execute(sql`
        DELETE FROM webhook_deliveries
        WHERE id IN (
          SELECT id FROM webhook_deliveries
          WHERE created_at < now() - make_interval(days => ${retentionDays})
          ORDER BY created_at
          LIMIT ${BATCH}
        )
      `);
      const deleted = res.rowCount ?? 0;
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  /** The URL rule at registration (the address itself is judged at every delivery). */
  checkUrl(url: string): void {
    try {
      checkWebhookUrl(url, this.deps.policy);
    } catch (e) {
      if (e instanceof WebhookUrlRefusedError) throw new WebhookRefusedError('url_refused', e.message);
      throw e;
    }
  }

  async create(
    workspaceId: string,
    createdBy: string,
    input: WebhookEndpointCreate
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    this.checkUrl(input.url);
    const secret = generateWebhookSecret();
    const [row] = await this.deps.db
      .insert(webhookEndpoints)
      .values({
        workspaceId,
        createdBy,
        url: input.url,
        description: input.description ?? '',
        events: [...input.events],
        filters: normalizeFilters(input.filters),
        enabled: input.enabled ?? true,
        secret: this.box.seal(secret)
      })
      .returning();
    this.invalidateListeners(workspaceId);
    return { endpoint: endpointToWire(row!), secret };
  }

  async get(workspaceId: string, id: string): Promise<WebhookEndpoint | null> {
    const row = await this.row(workspaceId, id);
    return row ? endpointToWire(row) : null;
  }

  async list(
    workspaceId: string,
    cursor: string | undefined,
    limit: number
  ): Promise<{ webhooks: WebhookEndpoint[]; nextCursor: string | null }> {
    const after = decodeKeysetCursor(cursor);
    const rows = await this.deps.db
      .select({ row: webhookEndpoints, createdAtText: createdAtText(webhookEndpoints.createdAt) })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.workspaceId, workspaceId),
          ...(after
            ? [
                keysetBeforeValue({
                  id: webhookEndpoints.id,
                  createdAt: webhookEndpoints.createdAt,
                  cursor: after
                })
              ]
            : [])
        )
      )
      .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
      webhooks: page.map((r) => endpointToWire(r.row)),
      nextCursor: last ? encodeKeysetCursor({ id: last.row.id, createdAtText: last.createdAtText }) : null
    };
  }

  /** Endpoints of the workspace, for the plan limit's count hook. */
  async count(workspaceId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, workspaceId));
    return Number(row?.n ?? 0);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: WebhookEndpointUpdate
  ): Promise<WebhookEndpoint | null> {
    if (patch.url !== undefined) this.checkUrl(patch.url);
    const now = this.now();
    const reEnabled = patch.enabled === true;
    const [row] = await this.deps.db
      .update(webhookEndpoints)
      .set({
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.events !== undefined ? { events: [...patch.events] } : {}),
        ...(patch.filters !== undefined ? { filters: normalizeFilters(patch.filters) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        // Switching an endpoint back on clears the auto-disable and its streak.
        ...(reEnabled
          ? { disabledAt: null, disabledReason: null, consecutiveFailures: 0, firstFailureAt: null }
          : {}),
        updatedAt: now
      })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspaceId)))
      .returning();
    this.invalidateListeners(workspaceId);
    return row ? endpointToWire(row) : null;
  }

  async remove(workspaceId: string, id: string): Promise<WebhookEndpoint | null> {
    const [row] = await this.deps.db
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspaceId)))
      .returning();
    this.invalidateListeners(workspaceId);
    return row ? endpointToWire(row) : null;
  }

  async rotateSecret(
    workspaceId: string,
    id: string
  ): Promise<{ endpoint: WebhookEndpoint; secret: string; previousSecretExpiresAt: string } | null> {
    const current = await this.row(workspaceId, id);
    if (!current) return null;
    const now = this.now();
    const secret = generateWebhookSecret();
    const previousSecretExpiresAt = new Date(now.getTime() + this.dials.previousSecretOverlapMs);
    const [row] = await this.deps.db
      .update(webhookEndpoints)
      .set({
        secret: this.box.seal(secret),
        previousSecret: current.secret,
        previousSecretExpiresAt,
        updatedAt: now
      })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return {
      endpoint: endpointToWire(row!),
      secret,
      previousSecretExpiresAt: previousSecretExpiresAt.toISOString()
    };
  }

  /** A signed `webhook.ping`, attempted inline, once; the row says how it went. */
  async test(workspaceId: string, id: string, sentBy: string | null): Promise<WebhookDelivery | null> {
    const endpoint = await this.row(workspaceId, id);
    if (!endpoint) return null;
    const job: WebhookEventJob = {
      id: randomUUID(),
      type: WEBHOOK_PING_EVENT,
      occurredAt: this.now().toISOString(),
      workspaceId,
      subjects: {},
      data: { endpointId: id, sentBy }
    };
    const [row] = await this.deps.db
      .insert(webhookDeliveries)
      .values({
        endpointId: id,
        workspaceId,
        eventId: job.id,
        eventType: job.type,
        payload: this.envelopeOf(job),
        status: 'pending'
      })
      .returning({ id: webhookDeliveries.id });
    const result = await this.attempt(row!.id, { retryable: false });
    return result ? deliveryToWire(result) : null;
  }

  async listDeliveries(
    workspaceId: string,
    id: string,
    query: { cursor?: string | undefined; limit: number; status?: WebhookDeliveryRow['status'] | undefined }
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null } | null> {
    const endpoint = await this.row(workspaceId, id);
    if (!endpoint) return null;
    const after = decodeKeysetCursor(query.cursor);
    const rows = await this.deps.db
      .select({ row: webhookDeliveries, createdAtText: createdAtText(webhookDeliveries.createdAt) })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.endpointId, id),
          ...(query.status ? [eq(webhookDeliveries.status, query.status)] : []),
          ...(after
            ? [
                keysetBeforeValue({
                  id: webhookDeliveries.id,
                  createdAt: webhookDeliveries.createdAt,
                  cursor: after
                })
              ]
            : [])
        )
      )
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      deliveries: page.map((r) => deliveryToWire(r.row)),
      nextCursor: last ? encodeKeysetCursor({ id: last.row.id, createdAtText: last.createdAtText }) : null
    };
  }

  async getDelivery(workspaceId: string, id: string, deliveryId: string): Promise<WebhookDelivery | null> {
    const row = await this.deliveryRow(workspaceId, id, deliveryId);
    return row ? deliveryToWire(row) : null;
  }

  /** The same event queued again for the endpoint, as a new row (the event id unchanged: the receiver's dedupe key). */
  async redeliver(workspaceId: string, id: string, deliveryId: string): Promise<WebhookDelivery | null> {
    const source = await this.deliveryRow(workspaceId, id, deliveryId);
    if (!source) return null;
    const row = await this.deps.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(webhookDeliveries)
        .values({
          endpointId: source.endpointId,
          workspaceId: source.workspaceId,
          eventId: source.eventId,
          eventType: source.eventType,
          payload: source.payload,
          status: 'pending'
        })
        .returning();
      await this.queueDelivery(tx, inserted!.id);
      return inserted!;
    });
    return deliveryToWire(row);
  }

  private async row(workspaceId: string, id: string): Promise<WebhookEndpointRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspaceId)))
      .limit(1);
    return row;
  }

  private async deliveryRow(
    workspaceId: string,
    id: string,
    deliveryId: string
  ): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.endpointId, id),
          eq(webhookDeliveries.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row;
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error('webhooks: the job runtime is not attached yet (boot order)');
    return this.boss;
  }
}

/** Filters as stored: every key kept, its ids deduplicated; an empty object when none. */
function normalizeFilters(filters: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(filters ?? {})) out[key] = [...new Set(ids)];
  return out;
}

export function endpointToWire(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    filters: row.filters,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastDeliveryStatus: row.lastDeliveryStatus,
    previousSecretExpiresAt: row.previousSecretExpiresAt?.toISOString() ?? null
  };
}

export function deliveryToWire(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempt: row.attempt,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    payload: row.payload
  };
}
