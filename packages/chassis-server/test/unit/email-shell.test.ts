import { describe, expect, it } from 'vitest';
import { makeShell } from '@antasphere/chassis-server/email';

const shell = makeShell({ name: 'Things', tagline: 'Things, kept.' });
const parts = { preheader: 'A preview', eyebrow: 'Notice', title: 'A title', body: '<p>Body</p>' };

describe('makeShell', () => {
  it('declares the language of the mail it wraps on <html lang>', () => {
    expect(shell({ ...parts, lang: 'fr' })).toContain('<html lang="fr">');
  });

  it('declares English when no language is given', () => {
    expect(shell(parts)).toContain('<html lang="en">');
  });
});
