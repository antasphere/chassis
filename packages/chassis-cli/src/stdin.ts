import { CliUsageError, type CliIo } from './context.js';

/**
 * Secrets that arrive on stdin instead of the command line.
 *
 * A value passed as `--api-key slk_…` or `--password hunter2` is visible to
 * every process on the box (`ps`, `/proc/<pid>/cmdline`) and lands verbatim
 * in the shell history file. The flags stay — they are what scripts already
 * use — but each one now has a `-stdin` sibling and, for the share
 * password, an environment variable, so nothing forces a secret through
 * argv.
 *
 * stdin can only be spent once, so it is claimed: the second claimant in one
 * invocation gets a usage error instead of silently receiving the first
 * one's value.
 */

const claims = new WeakMap<CliIo, string>();

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** First line of stdin, claimed for exactly one purpose per invocation. */
export async function readSecretFromStdin(io: CliIo, claimant: string): Promise<string> {
  const holder = claims.get(io);
  if (holder !== undefined) {
    throw new CliUsageError(
      `Only one secret can be read from stdin per command — ${holder} already claimed it.`
    );
  }
  claims.set(io, claimant);
  const raw = await (io.readStdin ?? readAllStdin)();
  const value = raw.split('\n')[0]?.trim() ?? '';
  if (!value) throw new CliUsageError(`Nothing on stdin to read the ${claimant} from.`);
  return value;
}
