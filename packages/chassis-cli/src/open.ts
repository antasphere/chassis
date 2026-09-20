import { spawn } from 'node:child_process';
import type { CliIo } from './context.js';

/**
 * Opening a URL in the person's default browser (PRDCT-2280): the first push
 * of a folder opens the pushed resource's page, the tool's `open` command opens
 * it on demand, its `dev` command opens the local preview.
 *
 * The URL is always ONE argv item handed to the platform's opener binary,
 * never a string a shell interprets: a resource title or an instance URL is
 * somebody else's text, and `sh -c "open $url"` would run whatever it
 * carries. On Windows `start` is a cmd.exe builtin that `spawn` cannot run
 * without a shell, so the URL handler is invoked through `rundll32`
 * instead, which is a real executable taking the URL as an argument.
 */
export function platformOpener(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  return { command: 'xdg-open', args: [] };
}

/**
 * Best effort: a missing opener (a headless box) must never fail the
 * command that already did its real work. The runner can inject `io.openUrl`
 * (tests record the call; nothing is spawned).
 */
export function openInBrowser(io: CliIo, url: string, spawnImpl: typeof spawn = spawn): void {
  if (io.openUrl) {
    io.openUrl(url);
    return;
  }
  const { command, args } = platformOpener();
  try {
    const child = spawnImpl(command, [...args, url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // best-effort
  }
}

/** A stdout that is a terminal: the only place a browser may pop up unasked. */
export function isInteractive(io: CliIo): boolean {
  return io.out.isTTY === true;
}
