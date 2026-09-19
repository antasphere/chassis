import type { defineChassisRoutes } from '@antasphere/chassis-contract/routes';

/**
 * The generic routes that carry the TOOL's scope vocabulary (`/me`, the
 * API-key family, the two CLI key mints). The tool instantiates them once
 * with its scopes (`defineChassisRoutes(contract)`) and hands the SAME objects
 * to the routers below, so the OpenAPI document is built from one definition.
 * The chassis reads a scope as a plain string.
 */
export type ScopeRoutes = ReturnType<typeof defineChassisRoutes<string>>;
