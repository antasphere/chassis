import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Command } from 'commander';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  PlatformApiError,
  type ChassisClient,
  type ListParams
} from '@antasphere/chassis-sdk';
import { CliUsageError, fmtBytes, printJson, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';
import { writeContained } from '../safe-write.js';

/**
 * The platform substrate commands inherited from the template: instance
 * discovery, the raw workspace-files surface, and the full export download.
 */

/**
 * Turn a server-chosen `originalName` into a plain filename, or refuse.
 *
 * The stored name is whatever the uploader (possibly a collaborator, on a
 * shared instance) typed: `../../.bashrc`, `/etc/cron.d/x`, `.npmrc`, and
 * on Windows `..\\..\\x` are all valid under the wire schema. Both POSIX
 * and Windows separators are stripped, then anything that is not an inert
 * plain filename is refused rather than silently rewritten — the caller
 * always has `--out <path>` to name the destination themselves.
 */
export function safeDownloadName(originalName: string): string {
  const name = basename(win32.basename(originalName));
  if (name === '' || name === '.' || name === '..' || name.startsWith('.')) {
    throw new CliUsageError(
      `Refusing to derive a filename from the stored name ${JSON.stringify(originalName)} — ` +
        'pass --out <path> to choose where it goes.'
    );
  }
  return name;
}

export function registerFileCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { requireApiKey, resolveContext } = kit;

  program
    .command('instance')
    .description('Show instance discovery (public: name, version, auth methods)')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const info = await ctx.client.instance();
      if (ctx.json) return printJson(io, info);
      io.out.write(
        `${info.name}  v${info.version} (${info.edition})\n` +
          `  setup required: ${info.setupRequired}\n` +
          `  auth methods:   ${info.auth.methods.join(', ')}\n`
      );
    });

  program
    .command('export')
    .description(`Download the full workspace export as a zip (key needs ${kit.identity.exportScope})`)
    .option('-o, --out <path>', 'write to this path (defaults to export-<date>.zip)')
    .action(async (opts: { out?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const res = await ctx.client.downloadExport();
      if (!res.body) {
        throw new Error('The export response carried no body');
      }
      const out = opts.out ?? `export-${new Date().toISOString().slice(0, 10)}.zip`;
      // Stream to disk — exports can be large, never buffer (unlike files
      // download, whose objects are capped by MAX_FILE_SIZE_MB).
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(out));
      if (ctx.json) return printJson(io, { path: out });
      io.out.write(`Export written to ${out}\n`);
    });

  const files = program.command('files').description('Manage workspace files');

  files
    .command('list')
    .description('List files in the workspace (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.files(params);
      const rows = [...first.files];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.files({ ...params, cursor });
          rows.push(...page.files);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      // The wire shape, so scripts can thread nextCursor (--all drains it to null).
      if (ctx.json) return printJson(io, { files: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No files.\n');
        return;
      }
      for (const f of rows) {
        io.out.write(`${f.id}  ${fmtBytes(f.sizeBytes).padStart(9)}  ${f.originalName}\n`);
      }
      if (nextCursor) {
        io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
      }
    });

  files
    .command('upload <path>')
    .description('Upload a local file')
    .option('--name <name>', 'stored file name (defaults to the local basename)')
    .option('--content-type <type>', 'content type', 'application/octet-stream')
    .action(async (path: string, opts: { name?: string; contentType: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const bytes = await readFile(path);
      const name = opts.name ?? basename(path);
      const result = await ctx.client.uploadFile(name, new Uint8Array(bytes), opts.contentType);
      if (ctx.json) return printJson(io, result);
      io.out.write(
        `Uploaded ${result.file.originalName} (${fmtBytes(result.file.sizeBytes)})` +
          `${result.deduplicated ? ' [deduplicated]' : ''}\n  id: ${result.file.id}\n`
      );
    });

  files
    .command('download <id>')
    .description('Download a file by id')
    .option('--out <path>', 'write to this exact path (your path, used verbatim)')
    .option('--dir <path>', 'directory to write the stored name into (default: .)')
    .action(async (id: string, opts: { out?: string; dir?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const apiKey = await requireApiKey(ctx);
      if (opts.out && opts.dir) {
        throw new CliUsageError('Pass either --out <path> or --dir <path>, not both.');
      }
      const meta = await ctx.client.file(id);
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const res = await fetchImpl(ctx.client.fileContentUrl(id), {
        // This one bypasses the SDK, so it carries the SDK's headers itself:
        // the key, and the selected workspace (a download follows it too).
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(ctx.workspaceId !== undefined ? { 'x-workspace-id': ctx.workspaceId } : {})
        },
        // …and the SDK's deadline.
        signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS)
      });
      if (!res.ok) {
        throw new PlatformApiError(res.status, 'download_failed', `Download failed with ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      let out: string;
      if (opts.out) {
        // The caller typed this path — honour it verbatim.
        out = opts.out;
        await writeFile(out, buf);
      } else {
        // `originalName` is SERVER-controlled and unconstrained beyond
        // 1-255 chars: it may be `../../.ssh/authorized_keys` or an
        // absolute path. Never join it — take its basename, refuse the
        // names that are not a plain filename, and write it contained
        // inside the chosen directory (symlinks refused, mode forced).
        const dir = resolve(opts.dir ?? '.');
        const name = safeDownloadName(meta.originalName);
        await mkdir(dir, { recursive: true });
        out = await writeContained(dir, name, buf);
      }
      io.out.write(`Downloaded ${meta.originalName} → ${out} (${fmtBytes(buf.length)})\n`);
    });

  files
    .command('rm <id>')
    .description('Delete a file by id')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      await ctx.client.deleteFile(id);
      if (ctx.json) return printJson(io, { deleted: id });
      io.out.write(`Deleted ${id}\n`);
    });
}
