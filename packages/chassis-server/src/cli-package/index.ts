import { readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/**
 * The tool's own CLI package, as the release packed it (PRDCT-3312): the
 * folder `CLI_PACKAGE_DIR` names holds `package.tgz` (the output of
 * `pnpm pack` of the tool's `packages/cli`) beside a copy of that package's
 * `package.json`. The instance reads the pair ONCE at boot and serves the
 * tarball on `POST /cli/package` (api/cli-package.ts, cloud only) to a member
 * the hub let into the tool; discovery advertises `cli { name, version }` so
 * the `team` command knows what it installs and whether to update.
 *
 * A folder that is named but does not hold the pair, or whose `package.json`
 * carries no string `name` and `version`, refuses the boot (env.ts): a
 * misconfiguration is proven at the image, never discovered by a person's
 * install. Pure: nothing runs at import; the reads are synchronous and happen
 * when the boot asks.
 */
export interface CliPackage {
  /** The package's npm name, from its `package.json` (e.g. `@scope/tool`). */
  name: string;
  /** The package's version, from its `package.json`. */
  version: string;
  /** The tarball's path (the configured folder joined with `package.tgz`), what the route streams. */
  path: string;
  /** The tarball's size when the boot read it (the route stats the file again when it serves). */
  sizeBytes: number;
  /** npm's own pack name for the pair, the attachment's filename. */
  filename: string;
}

/** The tarball's name inside the folder, whatever the package is called. */
export const CLI_PACKAGE_TARBALL = 'package.tgz';
/** The manifest copy beside it. */
export const CLI_PACKAGE_MANIFEST = 'package.json';

/**
 * npm's own pack filename: the scope's `@` dropped and its `/` turned into
 * `-` (`@scope/tool` + `1.2.3` → `scope-tool-1.2.3.tgz`); an unscoped name is
 * kept as it is (`tool` → `tool-1.2.3.tgz`).
 */
export function packFilename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(1).replace('/', '-') : name;
  return `${base}-${version}.tgz`;
}

/**
 * Read the folder `CLI_PACKAGE_DIR` names. `undefined` (the variable unset)
 * answers null: the instance serves no CLI. A named folder answers the
 * package, or THROWS an Error naming the folder and the missing piece.
 */
export function loadCliPackage(dir: string | undefined): CliPackage | null {
  if (dir === undefined) return null;
  const refuse = (what: string): never => {
    throw new Error(`CLI_PACKAGE_DIR=${dir}: ${what}`);
  };

  const tarball = join(dir, CLI_PACKAGE_TARBALL);
  let stat: Stats;
  try {
    stat = statSync(tarball);
  } catch {
    return refuse(`no ${CLI_PACKAGE_TARBALL} in the folder (the output of \`pnpm pack\` of the CLI package)`);
  }
  if (!stat.isFile()) return refuse(`${CLI_PACKAGE_TARBALL} is not a file`);

  let raw: string;
  try {
    raw = readFileSync(join(dir, CLI_PACKAGE_MANIFEST), 'utf8');
  } catch {
    return refuse(`no ${CLI_PACKAGE_MANIFEST} in the folder (a copy of the CLI package's manifest)`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return refuse(`${CLI_PACKAGE_MANIFEST} is not valid JSON`);
  }
  const { name, version } = (manifest ?? {}) as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || name.length === 0) {
    return refuse(`${CLI_PACKAGE_MANIFEST} carries no string "name"`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    return refuse(`${CLI_PACKAGE_MANIFEST} carries no string "version"`);
  }

  return { name, version, path: tarball, sizeBytes: stat.size, filename: packFilename(name, version) };
}
