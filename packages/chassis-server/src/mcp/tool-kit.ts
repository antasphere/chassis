import { ACTIVE_WORKSPACE_HEADER, type Principal } from '@antasphere/chassis-contract';
import { ApiToolError, deny, type ToolTextResult } from './errors.js';

/**
 * Shared plumbing for MCP tools (used by the chassis examples in server.ts
 * and the tool's own set). Every call goes through the
 * instance's own /api/v1 IN-PROCESS with the caller's Authorization header
 * forwarded verbatim — MCP is just another API client, no privileged path.
 */
export interface McpToolContext {
  /** In-process fetch against the root app (path → Response). */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** The verified caller (OAuth token or API key principal). */
  principal: Principal;
  /** Forwarded verbatim on every in-process API call. */
  authorizationHeader: string;
  /**
   * The instance's public origin (`PUBLIC_BASE_URL`), for the one thing a
   * tool composes for a human rather than for the API: the page of the tool's
   * resource that a push answers with (PRDCT-2280). Never used to reach the API.
   */
  publicBaseUrl: string;
  /**
   * Target workspace of THIS tool call (user-scoped credential model): set
   * from the tool's optional `workspace` argument via {@link forWorkspace},
   * it rides the in-process re-entry as the X-Workspace-Id header, where
   * the API's own resolvers authorize it against the caller's live
   * memberships — a tool argument can never grant what the credential's
   * user does not hold. Absent = the caller's default workspace.
   */
  workspaceId?: string | undefined;
}

/**
 * The per-call workspace seam: every workspace-scoped tool passes its
 * optional `workspace` argument through here so the selection travels on
 * the ONE header the whole platform authorizes.
 */
export function forWorkspace(ctx: McpToolContext, workspace: string | undefined): McpToolContext {
  return workspace ? { ...ctx, workspaceId: workspace } : ctx;
}

/** The re-entry headers: caller's bearer + the per-call workspace selector. */
function apiHeaders(ctx: McpToolContext): Record<string, string> {
  return {
    authorization: ctx.authorizationHeader,
    ...(ctx.workspaceId ? { [ACTIVE_WORKSPACE_HEADER]: ctx.workspaceId } : {})
  };
}

/**
 * Tool-level scope pre-check — UX only: the API's fail-closed allowlist
 * (middleware/scopes.ts) is the enforcement point; this just gives the model
 * a clean, actionable error instead of a raw 403.
 */
export type ScopeCheck<TScope extends string> = (
  principal: Principal,
  scope: TScope
) => ToolTextResult | null;

/** The tool's two MCP scope names: what a read tool and a write tool pre-check. */
export interface McpScopes<TRead extends string = string, TWrite extends string = string> {
  read: TRead;
  write: TWrite;
}

export function createScopeCheck<TRead extends string, TWrite extends string>(
  scopes: McpScopes<TRead, TWrite>
): ScopeCheck<TRead | TWrite> {
  return (principal, scope) => {
    if (principal.scopes && !principal.scopes.has(scope)) {
      return deny(
        `Missing scope "${scope}": this connection was not granted ` +
          (scope === scopes.write ? 'permission to create or edit data.' : 'permission to read data.') +
          ' Reconnect the MCP server and approve the permission on the consent screen.'
      );
    }
    return null;
  };
}

/**
 * In-process API call returning the raw Response (asset downloads, multipart
 * uploads). A non-2xx answer is parsed into an ApiToolError so wrapToolErrors
 * renders the code + `Next:` hint.
 */
export async function fetchApiRaw(
  ctx: McpToolContext,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await ctx.fetchApi(path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...apiHeaders(ctx) }
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiToolError(
      res.status,
      body?.error?.code ?? null,
      body?.error?.message ?? `unexpected response from ${path}`
    );
  }
  return res;
}

/** In-process JSON API call: parses the body, maps non-2xx to ApiToolError. */
export async function callApi(ctx: McpToolContext, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await ctx.fetchApi(path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...apiHeaders(ctx) }
  });
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    throw new ApiToolError(
      res.status,
      body?.error?.code ?? null,
      body?.error?.message ?? `unexpected response from ${path}`
    );
  }
  return body;
}

/**
 * Append cursor/limit list params to a path, after the route's own filters
 * (`extra`, e.g. the `type` of the tool's resource list); an undefined filter is
 * left out.
 */
export function pageQuery(
  base: string,
  params: { cursor?: string | undefined; limit?: number | undefined },
  extra: Record<string, string | undefined> = {}
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) query.set(key, value);
  }
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}
