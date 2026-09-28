import { describe, expect, it } from 'vitest';
import {
  DEMO_PASS_DEFAULT_MINUTES,
  DEMO_PASS_MAX_MINUTES,
  DEMO_SESSION_REFUSED_AUTH_PATHS,
  demoSessionAuthRefusal,
  isDemoAddress,
  isDemoSignInHost,
  isSafeDemoPath,
  parseDemoEmailDomains,
  parseDemoHosts
} from '@antasphere/chassis-server/identity';
import { INSECURE_SETUP_ORIGINS, SECURE_SETUP_ORIGINS } from '@antasphere/chassis-server/testing';

/**
 * The demo pass's pure rules (the demo pass spec, sections 1 to 3). A pass is
 * a sign-in-equivalent link, so every one of these is a boundary: the host
 * the switch may be on, the addresses a pass may open, the page it lands on.
 */

const NONE: ReadonlySet<string> = new Set();

describe('the lifetime constants', () => {
  it('default to one day and stop at one week', () => {
    expect(DEMO_PASS_DEFAULT_MINUTES).toBe(1440);
    expect(DEMO_PASS_MAX_MINUTES).toBe(10080);
  });
});

describe('parseDemoHosts / parseDemoEmailDomains', () => {
  it('are empty for unset and blank input', () => {
    expect(parseDemoHosts(undefined).size).toBe(0);
    expect(parseDemoHosts('').size).toBe(0);
    expect(parseDemoHosts('   ').size).toBe(0);
    expect(parseDemoEmailDomains(undefined).size).toBe(0);
  });

  it('trim, lowercase and dedupe the entries', () => {
    const set = parseDemoHosts(' Demo.Example.io ,staging.acme.test, demo.example.io');
    expect([...set].sort()).toEqual(['demo.example.io', 'staging.acme.test']);
  });

  it.each([
    ['a scheme', 'https://demo.example.io', /scheme/],
    ['a path', 'demo.example.io/app', /path/],
    ['a port', 'demo.example.io:8443', /port/],
    ['a space', 'demo example.io', /space/],
    ['a wildcard', '*.example.io', /wildcard/],
    ['an empty label', 'demo..example.io', /empty label/],
    ['a leading dot', '.example.io', /empty label/],
    ['a trailing dot', 'example.io.', /empty label/],
    ['a character no hostname carries', 'demo_host.example.io', /not a hostname/]
  ])('refuse an entry with %s, naming the variable and the entry', (_what, entry, reason) => {
    expect(() => parseDemoHosts(`ok.example.io,${entry}`)).toThrow(reason);
    expect(() => parseDemoHosts(entry)).toThrow(/DEMO_SIGN_IN_HOSTS/);
    expect(() => parseDemoEmailDomains(entry)).toThrow(/DEMO_SIGN_IN_EMAIL_DOMAINS/);
  });

  it('refuse a list of separators only rather than arm an empty one', () => {
    expect(() => parseDemoHosts(',,')).toThrow(/at least one hostname/);
  });
});

describe('isDemoSignInHost: loopback, or listed exactly', () => {
  // The loopback half of the setup-origin table: every plaintext origin the
  // setup wizard accepts is loopback by construction (the https ones are
  // accepted there for their transport, which says nothing about the host).
  const LOOPBACK = SECURE_SETUP_ORIGINS.filter((url) => url.startsWith('http://'));
  const PUBLIC = [
    ...SECURE_SETUP_ORIGINS.filter((url) => url.startsWith('https://')),
    ...INSECURE_SETUP_ORIGINS
  ];

  it.each(LOOPBACK)('accepts %s with an empty list', (url) => {
    expect(isDemoSignInHost(url, NONE)).toBe(true);
  });

  it.each(PUBLIC)('REFUSES %s with an empty list (look-alike hosts included)', (url) => {
    expect(isDemoSignInHost(url, NONE)).toBe(false);
  });

  it('accepts a public host once it is listed, and only that exact host', () => {
    const hosts = parseDemoHosts('platform.example.com');
    expect(isDemoSignInHost('https://platform.example.com', hosts)).toBe(true);
    expect(isDemoSignInHost('https://PLATFORM.example.com/base', hosts)).toBe(true);
    expect(isDemoSignInHost('https://app.platform.example.com', hosts)).toBe(false);
    expect(isDemoSignInHost('https://platform.example.com.evil.test', hosts)).toBe(false);
  });

  it('fails closed on anything it cannot parse', () => {
    expect(isDemoSignInHost('not a url', NONE)).toBe(false);
    expect(isDemoSignInHost('', parseDemoHosts('localhost'))).toBe(false);
  });
});

