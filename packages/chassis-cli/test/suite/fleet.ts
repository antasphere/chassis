import { routedHarness, type Route } from '@antasphere/chassis-cli/testing';
import { cli } from '@chassis-cli-test/host';
import { cloudInstanceBody, INSTANCE_BASE, meBody, MINTED_META } from './signin-fixtures.js';

/**
 * A fleet of fake hubs and sites, each served by its ORIGIN through the
 * harness (`Route.origin`), shared by the suites where the sign-in follows
 * the site (R2) and the profiles say the truth about it (R4). Its
 * `violations()` lists every request that carried a hub key to another
 * origin than its login's hub, or a tool key (own or kept) to another origin
 * than its site: the two invariants, checked after each test.
 *
 * - A hub knows the hub keys of its own logins, mints them with its email
 *   code, and mints tokens for the sites that trust it.
 * - A site names the hub it trusts in its discovery (or names none: a site
 *   from before R1), or signs in by itself (self-hosted); it may announce a
 *   CLI version; each mints, serves and revokes its own keys. A site that is
 *   down fails every request the way `fetch` fails when nothing answers; a
 *   silent one holds the connection open, and its request fails only when
 *   the request's signal aborts; one may refuse its revoke (403), not know it
 *   (404), turn it away for now (429) or fail it (500), revoking nothing.
 * - A key the test holds (`hold`) is never answered when its revoke comes, at
 *   its site or at its hub: that request, too, fails only when its signal
 *   aborts, and the key stays alive.
 */

const { keyPrefix: K } = cli.identity;

export const HUB_A = 'https://hub-a.example.com';
export const HUB_B = 'https://hub-b.example.com';
export const SITE_A = 'https://site-a.example.com';
export const SITE_B = 'https://site-b.example.com';
export const OLD = 'https://old.example.com';

export const ADA = 'ada@example.com';
export const BEA = 'bea@example.com';
export const CY = 'cy@example.com';

export interface FleetSite {
  origin: string;
  /** The hub its discovery names (`auth.hub`, R1); null: it names none. */
  names: string | null;
  /** The hub whose tokens it accepts; null: a self-hosted site, which signs in by itself. */
  trusts: string | null;
  /** The CLI version its discovery announces (`cli.version`). */
  cli?: string;
  /** Nothing answers there; `revoke`: nothing answers its revoke (`DELETE /cli/auth/key`) alone. */
  down?: boolean | 'revoke';
  /**
   * A site that holds the connection open and never answers: every request
   * (`all`), `/me` alone while its discovery answers (`me`), or its revoke
   * (`DELETE /cli/auth/key`) alone while everything else answers (`revoke`).
   * Such a request settles only when its signal aborts, the way fetch then
   * fails.
   */
  silent?: 'all' | 'me' | 'revoke';
  /**
   * What its revoke (`DELETE /cli/auth/key`) answers instead of revoking, the
   * key staying alive: 403, a site that refuses the self-revoke (the key stays
   * valid there); 404, one with no such route; 429, one that turns it away for
   * now (its rate limit); 500, one that fails.
   */
  revokeAnswer?: 403 | 404 | 429 | 500;
}

/** The error a site's revoke answers in place of revoking (`FleetSite.revokeAnswer`), by status. */
const REVOKE_ANSWERS: Record<NonNullable<FleetSite['revokeAnswer']>, { code: string; message: string }> = {
  403: { code: 'forbidden', message: 'This key may not revoke itself' },
  404: { code: 'not_found', message: 'No such route' },
  429: { code: 'rate_limited', message: 'Too many requests' },
  500: { code: 'internal_error', message: 'Something went wrong' }
};

/** What a silent site never answers, by kind: the methods, and the path they are sent to. */
const SILENT: Record<NonNullable<FleetSite['silent']>, { methods: string[]; path: RegExp }> = {
  all: { methods: ['GET', 'POST', 'DELETE'], path: /.*/ },
  me: { methods: ['GET'], path: /\/api\/v1\/me$/ },
  revoke: { methods: ['DELETE'], path: /\/api\/v1\/cli\/auth\/key$/ }
};

/** The sites of the sign-in suite: site-a names hub-a, site-b names hub-b, old names none and trusts hub-a. */
export const SITES: FleetSite[] = [
  { origin: SITE_A, names: HUB_A, trusts: HUB_A },
  { origin: SITE_B, names: HUB_B, trusts: HUB_B },
  { origin: OLD, names: null, trusts: HUB_A }
];

