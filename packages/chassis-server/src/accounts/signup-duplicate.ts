/**
 * True when a failed `signUpEmail` means "this email already has an account":
 * either Better Auth's own pre-check (APIError USER_ALREADY_EXISTS / 422) or,
 * in the tight concurrent-signup race where two callers pass an account lookup
 * together, the losing INSERT's Postgres unique_violation (23505) on the user
 * email — found anywhere down the wrapped error's `cause` chain.
 *
 * Shared by every public account-minting endpoint (invitation accept,
 * collaborator claim): the existence-revealing 409 is answered ONLY here, after
 * the caller has committed real credentials, so a credential-less probe can
 * never read it (PRDCT-1437).
 */
export function isDuplicateAccountError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 10; cur = cur.cause, depth++) {
    const anyErr = cur as { code?: unknown; status?: unknown; body?: { code?: unknown } };
    if (anyErr.code === '23505') return true;
    if (anyErr.body?.code === 'USER_ALREADY_EXISTS') return true;
    if (anyErr.status === 'UNPROCESSABLE_ENTITY' || anyErr.status === 422) return true;
  }
  return false;
}
