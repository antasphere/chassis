/* eslint-disable @typescript-eslint/consistent-type-imports -- the `typeof import(…)` casts moved verbatim with their tests (PRDCT-2530) */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openInBrowser, platformOpener } from '@antasphere/chassis-cli';

/**
 * The browser opener, the generic half of PRDCT-2280: the platform command,
 * the URL as its own argv item, the injected `io.openUrl`. What a tool opens
 * and when (the push decision, `open`, `dev`) is the tool's own open.test.ts.
 */

describe('the opener', () => {
  it('is the platform command, the URL its own argv item, never a shell string', () => {
    expect(platformOpener('darwin')).toEqual({ command: 'open', args: [] });
    expect(platformOpener('linux')).toEqual({ command: 'xdg-open', args: [] });
    expect(platformOpener('freebsd')).toEqual({ command: 'xdg-open', args: [] });
    // `start` is a cmd.exe builtin spawn cannot run; rundll32 is a real binary.
    expect(platformOpener('win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler'] });
  });

  it('spawns with the URL as the last argv item, detached, and never throws', () => {
    const spawned: Array<{ command: string; args: readonly string[]; opts: unknown }> = [];
    const fakeSpawn = ((command: string, args: readonly string[], opts: unknown) => {
      spawned.push({ command, args, opts });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const url = 'http://x/decks/abc/present?a=1&b=$(rm -rf /)';
    openInBrowser(
      { env: {}, out: { write: () => undefined }, err: { write: () => undefined } },
      url,
      fakeSpawn
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args[spawned[0]!.args.length - 1]).toBe(url);
    expect(spawned[0]!.opts).toMatchObject({ detached: true, stdio: 'ignore' });
    // `shell` is never set: the URL stays one argument.
    expect((spawned[0]!.opts as { shell?: unknown }).shell).toBeUndefined();
  });

  it('prefers the injected io.openUrl and spawns nothing', () => {
    const opened: string[] = [];
    const fakeSpawn = (() => {
      throw new Error('must not spawn');
    }) as unknown as typeof import('node:child_process').spawn;
    openInBrowser(
      {
        env: {},
        out: { write: () => undefined },
        err: { write: () => undefined },
        openUrl: (u) => opened.push(u)
      },
      'http://x/decks/abc/present',
      fakeSpawn
    );
    expect(opened).toEqual(['http://x/decks/abc/present']);
  });
});
