import { describe, expect, it } from 'vitest';
import { PUBLIC_DOCS_SITE_URL, buildEnvSchema, siteUrl } from '../../src/env.js';

/**
 * DOCS_SITE_URL (PRDCT-4110): the docs site an instance sends its people to.
 * Blank means the public site; a value is an http(s) URL a slug is appended
 * to, so nothing may follow its path; any other shape refuses the boot.
 */

const schema = buildEnvSchema({ version: '0.0.0-test' });
const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

const issuesOf = (value: unknown) => {
  const result = schema.safeParse({ ...BASE, DOCS_SITE_URL: value });
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('DOCS_SITE_URL', () => {
  it('defaults to the public docs site, blank or absent', () => {
    expect(PUBLIC_DOCS_SITE_URL).toBe('https://docs.antasphere.com');
    expect(schema.parse(BASE).DOCS_SITE_URL).toBe('https://docs.antasphere.com');
    expect(schema.parse({ ...BASE, DOCS_SITE_URL: '' }).DOCS_SITE_URL).toBe('https://docs.antasphere.com');
    expect(schema.parse({ ...BASE, DOCS_SITE_URL: '   ' }).DOCS_SITE_URL).toBe('https://docs.antasphere.com');
  });

  it('keeps a set value as written, https or http (the laptop stack), with or without a path', () => {
    expect(schema.parse({ ...BASE, DOCS_SITE_URL: 'https://handbook.antasphere.com' }).DOCS_SITE_URL).toBe(
      'https://handbook.antasphere.com'
    );
    expect(
      schema.parse({ ...BASE, DOCS_SITE_URL: 'http://handbook.team.localhost:3750' }).DOCS_SITE_URL
    ).toBe('http://handbook.team.localhost:3750');
    expect(schema.parse({ ...BASE, DOCS_SITE_URL: 'https://docs.example.test/tools' }).DOCS_SITE_URL).toBe(
      'https://docs.example.test/tools'
    );
  });

  it('refuses the boot on a trailing slash, a query or a fragment: a slug is appended to it', () => {
    expect(issuesOf('https://handbook.antasphere.com/')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://docs.example.test/tools/')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://handbook.antasphere.com?x=1')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://handbook.antasphere.com#top')).toContain('DOCS_SITE_URL');
  });

  it('refuses the boot on a trailing backslash (the parser reads it as a slash) and on a credential in the authority', () => {
    expect(issuesOf('https://handbook.antasphere.com\\')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://handbook.antasphere.com\\docs')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://user:secret@handbook.antasphere.com')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://user@handbook.antasphere.com')).toContain('DOCS_SITE_URL');
    expect(issuesOf('https://handbook.antasphere.com?')).toContain('DOCS_SITE_URL');
  });

  it('refuses the boot on anything that is not an http(s) URL', () => {
    for (const bad of [
      'handbook.antasphere.com',
      'ftp://handbook.antasphere.com',
      'javascript:alert(1)',
      'data:text/html,x',
      '/docs'
    ]) {
      expect(issuesOf(bad), bad).toContain('DOCS_SITE_URL');
    }
  });

  it('names the rule in its message', () => {
    const result = siteUrl().safeParse('https://handbook.antasphere.com/');
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe(
        'an http(s) URL with no trailing slash, query, fragment or credential'
      );
  });
});
