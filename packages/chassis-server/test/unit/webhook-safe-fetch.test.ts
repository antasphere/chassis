import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkWebhookUrl,
  isPublicAddress,
  safePost,
  WebhookUrlRefusedError,
  type SafeFetchPolicy,
  type SafeTransport
} from '../../src/webhooks/safe-fetch.js';

/**
 * The guarded webhook POST: a POST never reaches the instance's own network
 * unless the operator opened it. Real local servers on 127.0.0.1 stand in
 * for the receiver; the lookup and transport seams stand in for DNS.
 */

const CLOSED: SafeFetchPolicy = { allowPrivateNetworks: false, httpsOnly: false };
const OPEN: SafeFetchPolicy = { allowPrivateNetworks: true, httpsOnly: false };
const CLOUD: SafeFetchPolicy = { allowPrivateNetworks: false, httpsOnly: true };

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const seen: Seen[] = [];
let base = '';
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8')
    });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' });
      res.end('moved');
    } else if (req.url === '/silent') {
      // never answers
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200 * 1024));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The URL checks refuse a non-default port, so the local server is reached through the transport seam. */
function viaLocalServer(): SafeTransport {
  return (url, init, signal) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${url.pathname}${url.search}`,
        { method: init.method, headers: init.headers, signal, agent: false },
        (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res })
      );
      req.on('error', reject);
      req.end(init.body);
    });
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookUrlRefusedError);
    return (e as WebhookUrlRefusedError).code;
  }
  throw new Error('expected a refusal');
}

function refusedSync(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookUrlRefusedError);
    return (e as WebhookUrlRefusedError).code;
  }
  throw new Error('expected a refusal');
}

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fc00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['2002:7f00:1::', false],
    ['2001:db8::1', false],
    ['8.8.8.8', true],
    ['2606:4700::1111', true],
    ['nonsense', false]
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('checkWebhookUrl', () => {
  it('refuses a scheme other than http and https', () => {
    expect(refusedSync(() => checkWebhookUrl('ftp://example.com/', CLOSED))).toBe('scheme');
  });

  it('refuses userinfo', () => {
    expect(refusedSync(() => checkWebhookUrl('http://user:pw@example.com/', CLOSED))).toBe('userinfo');
  });

  it('refuses a port that is not the scheme default', () => {
    expect(refusedSync(() => checkWebhookUrl('http://example.com:8080/', CLOSED))).toBe('port');
    expect(refusedSync(() => checkWebhookUrl('https://example.com:80/', CLOSED))).toBe('port');
  });

  it('accepts any port once private networks are open (a LAN service on its own port)', () => {
    expect(checkWebhookUrl('http://192.168.1.20:5678/webhook', OPEN).port).toBe('5678');
    expect(checkWebhookUrl('http://example.com:8080/', OPEN).port).toBe('8080');
  });

  it('takes an explicit default port as the default (the parser drops it, the rule is url.port === "")', () => {
    expect(checkWebhookUrl('http://example.com:80/', CLOSED).href).toBe('http://example.com/');
    expect(checkWebhookUrl('https://example.com:443/', CLOSED).href).toBe('https://example.com/');
  });

  it('refuses a private literal address by default, accepts it when private networks are open', () => {
    expect(refusedSync(() => checkWebhookUrl('http://127.0.0.1/', CLOSED))).toBe('private_address');
    expect(refusedSync(() => checkWebhookUrl('http://[::1]/', CLOSED))).toBe('private_address');
    expect(refusedSync(() => checkWebhookUrl('http://2130706433/', CLOSED))).toBe('private_address');
    expect(checkWebhookUrl('http://127.0.0.1/', OPEN).hostname).toBe('127.0.0.1');
  });

  it('refuses http under httpsOnly and accepts https', () => {
    expect(refusedSync(() => checkWebhookUrl('http://example.com/', CLOUD))).toBe('https_required');
    expect(checkWebhookUrl('https://example.com/', CLOUD).href).toBe('https://example.com/');
  });

  it('refuses what is not a URL', () => {
    expect(refusedSync(() => checkWebhookUrl('not a url', CLOSED))).toBe('malformed');
  });
});

describe('safePost against a loopback receiver', () => {
  it('refuses the loopback address by default, and the receiver never sees a request', async () => {
    const before = seen.length;
    // a literal loopback address, refused before any connection
    expect(await refusal(safePost('http://127.0.0.1/hook', {}, '{}', CLOSED))).toBe('private_address');
    // a name resolving to loopback, refused by the DEFAULT transport's socket lookup (no seam
    // transport: the check that runs is the one inside node's connect)
    const asked: string[] = [];
    expect(
      await refusal(
        safePost('http://receiver.test/hook', {}, '{}', CLOSED, {
          lookup: async (host) => {
            asked.push(host);
            return [{ address: '127.0.0.1', family: 4 }];
          }
        })
      )
    ).toBe('private_address');
    expect(asked).toEqual(['receiver.test']);
    expect(seen.length).toBe(before);
  });

  it('delivers when private networks are open: the method, the headers and the exact body', async () => {
    const body = JSON.stringify({ event: 'thing.created', note: 'déjà vu' });
    const result = await safePost(
      'http://receiver.test/hook',
      { 'content-type': 'application/json', 'x-signature': 'sig-1', 'Content-Length': '1' },
      body,
      OPEN,
      { lookup: async () => [{ address: '127.0.0.1', family: 4 }], transport: viaLocalServer() }
    );
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const got = seen.at(-1)!;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/hook');
    expect(got.body).toBe(body);
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['x-signature']).toBe('sig-1');
    expect(got.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(got.headers['user-agent']).toBeUndefined();
  });

  it('returns a 302 as its status and never requests the Location', async () => {
    const before = seen.length;
    const result = await safePost('http://receiver.test/redirect', {}, 'x', OPEN, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: viaLocalServer()
    });
    expect(result.status).toBe(302);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.slice(before).map((s) => s.url)).toEqual(['/redirect']);
  });

  it('the REAL transport (no seam) answers a 302 as its status and never requests the Location (verifier round 1, G2)', async () => {
    // A second loopback server is the Location's target: it must see nothing.
    const targetSeen: string[] = [];
    const target = http.createServer((req, res) => {
      targetSeen.push(req.url ?? '');
      res.writeHead(200);
      res.end('followed');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`;
    const redirector = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(302, { location: targetUrl });
        res.end('moved');
      });
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/redirect`;
    try {
      // OPEN lifts the address rule and the port rule: the ephemeral ports are reached directly.
      const result = await safePost(redirectorUrl, {}, 'x', OPEN, { timeoutMs: 2000 });
      expect(result.status).toBe(302);
      expect(result.bodyText).toBe('moved');
      await new Promise((r) => setTimeout(r, 100));
      expect(targetSeen).toEqual([]);
    } finally {
      for (const s of [redirector, target]) {
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
  });

  it('a receiver that never answers: the timeout rejects with an abort error', async () => {
    const started = Date.now();
    const err = await safePost('http://receiver.test/silent', {}, 'x', OPEN, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: viaLocalServer(),
      timeoutMs: 300
    }).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(WebhookUrlRefusedError);
    expect(['AbortError', 'TimeoutError']).toContain(err!.name);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('cuts the response body at maxResponseBytes and resolves promptly', async () => {
    const started = Date.now();
    const result = await safePost('http://receiver.test/big', {}, 'x', OPEN, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: viaLocalServer(),
      maxResponseBytes: 1024
    });
    expect(result.status).toBe(200);
    expect(result.bodyText.length).toBe(1024);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('safePost through the lookup seam', () => {
  let transportCalls = 0;
  const transport: SafeTransport = async () => {
    transportCalls++;
    return { status: 200, headers: {}, body: Readable.from([Buffer.from('ok')]) };
  };

  it('refuses a name when ONE of its addresses is private', async () => {
    transportCalls = 0;
    const code = await refusal(
      safePost('https://example.test/hook', {}, '{}', CLOSED, {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 }
        ],
        transport
      })
    );
    expect(code).toBe('private_address');
    expect(transportCalls).toBe(0);
  });

  it('refuses a name that resolves to nothing, even with private networks open', async () => {
    transportCalls = 0;
    for (const policy of [CLOSED, OPEN]) {
      const code = await refusal(
        safePost('https://example.test/hook', {}, '{}', policy, { lookup: async () => [], transport })
      );
      expect(code).toBe('unresolvable');
    }
    expect(transportCalls).toBe(0);
  });

  it('passes a name whose every address is public', async () => {
    transportCalls = 0;
    const result = await safePost('https://example.test/hook', {}, '{}', CLOUD, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport
    });
    expect(result).toMatchObject({ status: 200, bodyText: 'ok' });
    expect(transportCalls).toBe(1);
  });
});
