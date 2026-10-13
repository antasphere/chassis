import { createReadStream, statSync, type Stats } from 'node:fs';
import { Readable } from 'node:stream';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { lt, sql } from 'drizzle-orm';
import type { cliPackageRoute } from '@antasphere/chassis-contract/routes';
import { ssoConnectJtis, type Db } from '@antasphere/chassis-db';
import type { HubConnectAssertion, HubSsoService } from '../identity/hub-sso.js';
import type { CliPackage } from '../cli-package/index.js';
import type { Logger } from '../logger.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * The tool's own CLI package (cloud edition ONLY, PRDCT-3312):
 *
 *   POST /cli/package → verify a hub-minted 120 s exchange JWT (the same H3
 *   token `/sso/cli-connect` takes), burn its jti, stream the tarball the
 *   release packed (`CLI_PACKAGE_DIR`, cli-package/index.ts)
 *
 * The public `team` command installs each internal tool's private CLI from
 * here: the hub mints the token only for a member it lets into the tool
 * (its 403 `tool_access_denied` otherwise), so holding a valid one IS the
 * access decision, and this route adds none of its own.
 *
 * Registered by create-api.ts ONLY when the instance boots EDITION=cloud,
 * beside `/sso/cli-connect` and for the same reason: an oss boot never
 * mounts this module, so the path answers the JSON 404 terminator there
 * (zero hub surface). Rate-limited on the CLI-connect wall (the same hub
 * token, the same cost).
 *
 * NOT a public path and unlisted in the machine scope allowlist, on
 * purpose: the token rides in the BODY, never in `Authorization` (a
 * three-part bearer reads as an OAuth token to the scope gate). A request
 * carrying no credential reaches this handler with no principal; an API key
 * or an OAuth bearer meets the fail-closed 403 `endpoint_not_allowed` before
 * it (middleware/scopes.ts).
 *
 * Verification discipline is sso-connect.ts's, unchanged:
 *
 *  - the token passes `HubSsoService.verifyConnectToken` — hub-JWKS
 *    signature, iss pinned to the hub, aud pinned to OUR resource URL,
 *    RS256 only, expiry, `purpose: 'sso-connect'` required, `jti` required;
 *  - the `jti` is consumed ONE-TIME-USE in the SAME `sso_connect_jtis`
 *    ledger, insert-first: a token spent here cannot then mint a key at
 *    `/sso/cli-connect`, and the other way round;
 *  - every verification failure (signature, iss, aud, purpose, expiry,
 *    replay) answers ONE uniform 401 — no oracle for probing tokens.
 *
 * Only after the token is spent does the route say whether a package
 * exists (404 `cli_not_packaged`): an unverified caller learns nothing
 * about the instance's release.
 */

export interface CliPackageRouteDeps {
  db: Db;
  hubSso: HubSsoService;
  /** What the boot read off `CLI_PACKAGE_DIR`; null = released without its CLI package. */
  cliPackage: CliPackage | null;
  logger: Logger;
  routes: { cliPackageRoute: typeof cliPackageRoute };
}

export function registerCliPackageRoutes(api: OpenAPIHono, deps: CliPackageRouteDeps): void {
  const { db, hubSso, cliPackage, logger } = deps;
  const { cliPackageRoute } = deps.routes;

  api.openapi(cliPackageRoute, async (c) => {
    const body = c.req.valid('json');

    // 1. Verify hard. One uniform 401 for every rejection reason.
    let assertion: HubConnectAssertion;
    try {
      assertion = await hubSso.verifyConnectToken(body.token);
    } catch (cause) {
      logger.warn({ err: cause }, 'cli package: exchange token rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 2. Burn the jti (one-time-use, G8), in the ledger /sso/cli-connect
    // burns into. Insert-first: the claim precedes any effect, so a replay —
    // even a concurrent one — downloads nothing. The sweep keeps the ledger
    // tiny; best-effort, never correctness-bearing (expired rows only shadow
    // jtis of already-expired tokens).
    void db
      .delete(ssoConnectJtis)
      .where(lt(ssoConnectJtis.expiresAt, sql`now() - interval '1 minute'`))
      .catch(() => {});
    const claimed = await db
      .insert(ssoConnectJtis)
      .values({ jti: assertion.jti, expiresAt: assertion.expiresAt })
      .onConflictDoNothing()
      .returning({ jti: ssoConnectJtis.jti });
    if (claimed.length === 0) {
      logger.warn({ jti: assertion.jti }, 'cli package: replayed jti rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 3. Released without its CLI package: say so, with a sentence the
    // `team` command can print as it is. The boot's read names what the
    // image packed; the file is statted again HERE, after the burn, so a
    // folder changed under a running instance answers the same 404 instead
    // of a 200 whose body and length disagree.
    const notPackaged = () =>
      c.json(
        err(
          'cli_not_packaged',
          'This instance was released without its CLI package, so it has none to serve'
        ),
        404
      );
    if (cliPackage === null) return notPackaged();
    let stat: Stats;
    try {
      stat = statSync(cliPackage.path);
    } catch (cause) {
      logger.error({ err: cause, path: cliPackage.path }, 'cli package: the tarball read at boot is gone');
      return notPackaged();
    }
    if (!stat.isFile()) {
      logger.error({ path: cliPackage.path }, 'cli package: the tarball read at boot is no longer a file');
      return notPackaged();
    }

    // 4. Stream the tarball. The bytes are the release's, never a person's,
    // but they are served as an attachment and never sniffed all the same;
    // no-store, so a shared cache never answers the next exchange.
    logger.info(
      {
        hubSub: assertion.sub,
        email: assertion.email,
        package: cliPackage.name,
        version: cliPackage.version
      },
      'cli package: served'
    );
    const nodeStream = createReadStream(cliPackage.path);
    // Backpressure rides Readable.toWeb; a client abort must destroy the
    // source or every abandoned download leaks a descriptor (files/serve.ts).
    c.req.raw.signal.addEventListener('abort', () => nodeStream.destroy());
    const web = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return c.body(web, 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${cliPackage.filename}"`,
      // The size statted now, never the boot's: the header and the bytes agree.
      'content-length': String(stat.size),
      // Also set on every response by the global security-headers middleware.
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
  });
}
