import { describe, expect, it } from 'vitest';
import { hubUrlOf } from '../../src/env.js';

/**
 * The hub a cloud site names in its discovery (`auth.hub`): the issuer in the
 * form a CLI compares with the `baseUrl` of the logins it holds, so two
 * spellings of one hub name it once.
 */

describe('hubUrlOf', () => {
  it('keeps an issuer already in form as it is', () => {
    expect(hubUrlOf('http://hub.localhost:3300')).toBe('http://hub.localhost:3300');
    expect(hubUrlOf('https://hub.example.com')).toBe('https://hub.example.com');
  });

  it('strips a trailing slash', () => {
    expect(hubUrlOf('https://hub.example.com/')).toBe('https://hub.example.com');
  });

  it('strips several trailing slashes', () => {
    expect(hubUrlOf('https://hub.example.com///')).toBe('https://hub.example.com');
    expect(hubUrlOf('https://hub.example.com/base///')).toBe('https://hub.example.com/base');
  });

  it('keeps a path prefix, without its trailing slash', () => {
    expect(hubUrlOf('https://hub.example.com/base/')).toBe('https://hub.example.com/base');
    expect(hubUrlOf('https://hub.example.com/base')).toBe('https://hub.example.com/base');
  });

  it('drops the query and the fragment', () => {
    expect(hubUrlOf('https://hub.example.com/?x=1#top')).toBe('https://hub.example.com');
    expect(hubUrlOf('https://hub.example.com/base?x=1#top')).toBe('https://hub.example.com/base');
  });

  it('folds an upper-case host', () => {
    expect(hubUrlOf('https://HUB.Example.COM')).toBe('https://hub.example.com');
    expect(hubUrlOf('https://HUB.Example.COM/base/')).toBe('https://hub.example.com/base');
  });

  it('keeps the port: two ports are two hubs', () => {
    expect(hubUrlOf('http://hub.example.com:3300/')).toBe('http://hub.example.com:3300');
    expect(hubUrlOf('http://hub.example.com:3301')).not.toBe(hubUrlOf('http://hub.example.com:3300'));
  });
});
