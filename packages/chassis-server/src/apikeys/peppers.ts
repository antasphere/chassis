/**
 * Versioned API-key peppers — the seam that lets API keys survive an
 * AUTH_SECRET rotation (ADR 008).
 *
 * Version 1 is ALWAYS the pepper that hashed keys before versioning existed:
 * the resolved auth secret, used verbatim as `sha256(secret + pepper)`. With
 * no `API_KEY_PEPPERS` set the registry is exactly `{ 1: authSecret }` and
 * new keys mint at version 1 — byte-identical to the pre-versioning
 * behaviour, nothing to migrate.
 *
 * `API_KEY_PEPPERS` supplies additional versions as `<version>:<secret>`
 * entries joined by `;` (e.g. `1:<old secret>;2:<new pepper>`). Entries
 * override the defaults, so pinning `1:<value>` freezes version 1
 * independently of the live AUTH_SECRET — the first step of the rotation
 * runbook in internal/security-runbooks.md. LOUD RULE: whenever version 1 is pinned, its
 * value MUST be the historical AUTH_SECRET-derived pepper (the secret that
 * was live when the version-1 keys were minted), or every existing key stops
 * resolving. New keys always mint under the HIGHEST version in the registry.
 *
 * Resolution looks up the pepper by the key row's stored `pepper_version`
 * and FAILS CLOSED on a version the registry does not contain — same 401 as
 * a revoked key, never a fallback to another pepper.
 */

/** `pepper_version` is a Postgres smallint. */
export const MAX_PEPPER_VERSION = 32767;

/** Peppers hold the same bar as AUTH_SECRET. */
const MIN_PEPPER_LENGTH = 32;

export interface PepperRegistry {
  /** The version new keys are minted under — the highest defined. */
  readonly current: number;
  /** True when API_KEY_PEPPERS explicitly pins version 1 (rotation-safe). */
  readonly v1Pinned: boolean;
  /** The pepper for a stored version, or undefined — the caller MUST fail closed. */
  get(version: number): string | undefined;
  /**
   * Every registered version, ascending. For credentials that carry no
   * version indicator (share-token secrets, whose sha256 IS the DB lookup
   * key), resolution computes the candidate hash under EACH version — the
   * registry has one entry per rotation, so this stays O(rotations).
   */
  readonly versions: readonly number[];
}

/**
 * Parse the `API_KEY_PEPPERS` value into a version→secret map. Throws a
 * readable Error on any malformed entry — surfaced by the env schema, so a
 * bad value refuses boot instead of silently mis-hashing keys.
 */
export function parseApiKeyPeppers(raw: string): Map<number, string> {
  const map = new Map<number, string>();
  // Trailing/duplicated separators are operator noise, not errors.
  const entries = raw
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    throw new Error('API_KEY_PEPPERS is set but contains no <version>:<secret> entries');
  }
  for (const entry of entries) {
    // Split at the FIRST colon only — the secret itself may contain colons.
    const colon = entry.indexOf(':');
    if (colon <= 0) {
      throw new Error(`API_KEY_PEPPERS entry "${describeEntry(entry)}" is not <version>:<secret>`);
    }
    const versionPart = entry.slice(0, colon).trim();
    const secret = entry.slice(colon + 1);
    if (!/^[0-9]+$/.test(versionPart)) {
      // A reversed `<secret>:<version>` entry makes versionPart the whole
      // secret — truncate so a misconfiguration doesn't echo it to stderr.
      throw new Error(`API_KEY_PEPPERS version "${describeEntry(versionPart)}" is not a positive integer`);
    }
    const version = Number(versionPart);
    if (version < 1 || version > MAX_PEPPER_VERSION) {
      throw new Error(`API_KEY_PEPPERS version ${version} is out of range (1..${MAX_PEPPER_VERSION})`);
    }
    if (map.has(version)) {
      throw new Error(`API_KEY_PEPPERS defines version ${version} twice`);
    }
    if (secret.length < MIN_PEPPER_LENGTH) {
      throw new Error(
        `API_KEY_PEPPERS version ${version} secret is shorter than ${MIN_PEPPER_LENGTH} characters`
      );
    }
    map.set(version, secret);
  }
  return map;
}

/** Error context that never echoes a possible secret: version side only. */
function describeEntry(entry: string): string {
  const head = entry.slice(0, Math.min(8, entry.length));
  return entry.length > 8 ? `${head}…` : head;
}

/**
 * Build the registry from the resolved auth secret plus the optional
 * `API_KEY_PEPPERS` value (already format-validated by the env schema; this
 * re-parses so direct callers get the same guarantees).
 */
export function buildPepperRegistry(authSecret: string, apiKeyPeppers?: string): PepperRegistry {
  const peppers = new Map<number, string>([[1, authSecret]]);
  let v1Pinned = false;
  if (apiKeyPeppers !== undefined) {
    const parsed = parseApiKeyPeppers(apiKeyPeppers);
    v1Pinned = parsed.has(1);
    for (const [version, secret] of parsed) peppers.set(version, secret);
  }
  const current = Math.max(...peppers.keys());
  return {
    current,
    v1Pinned,
    get: (version) => peppers.get(version),
    versions: [...peppers.keys()].sort((a, b) => a - b)
  };
}
