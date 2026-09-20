import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';
import type { RuntimeState } from '../state.js';

/**
 * Baseline headers on every response (brief §2.6). The CSP applies to HTML
 * we serve (the dashboard SPA) and locks it to self — with hashes for the
 * inline bootstrap script SvelteKit bakes into index.html, computed once at
 * boot. User-uploaded content never renders on this origin (the files
 * module forces attachment for active types), so this CSP is the only HTML
 * policy the origin needs. frame-ancestors 'none' replaces X-Frame-Options.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? '';
    if (body.trim().length === 0) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  }
  return hashes;
}

export interface CspOptions {
  /**
   * Extra `frame-src` sources beyond 'self'. A dashboard may preview a resource in
   * a sandboxed iframe whose URL honours VIEWER_BASE_URL (PRDCT-1352, DASH-4):
   * with `default-src 'self'` and no `frame-src`, a split viewer origin made
   * that preview a blank frame with no error anywhere but the console.
   */
  frameSrc?: readonly string[];
}

export function buildCsp(scriptHashes: string[], { frameSrc = [] }: CspOptions = {}): string {
  const script = ["'self'", ...scriptHashes].join(' ');
  const frame = ["'self'", ...frameSrc].join(' ');
  return [
    "default-src 'self'",
    `script-src ${script}`,
    // Svelte injects component styles at runtime; hashes are impractical there.
    // The two font CDNs the dashboard's app.html links (PRDCT-2308): the
    // Observatory pairing rides Fontshare (Sentient, Synonym) and Google
    // Fonts (Onest) because this repo is slated for the OSS cut and the
    // faces may not be committed. Stylesheets from the two API hosts, the
    // font files from their two file hosts, and nothing else — the
    // dashboard's own origin stays the only script and connect source.
    "style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self' https://cdn.fontshare.com https://fonts.gstatic.com",
    `frame-src ${frame}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}

export interface SecurityHeaderOptions {
  csp: string;
  state: RuntimeState;
  /**
   * `Strict-Transport-Security` value, or null to send none. Computed once at
   * boot from PUBLIC_BASE_URL + HSTS_MAX_AGE (see {@link hstsValue}) rather
   * than sniffed per request: `X-Forwarded-Proto` is client-controlled unless
   * TRUST_PROXY vouches for it, and this origin issues the session cookie —
   * the operator's declared public scheme is the honest signal.
   */
  hsts?: string | null;
}

/**
 * The HSTS header for this instance, or null when it must not be sent.
 * Only an https PUBLIC_BASE_URL arms it: a browser MUST ignore HSTS received
 * over plain http (RFC 6797 §7.2), and pinning an http-only self-host into
 * https for 180 days would brick it. `HSTS_MAX_AGE=0` is the operator opt-out
 * (e.g. a subdomain that cannot yet serve TLS).
 */
export function hstsValue(env: Pick<Env, 'PUBLIC_BASE_URL' | 'HSTS_MAX_AGE'>): string | null {
  if (env.HSTS_MAX_AGE <= 0) return null;
  let isHttps = false;
  try {
    isHttps = new URL(env.PUBLIC_BASE_URL).protocol === 'https:';
  } catch {
    isHttps = false;
  }
  if (!isHttps) return null;
  return `max-age=${env.HSTS_MAX_AGE}; includeSubDomains`;
}

export function securityHeaders({ csp, state, hsts }: SecurityHeaderOptions): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    // HSTS on EVERY response, not just HTML: the cookie this origin issues is
    // sent with XHR too, so an http downgrade on /api/v1 is the same theft.
    if (hsts && !c.res.headers.has('strict-transport-security')) {
      c.header('strict-transport-security', hsts);
    }
    // Baseline defaults, but NEVER clobber a value a route set for itself:
    // the public viewer (ADR 012) serves user-authored HTML under its own
    // `Content-Security-Policy: sandbox …` + `Referrer-Policy: no-referrer`,
    // and an unconditional overwrite here would silently replace the sandbox
    // CSP with the dashboard CSP — re-opening the session-theft surface the
    // sandbox exists to close (found by the ADR 012 spike; fail-dangerous
    // class, see the ADR's residual-risk #1 and the viewer regression tests).
    if (!c.res.headers.has('referrer-policy')) {
      c.header('referrer-policy', 'strict-origin-when-cross-origin');
    }
    // Draining: ask keep-alive clients to reconnect elsewhere (rolling deploy).
    if (state.draining) c.header('connection', 'close');
    const contentType = c.res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html') && !c.res.headers.has('content-security-policy')) {
      c.header('content-security-policy', csp);
    }
  };
}
