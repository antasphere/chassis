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
}
