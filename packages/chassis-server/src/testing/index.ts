/**
 * The test harness of a chassis-based tool: the container and database
 * helpers, the recording mail driver, the fake hub and the SSO dances — ONE
 * copy, parametrized by the boot function, shared by the chassis suite
 * (`packages/chassis-server/test`) and by the tool's own tests. Never imported
 * by production code.
 */
export * from './helpers.js';
export * from './fake-hub.js';
export * from './sso-helpers.js';
export * from './setup-origins.js';
