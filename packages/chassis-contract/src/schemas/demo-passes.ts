import { z } from 'zod';

/**
 * A DEMO PASS is a link an owner mints so that one member of the workspace
 * is signed in without a password, for a demonstration (the demo pass spec).
 * The routes exist only while the instance's DEMO_SIGN_IN switch is on, on
 * the self-hosted edition; `GET /instance` says so with `demoSignIn: true`.
 * The secret is shown once, in the mint's answer, and stored nowhere.
 */

/** A pass's lifetime when the mint names none: one day, in minutes. */
export const DEMO_PASS_DEFAULT_MINUTES = 1440;
/** The longest lifetime a mint may ask for: one week, in minutes. */
export const DEMO_PASS_MAX_MINUTES = 10080;

export const demoPassSchema = z.object({
  id: z.string(),
  /** The person the pass signs in. */
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  /** The page the link lands on. */
  targetPath: z.string(),
  /** The owner who minted it; null once that account is gone. */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  /** How many sessions the pass has opened. */
  useCount: z.number().int()
});
export type DemoPass = z.infer<typeof demoPassSchema>;

export const demoPassesListSchema = z.object({ passes: z.array(demoPassSchema) });
export type DemoPassesList = z.infer<typeof demoPassesListSchema>;

/**
 * The mint: a member of the caller's workspace by address, the page the link
 * lands on (a same-origin path, checked by the server), and a lifetime.
 */
export const demoPassMintSchema = z.object({
  email: z.email(),
  path: z.string().optional(),
  expiresInMinutes: z.number().int().min(1).max(DEMO_PASS_MAX_MINUTES).optional()
});
export type DemoPassMint = z.infer<typeof demoPassMintSchema>;

export const demoPassMintedSchema = z.object({
  pass: demoPassSchema,
  /** The secret itself: shown here once, never again. */
  secret: z.string(),
  /** `<PUBLIC_BASE_URL>/demo#pass=<secret>&to=<path>`: the fragment never reaches a server log. */
  url: z.string()
});
export type DemoPassMinted = z.infer<typeof demoPassMintedSchema>;

/**
 * `POST /api/v1/auth/demo/redeem`: served by the sign-in library itself (so
 * its own cookie and hooks apply), hence no route contract; these two
 * shapes are the wire the SDK's `redeemDemoPass` speaks.
 */
export const demoPassRedeemSchema = z.object({ pass: z.string().min(1) });
export type DemoPassRedeem = z.infer<typeof demoPassRedeemSchema>;

export const demoPassRedeemedSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  /** The pass's page: where the dashboard goes when the link names none. */
  path: z.string(),
  /** When the PASS expires (the session it opened keeps its own lifetime). */
  expiresAt: z.string()
});
export type DemoPassRedeemed = z.infer<typeof demoPassRedeemedSchema>;
