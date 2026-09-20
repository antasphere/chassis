/**
 * Fail-closed endpoint allowlist for machine principals (API keys now, OAuth
 * bearer tokens in M6). Ported from a predecessor template's oauth-scopes.ts.
 *
 * Machine principals are deliberately MORE restricted than the user they
 * belong to: they can only reach endpoints listed here, each behind its
 * scope. Anything not listed returns null and the gate 403s — new endpoints
 * are unreachable to keys/tokens until someone consciously opens them.
 * Session principals are role-gated instead and never pass through this.
 *
 * Pure logic (no I/O) so it stays unit-testable. The chassis owns the
 * MECHANISM and the rules of its own endpoints; the scope NAMES and the rules
 * of the tool's endpoints are the tool's (`createScopeAllowlist`).
 */
export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * One tool rule: the scope a machine principal needs for this request, or
 * null when the rule does not speak about it (the next rule is asked; no rule
 * speaking = denied).
 */
export type ScopeRule<S extends string> = (path: string, method: string, isRead: boolean) => S | null;

export interface ScopeAllowlistOptions<S extends string> {
  /** The tool's scope behind the chassis READ surfaces (`/me`, the files reads). */
  read: S;
  /** The tool's scope behind the chassis MUTATIONS (files writes, the CLI key self-revoke). */
  write: S;
  /** The tool's dedicated opt-in scope for the full-workspace export. */
  dataExport: S;
  /** The tool's own rules, asked in order AFTER the chassis rules. */
  rules: ReadonlyArray<ScopeRule<S>>;
}

/**
 * Builds the allowlist function: the chassis rules FIRST, then the tool's
 * rules in order, and `null` (the gate's 403 `endpoint_not_allowed`) when
 * nothing matched — fail-closed by construction.
 */
/**
 * The chassis project routes a machine principal may reach, EXACT shapes only:
 * reads under the read scope, writes under the write scope. Anything else
 * under `/projects` answers null HERE, so a tool's own route on a project (its
 * link to the project, say) is the tool's rule to open, and an unknown shape
 * stays closed.
 */
const PROJECT_ID = '[0-9a-fA-F-]{36}';
const PROJECT_RE = new RegExp(`^/api/v1/projects/${PROJECT_ID}$`);
const PROJECT_ARCHIVE_RE = new RegExp(`^/api/v1/projects/${PROJECT_ID}/(?:archive|unarchive)$`);
const PROJECT_MEMBERS_RE = new RegExp(`^/api/v1/projects/${PROJECT_ID}/members$`);
const PROJECT_MEMBER_RE = new RegExp(`^/api/v1/projects/${PROJECT_ID}/members/[^/]+$`);

function projectAccess(path: string, method: string): 'read' | 'write' | null {
  if (path === '/api/v1/projects') return method === 'GET' ? 'read' : method === 'POST' ? 'write' : null;
  if (PROJECT_RE.test(path)) return method === 'GET' ? 'read' : method === 'PATCH' ? 'write' : null;
  if (PROJECT_ARCHIVE_RE.test(path)) return method === 'POST' ? 'write' : null;
  if (PROJECT_MEMBERS_RE.test(path)) return method === 'GET' ? 'read' : method === 'POST' ? 'write' : null;
  if (PROJECT_MEMBER_RE.test(path)) return method === 'PATCH' || method === 'DELETE' ? 'write' : null;
  return null;
}

export function createScopeAllowlist<S extends string>({
  read,
  write,
  dataExport,
  rules
}: ScopeAllowlistOptions<S>): (path: string, method: string) => S | null {
  return function requiredScopeFor(path: string, method: string): S | null {
    const isRead = method === 'GET' || method === 'HEAD';
    if (path === '/api/v1/me' && isRead) return read;
    // Files: the substrate machine callers actually need (agents pushing and
    // pulling artifacts). Reads → the read scope, mutations → the write scope.
    if (path === '/api/v1/files' || path.startsWith('/api/v1/files/')) {
      return isRead ? read : write;
    }
    // CLI logout self-revoke (api/cli-auth.ts): the ONE /cli/auth route open
    // to machines — DELETE revokes exactly the PRESENTING key. Safe to open
    // because the route names no key (no id parameter): the handler acts only
    // on principal.apiKeyId, resolved from the presented secret, and refuses
    // every non-key principal — so the widest possible effect is a credential
    // revoking ITSELF. The write scope because revocation is a mutation
    // and every CLI-minted key carries it (mirrors the hub's account:write
    // entry). Exact path + method match: any OTHER method on the path, and
    // the PUBLIC mint routes (/cli/auth/request, /cli/auth/complete — which
    // never reach this gate anyway), stay fail-closed.
    if (path === '/api/v1/cli/auth/key' && method === 'DELETE') return write;
    // Full-workspace export: a dedicated opt-in scope, NEVER the read scope — any
    // admin read key would otherwise be a whole-tenant exfiltration tool.
    // (Account deletion, DELETE /members/{id}, stays deliberately UNLISTED:
    // machines 403 fail-closed; deleting people is a session-only act.
    // Break-glass, /admin/break-glass/*, is likewise deliberately UNLISTED:
    // superadmin recovery is a human session act — a key or token whose owner
    // is on SUPERADMIN_EMAILS still 403s here, fail-closed. Never list it.)
    if (path === '/api/v1/workspace/export' && isRead) return dataExport;
    // Projects: each route listed by its exact shape and method (above).
    const project = projectAccess(path, method);
    if (project !== null) return project === 'read' ? read : write;
    for (const rule of rules) {
      const needed = rule(path, method, isRead);
      if (needed !== null) return needed;
    }
    // Deliberately UNLISTED chassis surfaces (fail-closed 403 for
    // keys/tokens), like break-glass:
    //  - /sso/logout (cloud) — single logout is a BROWSER act: a machine
    //    credential must never be able to end its user's sessions. Never
    //    list it.
    //  - POST /workspaces — creating a workspace (on cloud: an organization at
    //    the hub, as the user) is a HUMAN act from the dashboard. A key or a
    //    token must never be able to mint tenants for its holder; the handler
    //    re-checks `via === 'session'` on top (api/workspaces.ts). Never list it.
    //  - /me/onboarding/dismiss (cloud) — the first-run welcome is a browser
    //    concern; machines carry no banner to dismiss.
    return null;
  };
}
