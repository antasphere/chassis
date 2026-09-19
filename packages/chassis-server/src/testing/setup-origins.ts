/**
 * The single URL table for the setup-transport rule (PLT-10).
 *
 * The rule is implemented TWICE on purpose: in TypeScript, where the server
 * enforces it (`apps/server/src/setup-transport.ts`), and in shell, where
 * setup.sh has to warn the operator before they discover it as a 403
 * (`dr_origin_is_secure` in scripts/lib/dr-lib.sh). Two implementations of a
 * security rule drift — the first shell version accepted
 * `http://localhost.evil.test` as loopback — so both are driven from this one
 * table, by test/unit/setup-transport.test.ts here and the app's test/unit/dr-lib.test.ts.
 *
 * Add a case here and BOTH implementations have to satisfy it. The contract for
 * anything NOT listed: the shell twin may be stricter than the server (it only
 * decides whether to print a warning) but never looser, because looser means
 * setup.sh reassures the operator about an origin the server is about to 403.
 */

/** POST /api/v1/setup is accepted on these origins. */
export const SECURE_SETUP_ORIGINS = [
  // https anywhere: the credentials are protected in transit.
  'https://platform.example.com',
  'https://10.0.0.4:8443',
  'https://platform.example.com/base',
  // Plaintext on loopback: nothing leaves the host, which is what makes the
  // `ssh -L` tunnel a legitimate way to finish setup on a TLS-less server.
  'http://localhost:3000',
  'http://LOCALHOST:3000',
  'http://localhost',
  'http://app.localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.1.2.3:3000', // the whole 127.0.0.0/8 block is loopback
  'http://127.0.0.1',
  // URL parsing normalises dotted-shorthand IPv4: `127.0.0` IS 127.0.0.0 and
  // `127.1` IS 127.0.0.1. Both are loopback, and both really do connect there.
  'http://127.0.0:3000',
  'http://127.1:3000',
  'http://[::1]:3000',
  'http://[::1]'
] as const;

/** POST /api/v1/setup is refused on these origins without the explicit opt-in. */
export const INSECURE_SETUP_ORIGINS = [
  'http://platform.example.com',
  'http://platform.example.com:8080',
  'http://203.0.113.10:3000',
  'http://10.0.0.4:3000',
  'http://192.168.1.20:3000',
  // Hostnames somebody else controls that merely LOOK like loopback. A
  // prefix/suffix match on the raw URL accepts every one of these.
  'http://localhost.evil.test:3000',
  'http://127.0.0.1.evil.test:3000',
  'http://notlocalhost:3000',
  'http://[::2]:3000',
  'http://[2001:db8::1]:3000',
  // 127-ish but not in 127.0.0.0/8: a hostname, not an address.
  'http://1270.0.0.1:3000',
  'http://127a.0.0.1:3000'
] as const;
