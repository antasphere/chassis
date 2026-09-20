import type { ToolIdentity } from '@antasphere/chassis-contract';

/**
 * What a tool is called, in every place the generic CLI spells it. ONE object,
 * passed by the tool to `defineCli` (index.ts): the chassis holds no product
 * literal of its own, so each field below is read where the literal used to
 * sit and the bytes a person or a script sees are the tool's own.
 */
export interface CliIdentity {
  /** The binary's name: `program.name()`, and every `\`<bin> …\`` hint. */
  bin: string;
  /** The tool's namespace in the shared config home, and its cli-core connect name. */
  tool: string;
  /** The pre-cli-core config directory (`$XDG_CONFIG_HOME/<dir>/config.json`), imported once. */
  legacyConfigDir: string;
  /** The product's name in a sentence. */
  displayName: string;
  /** The environment variables' prefix: `<PREFIX>_URL`, `<PREFIX>_API_KEY`, `<PREFIX>_WORKSPACE`. */
  envPrefix: string;
  /** The API key prefix, without the underscore: `<prefix>_…`. */
  keyPrefix: string;
  /** The scope a key needs for the full-workspace export, as `export --help` names it. */
  exportScope: string;
}

/**
 * The CLI's identity, BUILT from the tool's one definition (`ToolIdentity`,
 * written in the tool's contract package): a tool passes
 * `cliIdentity(IDENTITY)` to `defineCli` and spells nothing a second time.
 */
export function cliIdentity(identity: ToolIdentity): CliIdentity {
  return {
    bin: identity.cli.bin,
    tool: identity.slug,
    legacyConfigDir: identity.cli.legacyConfigDir,
    displayName: identity.displayName,
    envPrefix: identity.cli.envPrefix,
    keyPrefix: identity.apiKeyPrefix,
    exportScope: identity.scopes.dataExport
  };
}
