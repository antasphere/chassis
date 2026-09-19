import type { EntitlementService, IdentityProvider, UsageSink } from '@antasphere/chassis-contract';
import type { EventBus } from './events.js';
import type { WorkspaceService } from './workspaces.js';

/**
 * Boot-time module registry: the single place where seam implementations are
 * bound. The template binds local defaults; a rail-connected or ee edition
 * re-binds its own implementations here at boot (Cal.com/n8n pattern) and
 * nothing else in the codebase changes.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PlatformRegistry<TExtra = {}> {
  identity: IdentityProvider;
  entitlements: EntitlementService;
  usage: UsageSink;
  events: EventBus<TExtra>;
  /**
   * Workspace lifecycle (ADR 014). Setup creates the FIRST workspace through
   * it; product flows that open workspace creation (the cloud edition's lazy
   * org projection) call it here instead of inserting rows themselves.
   */
  workspaces: WorkspaceService;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function createRegistry<TExtra = {}>(defaults: PlatformRegistry<TExtra>): PlatformRegistry<TExtra> {
  return { ...defaults };
}
