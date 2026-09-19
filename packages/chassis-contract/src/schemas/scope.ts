import { z } from 'zod';

/**
 * The scope vocabulary is the TOOL's identity (`products:read`, …), so the
 * chassis never spells one: a tool hands its scopes to
 * `defineChassisContract({ scopes })` (../define.ts) and gets back the enum
 * and every schema that carries it.
 */
export type ScopeTuple = readonly [string, ...string[]];

/** The zod enum over a tool's scopes — exactly what `z.enum([...scopes])` builds. */
export type ScopeSchema<TScope extends string> = z.ZodEnum<{ [K in TScope]: K }>;

export function defineScopeSchema<const TScopes extends ScopeTuple>(
  scopes: TScopes
): ScopeSchema<TScopes[number]> {
  return z.enum(scopes) as unknown as ScopeSchema<TScopes[number]>;
}
