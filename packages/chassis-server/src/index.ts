import type { z } from 'zod';
import { bootPlatform } from './boot.js';
import type { BootOverrides, BootResult, ToolDefinition } from './tool-definition.js';

export { type AppDeps, createApp, postgresErrorCode } from './app.js';
export type {
  ApiContext,
  ApiRateLimitContext,
  ApiRoutesContext,
  BodyLimitVerdict,
  BootOverrides,
  BootResult,
  FilePolicy,
  JobsContext,
  PlatformCore,
  ServiceCore,
  ToolApiSlots,
  ToolAppSlots,
  ToolBuckets,
  ToolCopy,
  ToolDefinition,
  ToolRateLimiters
} from './tool-definition.js';

/** A platform: one tool definition bound to the chassis' locked composition. */
export interface Platform<TEnvShape extends z.ZodRawShape, TDomain, TEvents, TToolOverrides> {
  /**
   * The boot sequence, in its locked order: env → logger → db probe → secret →
   * migrations under advisory lock → app assembly → ready.
   */
  boot: (
    source?: NodeJS.ProcessEnv,
    overrides?: BootOverrides<TToolOverrides>
  ) => Promise<BootResult<TEnvShape, TDomain, TEvents>>;
}

/**
 * THE composition entry. A tool fills the named slots of `ToolDefinition`;
 * the chassis owns every ordering (boot.ts, api/create-api.ts, app.ts).
 */
export function createPlatform<
  TEnvShape extends z.ZodRawShape,
  TDomain,
  TBuckets extends string = never,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TEvents = {},
  TToolOverrides = never
>(
  tool: ToolDefinition<TEnvShape, TDomain, TBuckets, TEvents, TToolOverrides>
): Platform<TEnvShape, TDomain, TEvents, TToolOverrides> {
  return { boot: (source, overrides) => bootPlatform(tool, source, overrides) };
}
