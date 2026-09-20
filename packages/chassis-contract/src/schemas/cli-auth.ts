import { z } from 'zod';
import { plainText } from './common.js';

/**
 * Browserless CLI/agent sign-in: email OTP → API key. Two PUBLIC (pre-auth)
 * endpoints, mounted like /setup outside the principal machinery:
 *
 *   POST /cli/auth/request  — send a 6-digit sign-in code to the email
 *   POST /cli/auth/complete — verify the code, mint an API key
 *
 * Sign-up stays CLOSED: the flow rides the emailOTP plugin with
 * `disableSignUp: true`, so a code only ever signs in an EXISTING account
 * (created via setup, a workspace invitation, or a collaborator claim).
 * `request` answers a generic success for unknown emails (no enumeration);
 * `complete` for an unknown email fails exactly like a wrong code. On the
 * CLOUD edition both refuse (403 cli_otp_disabled) — hub-only login (D1).
 *
 * DELETE /cli/auth/key is the logout counterpart: it revokes exactly the
 * PRESENTING API key (self-revocation — possession is the authority to kill
 * itself), machine-allowed under the tool's write scope in the scope allowlist.
 */

export const cliAuthRequestSchema = z.object({
  email: z.email()
});
export type CliAuthRequest = z.infer<typeof cliAuthRequestSchema>;

/** Always `sent: true` on 2xx — deliberately silent about account existence. */
export const cliAuthRequestedSchema = z.object({
  sent: z.literal(true)
});
export type CliAuthRequested = z.infer<typeof cliAuthRequestedSchema>;

export const cliAuthCompleteSchema = z.object({
  email: z.email(),
  otp: z.string().min(4).max(16),
  /** Display name for the minted key (defaults to a CLI-login label). */
  keyName: plainText(1, 120).optional(),
  /** TTL at mint; the server computes the absolute expiry. Omit = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Optional workspace PIN (least privilege) — the account must hold an
   * ACTIVE membership of it. Omit for a user-scoped key (the default): it
   * acts as you in whichever of your workspaces each request names
   * (X-Workspace-Id / your default membership).
   */
  workspaceId: z.uuid().optional()
});
export type CliAuthComplete = z.infer<typeof cliAuthCompleteSchema>;

/** DELETE /cli/auth/key — the presenting key was revoked (CLI logout). */
export const cliAuthRevokedSchema = z.object({
  revoked: z.literal(true),
  id: z.string()
});
export type CliAuthRevoked = z.infer<typeof cliAuthRevokedSchema>;

/**
 * The one CLI-auth schema that embeds the API key (and with it the tool's
 * scope vocabulary): built per tool (../define.ts).
 */
export function defineCliAuthSchemas<TApiKey extends z.ZodType>(apiKeySchema: TApiKey) {
  /** The full key appears exactly once, in this response (API-key semantics). */
  const cliAuthCompletedSchema = z.object({
    /** Full key `<prefix>_<keyid>_<secret>` — shown once, never retrievable. */
    key: z.string(),
    apiKey: apiKeySchema,
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string()
    }),
    /** The workspace the key is PINNED to; null = user-scoped (unpinned). */
    workspaceId: z.string().nullable()
  });

  return { cliAuthCompletedSchema };
}
