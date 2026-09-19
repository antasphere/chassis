import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Principal } from '@antasphere/chassis-contract';
import { looksLikeJwt } from '../middleware/scopes.js';
import { buildMcpServer, type McpToolDefinition } from './server.js';

/**
 * The bundled /mcp endpoint (streamable HTTP, STATELESS — see ADR 002).
 *
 * Auth gate first: a valid OAuth bearer (token this instance minted) or an
 * API key — both machine principals, resolved through the same machinery as
 * /api/v1. Anything else gets the RFC 9728 401 challenge whose
 * `resource_metadata` URL drives the whole client OAuth dance.
 *
 * Stateless transport: a fresh McpServer + transport per request, no session
 * ids, no in-process stream state — the platform's statelessness invariant
 * applies to MCP too (any replica can serve any request).
 */
export interface McpHttpDeps {
  publicBaseUrl: string;
  version: string;
  /** In-process fetch against the root app; tools forward the caller's bearer. */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
  resolveOauthJwt: (token: string) => Promise<Principal | null>;
  resolveApiKey: (token: string) => Promise<Principal | null>;
  isApiKeyToken: (token: string) => boolean;
  /** Instance display name for the server instructions (cached by the caller). */
  instanceName: () => Promise<string>;
  /** Per-IP rate limit, applied before the auth gate (floods rejected cheaply). */
  limiter: MiddlewareHandler;
  /** The tool's MCP definition: its tools, instructions, error hints and scope names. */
  tool: McpToolDefinition;
}

export function mcpRoutes(deps: McpHttpDeps): Hono {
  const app = new Hono();
  const challengeUrl = `${deps.publicBaseUrl.replace(/\/+$/, '')}/.well-known/oauth-protected-resource/mcp`;

  app.use('*', deps.limiter);
  // JSON-RPC bodies are small; cap them so a caller can't force the transport
  // to buffer an arbitrarily large body (the /api/v1 cap does not cover /mcp).
  app.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json({ error: 'payload_too_large', error_description: 'MCP request body exceeds 1 MiB' }, 413)
    })
  );

  const unauthorized = (description: string) =>
    new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${challengeUrl}"`
      }
    });

  app.post('/', async (c) => {
    const authHeader = c.req.header('authorization')?.trim() ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() ?? null;
    if (!bearer) {
      return unauthorized('Authentication required');
    }

    let principal: Principal | null = null;
    if (deps.isApiKeyToken(bearer)) {
      principal = await deps.resolveApiKey(bearer);
    } else if (looksLikeJwt(bearer)) {
      principal = await deps.resolveOauthJwt(bearer);
    }
    if (!principal) {
      return unauthorized('Bearer token is invalid, expired, or revoked');
    }

    const server = buildMcpServer(
      {
        fetchApi: deps.fetchApi,
        principal,
        authorizationHeader: `Bearer ${bearer}`,
        publicBaseUrl: deps.publicBaseUrl
      },
      { version: deps.version, instanceName: await deps.instanceName() },
      deps.tool
    );
    // No sessionIdGenerator = stateless: every POST is self-contained.
    // enableJsonResponse returns plain JSON bodies (no SSE), so the Response
    // handed back to Hono is complete — no stream outlives the request,
    // nothing to tear down (the per-request server + transport are
    // unreferenced after this).
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(c);
      return res ?? c.body(null, 204);
    } catch (cause) {
      // The transport reports protocol failures by THROWING HTTPException
      // (400 -32700 for a malformed / non-JSON-RPC body, 406/415 for header
      // problems), each carrying a complete JSON-RPC error response. Return
      // that response instead of letting the root onError turn it into a
      // generic 500.
      if (cause instanceof HTTPException) {
        return cause.getResponse();
      }
      throw cause;
    }
  });

  // Non-POST is rejected here EXPLICITLY (ADR 002): the stateless transport
  // does NOT 405 on its own — its GET handler would happily open a long-lived
  // server-initiated SSE stream, and DELETE would answer a session teardown.
  // Neither exists in stateless mode, so every non-POST method gets
  // 405 + Allow: POST with a JSON-RPC error envelope (the shape the official
  // SDK expects and tolerates).
  app.all('/', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, 405, {
      allow: 'POST'
    })
  );

  return app;
}
