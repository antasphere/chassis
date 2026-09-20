import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeDownloadName, sanitizeForTty } from '@antasphere/chassis-cli';
import { routedHarness, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';

/**
 * PRDCT-1353 — the CLI hardening, the generic half: `files download` cannot
 * be steered by the stored name, terminal control sequences never reach the
 * terminal (and `--json` stays byte-exact), and the API key can stay out of
 * argv. The deck half (pull, the ignore matcher, the scan, annotations, the
 * CSV guard, the share password) is the tool's own security.test.ts.
 */

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// The literal that spells the tool comes from the host (its identity).
const K = cli.identity.keyPrefix;

const KEY = ['--url', 'http://x', '--api-key', `${K}_k_s`];

async function emptyDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ── CLI-3: `files download` cannot be steered by the stored name ─────────────

describe('files download', () => {
  const FILE_ID = '44444444-4444-4444-4444-444444444444';

  function fileRoutes(originalName: string): Route[] {
    return [
      {
        method: 'GET',
        path: new RegExp(`/api/v1/files/${FILE_ID}$`),
        reply: () => ({
          body: {
            id: FILE_ID,
            sha256: sha('payload'),
            sizeBytes: 7,
            contentType: 'text/plain',
            originalName,
            createdBy: 'u1',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        })
      },
      {
        method: 'GET',
        path: new RegExp(`/api/v1/files/${FILE_ID}/content$`),
        reply: () => ({ raw: new Response(Buffer.from('payload'), { status: 200 }) })
      }
    ];
  }

  it('writes the BASENAME of a traversing stored name inside --dir', async () => {
    const root = await emptyDir('cli-sec-');
    const dir = join(root, 'downloads');
    const h = routedHarness(fileRoutes('../../pwned.txt'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'pwned.txt'), 'utf8')).toBe('payload');
    await expect(stat(join(root, 'pwned.txt'))).rejects.toThrow();
  });

  it('refuses an absolute stored name rather than writing to it', async () => {
    const dir = await emptyDir('cli-sec-');
    const h = routedHarness(fileRoutes('/etc/cron.d/backdoor'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    // The basename survives; it lands inside the chosen directory.
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'backdoor'), 'utf8')).toBe('payload');
  });

  it('refuses a dotfile stored name and points at --out', async () => {
    const dir = await emptyDir('cli-sec-');
    const h = routedHarness(fileRoutes('.bashrc'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/--out/);
    await expect(stat(join(dir, '.bashrc'))).rejects.toThrow();
  });

  it('refuses to write through a symlink planted at the derived name', async () => {
    const root = await emptyDir('cli-sec-');
    const dir = join(root, 'downloads');
    await mkdir(dir, { recursive: true });
    const victim = join(root, 'victim.txt');
    await writeFile(victim, 'original');
    await symlink(victim, join(dir, 'report.txt'));
    const h = routedHarness(fileRoutes('report.txt'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(code).toBe(1);
    expect(await readFile(victim, 'utf8')).toBe('original');
  });

  it('safeDownloadName strips both separator flavours', () => {
    expect(safeDownloadName('a/b/c.txt')).toBe('c.txt');
    expect(safeDownloadName('..\\..\\windows.txt')).toBe('windows.txt');
    expect(safeDownloadName('plain.txt')).toBe('plain.txt');
    expect(() => safeDownloadName('..')).toThrow(/--out/);
    expect(() => safeDownloadName('.npmrc')).toThrow(/--out/);
  });
});

// ── CLI-5: terminal control sequences never reach the terminal ───────────────

describe('terminal-control sanitation', () => {
  it('strips CSI, OSC and C1 while keeping tabs, newlines and CR', () => {
    const ESC = '\u001b';
    expect(sanitizeForTty(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeForTty(`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`)).toBe('click');
    expect(sanitizeForTty(`${ESC}]52;c;cGF5bG9hZA==\u0007`)).toBe('');
    // 8-bit C1: 0x9b IS a CSI introducer on its own.
    expect(sanitizeForTty('a\u009b31mBb')).toBe('a31mBb');
    expect(sanitizeForTty('a\tb\r\nc\n')).toBe('a\tb\r\nc\n');
    expect(sanitizeForTty('plain')).toBe('plain');
  });

  // PRDCT-2530: the one invariant of this block that was only proven through a
  // deck command (annotation bodies). `files list` is the generic command that
  // prints somebody else's text: the stored name.
  it('sanitizes a control-character stored name on human output and never on --json', async () => {
    const ESC = '\u001b';
    // ESC sequences AND a raw 8-bit C1 introducer: JSON.stringify escapes the
    // former and keeps the latter as is, so the C1 byte is what a sanitizer
    // wrongly applied to the JSON text would eat.
    const originalName = `${ESC}[2K${ESC}[1Areport\u009b31m${ESC}]8;;https://evil.example${ESC}\\.txt`;
    const file = { id: 'f-a', sizeBytes: 10, originalName };
    const routes: Route[] = [
      {
        method: 'GET',
        path: /\/api\/v1\/files$/,
        reply: () => ({ body: { files: [file], nextCursor: null } })
      }
    ];

    const human = routedHarness(routes);
    expect(await run(['files', 'list', ...KEY], human.io)).toBe(0);
    expect(human.out()).toContain('report31m.txt\n');
    expect(human.out()).not.toContain(ESC);
    expect(human.out()).not.toContain('\u009b');
    expect(human.out()).not.toContain('evil.example');

    const json = routedHarness(routes);
    expect(await run(['files', 'list', '--json', ...KEY], json.io)).toBe(0);
    expect(json.out()).toContain('\u009b');
    expect(JSON.parse(json.out())).toEqual({ files: [file], nextCursor: null });
  });

  // The STDERR half of the same invariant (PRDCT-2530, verifier F-1): the
  // runner prints `Error: <the server's message>`, and that message is
  // somebody else's text as much as a stored name is. A 500 carries no hint,
  // so the whole line is asserted.
  it('sanitizes a control-character server error message on stderr, with and without --json', async () => {
    const ESC = '\u001b';
    const BEL = '\u0007';
    // An OSC-8 hyperlink around "click", then a CSI line-erase.
    const message = `deck ${ESC}]8;;http://evil.example${BEL}click${ESC}]8;;${BEL} ${ESC}[2K gone`;
    const routes: Route[] = [
      {
        method: 'GET',
        path: /\/api\/v1\/files$/,
        reply: () => ({ status: 500, body: { error: { code: 'internal', message } } })
      }
    ];

    const human = routedHarness(routes);
    expect(await run(['files', 'list', ...KEY], human.io)).toBe(1);
    expect(human.out()).toBe('');
    expect(human.err()).toBe('Error: deck click  gone\n');

    // `--json` shapes what a command PRINTS; a failure is reported the same way
    // under it: nothing on stdout, and the same inert human line on stderr.
    const json = routedHarness(routes);
    expect(await run(['files', 'list', '--json', ...KEY], json.io)).toBe(1);
    expect(json.out()).toBe('');
    expect(json.err()).toBe('Error: deck click  gone\n');
  });
});

// ── CLI-12: secrets no longer have to travel in argv ─────────────────────────

describe('secrets off the command line', () => {
  it('--api-key-stdin authenticates without the key ever entering argv', async () => {
    const h = routedHarness([
      { method: 'GET', path: /\/api\/v1\/files$/, reply: () => ({ body: { files: [], nextCursor: null } }) }
    ]);
    h.io.readStdin = async () => `${K}_from_stdin\n`;
    const code = await run(['files', 'list', '--url', 'http://x', '--api-key-stdin'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.wire[0]!.auth).toBe(`Bearer ${K}_from_stdin`);
  });
});
