import { z } from 'zod';

/**
 * CLI cross-tool connect (cloud edition only — internal/federation.md P5):
 *
 *   POST /sso/cli-connect — exchange a hub-minted 120 s JWT for an API key
 *
 * The counterpart of the hub's H3 `POST /sso/tool-token`: `antasphere login`
 * mints a hub API key once; the hub exchanges it for a short-lived RS256 JWT
 * (`aud` = THIS instance's resource URL, `purpose: 'sso-connect'`, unique
 * `jti`) PLUS a one-time raw offline-grant refresh token (`hubRefreshToken`,
 * scopes `offline_access account:read` — the HUB mints it, so it carries no
 * `orgs:create`: a CLI connect REPLACES the stored grant, and the person's
 * next workspace creation answers `hub_reauth_required` until they sign in
 * with the browser again), and this endpoint turns the pair
 * into an ordinary USER-scoped local API key — no tool-specific login, and
 * the stored grant drives the same live as-the-user hub org reads as a
 * browser SSO login's. PUBLIC path (the hub JWT IS the credential),
 * rate-limited, jti one-time-use. Registered ONLY on EDITION=cloud; an oss
 * instance answers 404 (the route does not exist there).
 *
 * The response reuses the CLI-auth completion shape (`CliAuthCompleted`) —
 * the tool's read + write scopes, never its export scope, full key
 * shown exactly once; `workspaceId` is null (user-scoped, unpinned).
 */

export const ssoCliConnectSchema = z.object({
  /** The hub-minted exchange JWT (compact JWS — three base64url segments). */
  token: z.string().min(20).max(4096),
  /**
   * The raw one-time offline-grant refresh token from the SAME H3 response
   * (`hubRefreshToken`). Stored encrypted on the account row — it is what
   * keeps a headless CLI user's org reads LIVE between browser logins.
   * Optional on the wire for older clients, but a connect that carries none
   * is refused unless a prior grant already exists (a key must never be
   * minted born-dead).
   */
  hubRefreshToken: z.string().min(20).max(512).optional()
});
export type SsoCliConnect = z.infer<typeof ssoCliConnectSchema>;
