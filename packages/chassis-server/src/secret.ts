import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger.js';

/**
 * Resolve the auth secret: prefer AUTH_SECRET from the environment; otherwise
 * persist a generated one under DATA_DIR (n8n-style zero-config first run).
 * The file is written 0600 and reused on every subsequent boot, so sessions
 * survive restarts even when the operator never set a secret.
 */
export async function resolveAuthSecret(
  envSecret: string | undefined,
  dataDir: string,
  log: Logger
): Promise<string> {
  if (envSecret) return envSecret;

  const secretPath = join(dataDir, 'secret');
  try {
    const existing = (await readFile(secretPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
    log.warn({ secretPath }, 'existing secret file is too short — regenerating');
  } catch {
    // no secret file yet
  }

  const secret = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  // Write + rename (same dir → atomic) so a crash mid-write never leaves a
  // truncated secret that a later boot would accept and lock everyone out.
  const tmpPath = join(dataDir, `.secret.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, secret + '\n', { mode: 0o600 });
    await rename(tmpPath, secretPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  log.warn(
    { secretPath },
    'AUTH_SECRET was not set — generated one into the data volume. ' +
      'Set AUTH_SECRET explicitly for multi-replica deployments; all replicas must share it.'
  );
  return secret;
}

/** Where a boot-generated setup token lives until the instance is claimed. */
export function generatedSetupTokenPath(dataDir: string): string {
  return join(dataDir, 'setup-token');
}

/**
 * The credential POST /api/v1/setup REQUIRES (PRDCT-1347, audit A7). The
 * first-boot claim decides who owns the instance, so it can never be free:
 *
 *  - `SETUP_TOKEN` set → that is the token (setup.sh writes one);
 *  - instance already set up → nothing to claim, no token needed (null);
 *  - otherwise → a token is generated ONCE into `$DATA_DIR/setup-token`
 *    (0600, atomic write, reused on every later boot until the claim) and
 *    printed to the container log, so the `docker run` / plain
 *    `docker compose up` paths — which never go through setup.sh — still
 *    produce an instance claimable only with a secret. The file is removed
 *    once setup completes (see clearGeneratedSetupToken).
 *
 * Optional-when-set was the hole: a minimal-env container answered the
 * claim with 201 and no credential at all.
 */
export async function resolveSetupToken(
  envToken: string | undefined,
  dataDir: string,
  alreadySetUp: boolean,
  log: Logger
): Promise<string | null> {
  if (envToken) return envToken;
  if (alreadySetUp) return null;

  const tokenPath = generatedSetupTokenPath(dataDir);
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length >= 16) {
      log.warn(
        { tokenPath },
        `SETUP_TOKEN is not set — the setup wizard requires the token generated at first boot: ${existing}`
      );
      return existing;
    }
    log.warn({ tokenPath }, 'existing setup-token file is too short — regenerating');
  } catch {
    // no token file yet
  }

  const token = randomBytes(16).toString('hex');
  await mkdir(dataDir, { recursive: true });
  const tmpPath = join(dataDir, `.setup-token.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, token + '\n', { mode: 0o600 });
    await rename(tmpPath, tokenPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  log.warn(
    { tokenPath },
    'SETUP_TOKEN was not set — generated one for the first-boot setup wizard. ' +
      `Use this token to claim the instance: ${token}  ` +
      '(also readable inside the container at that path; set SETUP_TOKEN explicitly to choose your own)'
  );
  return token;
}

/** Best-effort removal of the generated token once the claim has succeeded. */
export async function clearGeneratedSetupToken(dataDir: string): Promise<void> {
  await rm(generatedSetupTokenPath(dataDir), { force: true });
}
