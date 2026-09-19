import { auditLog, type Db } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from '../logger.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by domain handlers to give the audit entry real semantics. */
    audit?: {
      action: string;
      resourceType: string;
      resourceId?: string;
      metadata?: Record<string, unknown>;
    };
  }
}

/**
 * The attributed actor of an audit row — the subset of Principal the log
 * records. A full Principal satisfies it structurally; surfaces whose actor
 * holds no workspace-scoped principal (break-glass) build it directly.
 */
export interface AuditActor {
  userId: string;
  via: Principal['via'];
  apiKeyId?: string | undefined;
}

export interface AuditWrite {
  /** null = INSTANCE-attributed: the event belongs to no workspace (ADR 014). */
  workspaceId: string | null;
  principal: AuditActor | null;
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger
  ) {}

  /**
   * Awaited on privileged mutations — durability over latency when healthy.
   * Best-effort by contract: the handler's mutation has already committed by
   * the time this runs, so a failed insert must never turn into a 500 (a
   * retried non-idempotent POST would double-create). Failure = logged loss.
   */
  async write(entry: AuditWrite): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        workspaceId: entry.workspaceId,
        actorUserId: entry.principal?.userId ?? null,
        actorVia: entry.principal?.via ?? 'system',
        apiKeyId: entry.principal?.apiKeyId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        requestId: entry.requestId ?? null,
        ip: entry.ip ?? null,
        metadata: entry.metadata ?? null
      });
    } catch (err) {
      this.logger.error(
        { err, action: entry.action, requestId: entry.requestId },
        'audit write failed — the audited mutation was NOT rolled back'
      );
    }
  }
}

export interface AuditMiddlewareOptions {
  /** Extra paths the TOOL exempts from the generic audit row, beside the chassis ones. */
  exempt?: (path: string) => boolean;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths whose mutations are not audited here (they audit themselves or are credential machinery). */
function isAuditExempt(path: string, extraExempt: (path: string) => boolean): boolean {
  return (
    path.startsWith('/api/v1/auth/') ||
    path === '/api/v1/setup' ||
    path === '/api/v1/invitations/accept' ||
    // Workspace creation self-audits into the NEW workspace's own trail
    // (api/workspaces.ts). The generic row would land in the workspace the
    // person happened to be in — and a workspace never learns what its
    // members do elsewhere.
    path === '/api/v1/workspaces' ||
    // The tool's own exemptions (AuditMiddlewareOptions.exempt), evaluated
    // at the place they have always had in this chain.
    extraExempt(path) ||
    // Break-glass self-audits with before/after detail — and its callers may
    // hold a session WITHOUT a membership (principal null), which this
    // middleware could not attribute anyway.
    path.startsWith('/api/v1/admin/break-glass/')
  );
}

/**
 * One write point for the audit trail, after the handler:
 *  - every authenticated MUTATION lands one row (awaited — durability is
 *    part of the mutation);
 *  - every MACHINE-principal request lands one row, reads included
 *    (exit criterion 4: a curl with an API key must appear in the log with
 *    the key's identity — keys mostly read, so read auditing is what makes
 *    that true). Session reads stay unaudited (noise).
 * Handlers add semantics via c.set('audit', ...); without it the row records
 * method + path.
 */
export function auditMiddleware(
  audit: AuditService,
  clientIp: (c: Context) => string,
  options: AuditMiddlewareOptions = {}
): MiddlewareHandler {
  const extraExempt = options.exempt ?? (() => false);
  return async (c, next) => {
    await next();
    if (isAuditExempt(c.req.path, extraExempt)) return;
    const principal = c.get('principal');
    if (!principal) return;
    if (c.res.status >= 400) return;

    const isMutation = MUTATING.has(c.req.method);
    const isMachine = principal.via !== 'session';
    if (!isMutation && !isMachine) return;

    const info = c.get('audit');
    await audit.write({
      workspaceId: principal.workspaceId,
      principal,
      action: info?.action ?? `${c.req.method.toLowerCase()} ${c.req.path}`,
      resourceType: info?.resourceType ?? 'http',
      resourceId: info?.resourceId,
      requestId: c.get('requestId'),
      ip: clientIp(c),
      metadata: info?.metadata
    });
  };
}
