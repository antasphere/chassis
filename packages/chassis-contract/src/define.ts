import type { z } from 'zod';
import { defineApiKeySchemas } from './schemas/api-keys.js';
import { defineCliAuthSchemas } from './schemas/cli-auth.js';
import { defineMeSchemas } from './schemas/me.js';
import { defineScopeSchema, type ScopeSchema, type ScopeTuple } from './schemas/scope.js';

/**
 * The scope-dependent half of the chassis contract. Everything else in this
 * package is a plain static export; these schemas transitively hold the
 * tool's scope enum, so they are BUILT, once per tool, from the scopes the
 * tool names — no module-level state, the returned object is the contract.
 *
 *   const { read, write, dataExport } = IDENTITY.scopes; // the tool's `ToolIdentity` value
 *   const contract = defineChassisContract({ scopes: [read, write, dataExport] });
 *   export const { scopeSchema, apiKeySchema, meResponseSchema } = contract;
 *   export type Scope = ScopeOf<typeof contract>;
 *
 * The scopes are a TUPLE, in the order the enum publishes them: a tool with
 * more scopes than the three parts of its identity appends them here.
 *
 * The route contracts over these schemas come from
 * `defineChassisRoutes(contract, IDENTITY)` on the `./routes` entry (it pulls
 * Hono; this one stays client-safe).
 */
export function defineChassisContract<const TScopes extends ScopeTuple>(tool: {
  scopes: TScopes;
}): ChassisContract<TScopes[number]> {
  return buildChassisContract(defineScopeSchema(tool.scopes));
}

function buildChassisContract<TScope extends string>(scopeSchema: ScopeSchema<TScope>) {
  const apiKeys = defineApiKeySchemas(scopeSchema);
  return {
    scopeSchema,
    ...apiKeys,
    ...defineCliAuthSchemas(apiKeys.apiKeySchema),
    ...defineMeSchemas(scopeSchema)
  };
}

/** The contract a tool gets for its scopes (`TScope` = the union of the scope literals). */
export type ChassisContract<TScope extends string> = ReturnType<typeof buildChassisContract<TScope>>;

/** The loosest reading of a contract — what the `…Of` type helpers below accept. */
export type ChassisContractShape = { [K in keyof ChassisContract<string>]: z.ZodType };

/**
 * The inferred types of an instantiated contract, under the names their
 * schemas have always had: `type Scope = ScopeOf<typeof contract>`.
 */
export type ScopeOf<C extends Pick<ChassisContractShape, 'scopeSchema'>> = z.infer<C['scopeSchema']>;
export type ApiKeyInfoOf<C extends Pick<ChassisContractShape, 'apiKeySchema'>> = z.infer<C['apiKeySchema']>;
export type ApiKeyCreateOf<C extends Pick<ChassisContractShape, 'apiKeyCreateSchema'>> = z.infer<
  C['apiKeyCreateSchema']
>;
export type ApiKeyCreatedOf<C extends Pick<ChassisContractShape, 'apiKeyCreatedSchema'>> = z.infer<
  C['apiKeyCreatedSchema']
>;
export type CliAuthCompletedOf<C extends Pick<ChassisContractShape, 'cliAuthCompletedSchema'>> = z.infer<
  C['cliAuthCompletedSchema']
>;
export type MeResponseOf<C extends Pick<ChassisContractShape, 'meResponseSchema'>> = z.infer<
  C['meResponseSchema']
>;
