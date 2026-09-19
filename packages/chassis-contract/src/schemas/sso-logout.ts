import { z } from 'zod';

/**
 * POST /api/v1/sso/logout (cloud edition ONLY — oss answers the JSON 404
 * terminator): the single-logout server leg. The server has ALREADY revoked
 * the local session and cleared the shared hint cookie by the time this
 * body arrives; `url` is the hub RP-initiated-logout URL the browser must
 * now VISIT to end the hub anchor session (it lands back on
 * `/login?signed_out=1`). `null` = no hub leg was possible (no stored
 * id_token, a pre-flip sid-less one, hub unreachable) — the client goes to
 * `/login?signed_out=1` directly; the LOCAL signout already happened either
 * way.
 */
export const ssoLogoutResponseSchema = z.object({
  url: z.string().nullable()
});
export type SsoLogoutResponse = z.infer<typeof ssoLogoutResponseSchema>;
