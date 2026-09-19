/**
 * Transport guard for the one-shot first-boot wizard (PLT-10).
 *
 * `POST /api/v1/setup` carries the owner's password and the setup token. Over
 * plaintext HTTP to a non-loopback origin both cross the network in the clear
 * — and this is the single request that decides who owns the instance. The
 * documented no-domain install path used to walk operators straight into
 * exactly that, so the server refuses instead of trusting the runbook.
 *
 * Loopback is fine: nothing leaves the host, which is what makes the
 * `ssh -L` tunnel a legitimate way to finish setup on a server with no TLS
 * yet. `https` is fine anywhere. Everything else needs the conscious
 * `ALLOW_INSECURE_SETUP=true` opt-in.
 */
export function isSecureSetupOrigin(publicBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    // Unparseable never reaches here (the env schema validates a URL), and a
    // guard that cannot read the origin must fail closed.
    return false;
  }
  if (url.protocol === 'https:') return true;
  return isLoopbackHost(url.hostname);
}

/**
 * `URL.hostname` KEEPS the brackets around an IPv6 literal (`[::1]`), so they
 * are stripped here. IPv4 loopback is the whole 127.0.0.0/8 block, not just
 * 127.0.0.1.
 */
function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    return octets[0] === 127;
  }
  return false;
}
