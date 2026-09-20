import type { defineChassisRoutes } from '@antasphere/chassis-contract/routes';

/**
 * The generic routes that carry something of the TOOL: its scope vocabulary
 * (`/me`, the API-key family, the two CLI key mints) or its own words in the
 * OpenAPI text (the export route, the file delete route). The tool
 * instantiates them once (`defineChassisRoutes(contract, identity, copy)`) and
 * hands the SAME objects to the routers below, so the OpenAPI document is
 * built from one definition.
 * The chassis reads a scope as a plain string.
 */
export type ScopeRoutes = ReturnType<typeof defineChassisRoutes<string>>;