export type Harness = ReturnType<typeof routedHarness>;

const deny = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } }
});
const bearer = (headers: Headers) => headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
const hostOf = (origin: string) => new URL(origin).hostname.split('.')[0]!;
export const nameOf = (email: string) => email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase());

/** An answer that never comes: it fails when the request's signal aborts, with its reason, as fetch does. */
function never(signal: AbortSignal | undefined): { raw: Promise<Response> } {
  return {
    raw: new Promise<Response>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    })
  };
}

/** What a site says of itself on its discovery. */
function discoveryOf(site: FleetSite): Record<string, unknown> {
  const cliVersion = site.cli ? { cli: { version: site.cli } } : {};
  if (site.trusts === null) {
    return {
      ...INSTANCE_BASE,
      edition: 'oss',
      auth: {
        methods: ['password', 'email-otp', 'api-key', 'oauth'],
        passwordReset: true,
        emailChange: true,
        twoFactor: true
      },
      ...cliVersion
    };
  }
  return { ...cloudInstanceBody(site.names ?? undefined), ...cliVersion };
}

export function fleet(sites: FleetSite[] = SITES, hubs: string[] = [HUB_A, HUB_B]) {
  const hubKeys = new Map<string, { hub: string; email: string; alive: boolean }>();
  const toolKeys = new Map<string, { site: string; email: string; alive: boolean }>();
  const tokens = new Map<string, { hub: string; email: string; resource: string }>();
  /** The keys whose revoke is never answered (`hold`). */
  const heldOpen = new Set<string>();
  const harnesses: Harness[] = [];
  let seq = 0;
  let exchanges = 0;

  function hubKey(hub: string, email: string): string {
    seq += 1;
    const k = `ant_${hostOf(hub)}${seq}_secretsecretsecret`;
    hubKeys.set(k, { hub, email, alive: true });
    return k;
  }

  function toolKey(site: string, email: string, kind = 'kept'): string {
    seq += 1;
    const k = `${K}_${hostOf(site)}${seq}_${kind}${kind}${kind}`;
    toolKeys.set(k, { site, email, alive: true });
    return k;
  }

  const routes: Route[] = [];
  for (const hub of hubs) {
    routes.push(
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/sso\/tool-token$/,
        reply: ({ headers, body }) => {
          const who = hubKeys.get(bearer(headers));
          if (!who || who.hub !== hub || !who.alive) return deny(401, 'unauthenticated', 'unknown hub key');
          const resource = (body as { resource?: string }).resource ?? '';
          const site = sites.find((s) => `${s.origin}/mcp` === resource);
          if (!site || site.trusts !== hub) {
            return deny(400, 'unknown_resource', 'This resource is not a registered tool');
          }
          seq += 1;
          const token = `jwt-${seq}`;
          tokens.set(token, { hub, email: who.email, resource });
          return { body: { token, expiresAt: '2026-11-25T00:02:00.000Z', hubRefreshToken: `hrt-${seq}` } };
        }
      },
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/request$/,
        reply: () => ({ body: { sent: true } })
      },
      {
        method: 'POST',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/complete$/,
        reply: ({ body }) => {
          const email = (body as { email: string }).email;
          return {
            status: 201,
            body: {
              key: hubKey(hub, email),
              apiKey: MINTED_META,
              user: { id: 'u1', email, name: nameOf(email) },
              workspaceId: 'org-1'
            }
          };
        }
      },
      {
        method: 'DELETE',
        origin: hub,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: ({ headers, signal }) => {
          if (heldOpen.has(bearer(headers))) return never(signal);
          const held = hubKeys.get(bearer(headers));
          if (!held || held.hub !== hub || !held.alive) return deny(401, 'unauthenticated', 'unknown key');
          held.alive = false;
          return { body: { revoked: true, id: 'k' } };
        }
      }
    );
  }
  for (const site of sites) {
    if (site.down === 'revoke') {
      // Matched before the site's own revoke: it fails the way fetch fails when nothing answers.
      routes.push({
        method: 'DELETE',
        origin: site.origin,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: () => {
          throw new TypeError('fetch failed');
        }
      });
    } else if (site.down) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        routes.push({
          method,
          origin: site.origin,
          path: /.*/,
          reply: () => {
            throw new TypeError('fetch failed');
          }
        });
      }
      continue;
    }
    if (site.silent) {
      // Matched before the site's own routes: what the site never answers.
      const { methods, path } = SILENT[site.silent];
      for (const method of methods) {
        routes.push({ method, origin: site.origin, path, reply: ({ signal }) => never(signal) });
      }
    }
    if (site.revokeAnswer) {
      const status = site.revokeAnswer;
      const { code, message } = REVOKE_ANSWERS[status];
      // Matched before the site's own revoke: the status, and nothing revoked.
      routes.push({
        method: 'DELETE',
        origin: site.origin,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: () => deny(status, code, message)
      });
    }
    routes.push(
      {
        method: 'GET',
        origin: site.origin,
        path: /\/api\/v1\/instance$/,
        reply: () => ({ body: discoveryOf(site) })
      },
      {
        method: 'POST',
        origin: site.origin,
        path: /\/api\/v1\/sso\/cli-connect$/,
        reply: ({ body }) => {
          const token = (body as { token?: string }).token ?? '';
          const claim = tokens.get(token);
          if (!claim || claim.resource !== `${site.origin}/mcp` || claim.hub !== site.trusts) {
            return deny(401, 'invalid_token', 'token refused');
          }
          tokens.delete(token);
          exchanges += 1;
          const k = toolKey(site.origin, claim.email, 'mint');
          return {
            status: 201,
            body: {
              key: k,
              apiKey: MINTED_META,
              user: { id: 'u1', email: claim.email, name: nameOf(claim.email) },
              workspaceId: null
            }
          };
        }
      },
      {
        method: 'GET',
        origin: site.origin,
        path: /\/api\/v1\/me$/,
        reply: ({ headers }) => {
          const held = toolKeys.get(bearer(headers));
          if (!held || held.site !== site.origin || !held.alive) {
            return deny(401, 'invalid_api_key', 'API key not recognized');
          }
          return { body: meBody({ name: nameOf(held.email), email: held.email }) };
        }
      },
      {
        method: 'DELETE',
        origin: site.origin,
        path: /\/api\/v1\/cli\/auth\/key$/,
        reply: ({ headers, signal }) => {
          if (heldOpen.has(bearer(headers))) return never(signal);
          const held = toolKeys.get(bearer(headers));
          if (!held || held.site !== site.origin || !held.alive)
            return deny(401, 'unauthenticated', 'unknown key');
          held.alive = false;
          return { body: { revoked: true, id: 'k' } };
        }
      }
    );
  }

  return {
    hubKey,
    toolKey,
    exchanges: () => exchanges,
    alive: (k: string) => hubKeys.get(k)?.alive ?? toolKeys.get(k)?.alive ?? false,
    /** A tool key its site no longer accepts (revoked from its dashboard). */
    kill(k: string): void {
      const held = toolKeys.get(k);
      if (held) held.alive = false;
    },
    /** A key whose revoke its site (or its hub) holds open and never answers: the key stays alive. */
    hold(k: string): void {
      heldOpen.add(k);
    },
    /** Every key the fleet minted or was seeded with: the text no output may carry. */
    keys: () => [...hubKeys.keys(), ...toolKeys.keys()],
    /** A harness on the fleet, watched by the invariants. */
    harness(env: Record<string, string | undefined>): Harness {
      const h = routedHarness(routes, env);
      harnesses.push(h);
      return h;
    },
    /** Every request of the test's harnesses that carried a key to another origin than its own. */
    violations(): string[] {
      const found: string[] = [];
      for (const h of harnesses) {
        for (const c of h.wire) {
          const carried = `${c.auth ?? ''} ${JSON.stringify(c.body ?? null)} ${c.path}`;
          for (const [k, home] of hubKeys) {
            if (carried.includes(k) && c.origin !== home.hub) {
              found.push(`hub key of ${home.hub} sent to ${c.origin}${c.path}`);
            }
          }
          for (const [k, home] of toolKeys) {
            if (carried.includes(k) && c.origin !== home.site) {
              found.push(`tool key of ${home.site} sent to ${c.origin}${c.path}`);
            }
          }
        }
      }
      return found;
    },
    /** How many requests the test's harnesses sent. */
    requests: () => harnesses.reduce((n, h) => n + h.wire.length, 0)
  };
}

/** The wire of a harness, one `METHOD origin+path` per request. */
export const trace = (h: Harness) => h.wire.map((c) => `${c.method} ${c.origin}${c.path}`);
