import { z } from 'zod';

/**
 * The tool's own CLI package (cloud edition only, PRDCT-3312):
 *
 *   POST /cli/package — download the CLI package the release packed, on a
 *   hub-minted 120 s exchange JWT
 *
 * The same token the hub's `POST /sso/tool-token` mints for
 * `/sso/cli-connect` (`aud` = THIS instance's resource URL,
 * `purpose: 'sso-connect'`, unique `jti`), consumed one-time-use in the same
 * ledger: a token spent here mints no key at `/sso/cli-connect`, and the
 * other way round. The hub mints it only for a member it lets into the
 * tool, which is what this route rests on. The token rides in the BODY and
 * never in `Authorization`: a machine credential on the path meets the
 * scope gate's 403 `endpoint_not_allowed`.
 */
export const cliPackageRequestSchema = z.object({
  /** The hub-minted exchange JWT (compact JWS — three base64url segments). */
  token: z.string().min(1)
});
export type CliPackageRequest = z.infer<typeof cliPackageRequestSchema>;
