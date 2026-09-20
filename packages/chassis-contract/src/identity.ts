/**
 * A tool's IDENTITY: every value that names the tool where a person, an agent
 * or an operator can see it. The chassis packages spell none of them; a tool
 * writes ONE value of this type (in its own contract package, the one package
 * its server, SDK, CLI and dashboard all depend on) and hands it to the three
 * chassis entry points: `defineChassisContract` + `defineChassisRoutes` here,
 * the server's `ToolDefinition.identity`, and the CLI's `defineCli`.
 *
 * Pure data, client-safe. The tool's domain WORDING (a refusal that names its
 * resource) is not identity: it goes to the server's `copy` slot.
 */
export interface ToolIdentity<TScope extends string = string> {
  /** Machine name, lower case (`acme`): the CLI's config namespace and its hub connect name. */
  slug: string;
  /** Human name (`Acme`): mails, the no-dashboard page, CLI messages, the name of an instance not set up yet. */
  displayName: string;
  /** API key prefix, without the underscore (`acm` mints `acm_<keyId>_<secret>`). Never change it once keys exist. */
  apiKeyPrefix: string;
  /** The scope vocabulary, by the part each scope plays. `dataExport` is the opt-in full-workspace export. */
  scopes: { read: TScope; write: TScope; dataExport: TScope };
  /** How the OpenAPI document names the CLI key's grant (`things:read+write`). A literal: a contraction, not a join. */
  cliKeyScopesLabel: string;
  cli: {
    /** The binary's name (`acme`). Must equal the `bin` key of the CLI's package.json. */
    bin: string;
    /** Prefix of the CLI's environment variables (`ACME` reads `ACME_URL`, `ACME_API_KEY`, `ACME_WORKSPACE`). */
    envPrefix: string;
    /** A pre-hub config directory still read once for migration (`~/.config/<dir>/config.json`). */
    legacyConfigDir: string;
  };
  mcp: {
    /** `serverInfo.name` of the bundled MCP server. */
    serverName: string;
    /** Prefix of the tool's MCP tool names, underscore included (`acme_`). The tool registers `<prefix>whoami`. */
    toolPrefix: string;
  };
  /** OpenTelemetry `service.name`. */
  otelServiceName: string;
  /** The published container image. Read by nothing at run time: recorded so an instantiate script has one source. */
  imageName: string;
}
