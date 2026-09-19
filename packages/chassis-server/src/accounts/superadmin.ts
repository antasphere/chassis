/**
 * Break-glass superadmin recognition (ADR 010).
 *
 * The capability is env-derived and off by default: `SUPERADMIN_EMAILS` is a
 * comma-separated allowlist, and a caller is superadmin ONLY when all three
 * hold at once:
 *
 *   1. the request carries a Better Auth SESSION (never a machine credential —
 *      the break-glass routes are unlisted in the fail-closed scope allowlist,
 *      and the handlers resolve the session directly);
 *   2. the session user's email is on the allowlist;
 *   3. that email is VERIFIED (`user.email_verified`) — an unverified match
 *      must never qualify, or squatting an allowlisted address would be enough.
 *
 * There is deliberately NO persistent DB super-role: unset/empty env means no
 * superadmin exists and the capability is fully dormant.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse `SUPERADMIN_EMAILS` into a lowercased set (Better Auth stores emails
 * lowercased, so membership checks compare in that form).
 *
 * Throws on malformed entries so the env schema fails LOUDLY at boot — a typo
 * must never silently disarm break-glass. `undefined` (unset/blank through
 * `blankToUndefined`) yields the empty set: dormant.
 */
export function parseSuperadminEmails(raw: string | undefined): Set<string> {
  const allowlist = new Set<string>();
  if (raw === undefined || raw.trim() === '') return allowlist;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error('SUPERADMIN_EMAILS must list at least one email address');
  }
  for (const entry of entries) {
    if (!EMAIL_RE.test(entry)) {
      throw new Error(`SUPERADMIN_EMAILS entry "${entry}" is not a valid email address`);
    }
    allowlist.add(entry.toLowerCase());
  }
  return allowlist;
}
