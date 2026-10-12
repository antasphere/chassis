import type { ToolIdentity } from '@antasphere/chassis-contract';

/**
 * The Antasphere hub every tool signs in through, when nothing names another
 * (`ANTASPHERE_URL`, a hub profile's own `baseUrl`): the instance of the
 * implicit `cloud` hub profile, and the cloud URL the hub profile is selected
 * with (cli-core `selectHubProfile`, `hubCloudUrl`), so that a hub profile
 * with no `baseUrl` of its own is at this hub, as the account CLI reads it.
 */
export const DEFAULT_HUB_URL = 'https://account.antasphere.com';

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
  /**
   * The tool's cloud home (`identity.cloud.url`): the last step of the URL
   * resolution and the instance of the implicit `cloud` profile, so a clean
   * machine with an `antasphere login` needs no flag (PRDCT-2947).
   */
  cloudUrl: string;
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
    exportScope: identity.scopes.dataExport,
    cloudUrl: identity.cloud.url
  };
}