describe('isDemoAddress: reserved example and test domains, or an operator-listed one', () => {
  it.each([
    'a@example.com',
    'a@example.net',
    'a@example.org',
    'a@sub.example.org',
    'a@team.test',
    'a@x.localhost',
    'a@shop.example',
    'a@nowhere.invalid',
    'A@EXAMPLE.COM',
    'a@Team.Test'
  ])('accepts %s', (email) => {
    expect(isDemoAddress(email, NONE)).toBe(true);
  });

  it.each([
    'a@notexample.com',
    'a@example.com.evil.io',
    'a@gmail.com',
    'a@testing.io',
    'a@test.io',
    '"a@example.com"@gmail.com',
    'a@example.com@gmail.com',
    'a@.test',
    'a@example..com',
    'a@',
    '@example.com',
    'no-at-sign.example.com'
  ])('refuses %s', (email) => {
    expect(isDemoAddress(email, NONE)).toBe(false);
  });

  it('judges the part after the LAST @', () => {
    expect(isDemoAddress('"a@gmail.com"@example.com', NONE)).toBe(true);
  });

  it('adds the operator domains and their subdomains, on a label boundary', () => {
    const extra = parseDemoEmailDomains('demo.acme.io');
    expect(isDemoAddress('a@demo.acme.io', extra)).toBe(true);
    expect(isDemoAddress('a@eu.demo.acme.io', extra)).toBe(true);
    expect(isDemoAddress('A@DEMO.ACME.IO', extra)).toBe(true);
    expect(isDemoAddress('a@acme.io', extra)).toBe(false);
    expect(isDemoAddress('a@xdemo.acme.io', extra)).toBe(false);
    expect(isDemoAddress('a@demo.acme.io.evil.test.com', extra)).toBe(false);
  });
});

describe('isSafeDemoPath: one leading slash, no fragment, no control character', () => {
  it.each(['/', '/decks/1?x=1', '/settings/members', '/a/b?c=d&e=%2F'])('accepts %s', (path) => {
    expect(isSafeDemoPath(path)).toBe(true);
  });

  it('accepts a path of exactly 2048 characters', () => {
    expect(isSafeDemoPath('/' + 'a'.repeat(2047))).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['protocol-relative', '//evil'],
    ['backslash-relative', '/\\evil'],
    ['relative', 'decks'],
    ['absolute URL', 'https://evil.test/'],
    ['a fragment', '/a#b'],
    ['a space', '/a b'],
    ['a control character', '/a\u0001b'],
    ['a newline', '/a\nb'],
    ['DEL', '/a\u007fb'],
    ['2049 characters', '/' + 'a'.repeat(2048)]
  ])('refuses %s', (_what, path) => {
    expect(isSafeDemoPath(path)).toBe(false);
  });
});

describe('demoSessionAuthRefusal: what a pass’s session may not do at the sign-in library', () => {
  it('refuses every listed path', () => {
    expect(DEMO_SESSION_REFUSED_AUTH_PATHS.length).toBe(27);
    for (const path of DEMO_SESSION_REFUSED_AUTH_PATHS) {
      expect(demoSessionAuthRefusal(path), path).toBe(true);
    }
    // A session's dynamic client registration stores the client under the person.
    expect(demoSessionAuthRefusal('/oauth2/register')).toBe(true);
  });

  it('refuses them whatever the case, and with one trailing slash', () => {
    expect(demoSessionAuthRefusal('/Change-Password')).toBe(true);
    expect(demoSessionAuthRefusal('/OAUTH2/AUTHORIZE')).toBe(true);
    expect(demoSessionAuthRefusal('/change-password/')).toBe(true);
    expect(demoSessionAuthRefusal('/Two-Factor/Enable/')).toBe(true);
  });

  it('allows reading the session, signing out, signing in and redeeming', () => {
    for (const path of ['/get-session', '/sign-out', '/sign-in/email', '/demo/redeem']) {
      expect(demoSessionAuthRefusal(path), path).toBe(false);
    }
  });
});
