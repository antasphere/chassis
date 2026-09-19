import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';

/** Discovery-document cache lifetime; the JWKS itself is cached by jose. */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/**
 * Verifies hub-minted RS256 JWTs against the hub's REMOTE JWKS (discovered
 * via OIDC discovery at the issuer root) — the cloud edition's trust anchor
 * for "Sign in with Antasphere" (internal/federation.md). Same discipline as
 * the local OauthJwtVerifier: hard issuer pinning, per-call audience
 * pinning, RS256 allowlist (implicitly rejects none/HS256), small clock
 * tolerance. jose's remote key set self-refreshes on an unknown `kid`; a
 * signature failure on a KNOWN kid (rotation racing the cache) gets exactly
 * one retry against a freshly created key set.
 */
export class HubJwtVerifier {
  private discoveryCache: { jwksUri: string; fetchedAt: number } | null = null;
  private keySet: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly issuerUrl: string) {}

  private async jwksUri(): Promise<string> {
    if (this.discoveryCache && Date.now() - this.discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discoveryCache.jwksUri;
    }
    const url = this.issuerUrl.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hub discovery failed: ${res.status} ${url}`);
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    // The discovery document must claim the issuer we were configured to
    // trust — a mismatch means HUB_ISSUER_URL points at the wrong deployment
    // (or something impersonating it); fail closed before trusting its keys.
    if (doc.issuer !== this.issuerUrl) {
      throw new Error(`hub discovery issuer mismatch: expected ${this.issuerUrl}, got ${doc.issuer}`);
    }
    if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri) {
      throw new Error('hub discovery document carries no jwks_uri');
    }
    this.discoveryCache = { jwksUri: doc.jwks_uri, fetchedAt: Date.now() };
    return this.discoveryCache.jwksUri;
  }

  private async keys(forceRefresh = false) {
    const jwksUri = await this.jwksUri();
    if (!forceRefresh && this.keySet) return this.keySet;
    this.keySet = createRemoteJWKSet(new URL(jwksUri));
    return this.keySet;
  }

  /** Verify a hub JWT with the given audience pin; throws on any failure. */
  async verify(token: string, audience: string): Promise<JWTPayload> {
    const options: JWTVerifyOptions = {
      issuer: this.issuerUrl,
      // The hub access token's `aud` is an ARRAY when openid is scoped
      // ([<our resource>, <hub userinfo>]); jose accepts any element
      // matching, so pinning our own value stays exact.
      audience,
      algorithms: ['RS256'], // hard allowlist — implicitly rejects none/HS256
      clockTolerance: 5,
      requiredClaims: ['sub']
    };
    try {
      return (await jwtVerify(token, await this.keys(), options)).payload;
    } catch (err) {
      // One retry with fresh keys covers signing-key rotation mid-cache.
      // Two shapes mean "the cached keys may be stale": an unknown kid
      // (JWKSNoMatchingKey — jose's own refetch is cooldown-throttled and
      // may have been skipped) and a signature failure on a known kid.
      if (
        err instanceof Error &&
        (err.name === 'JWKSNoMatchingKey' || err.name === 'JWSSignatureVerificationFailed')
      ) {
        return (await jwtVerify(token, await this.keys(true), options)).payload;
      }
      throw err;
    }
  }
}
