import type { Logger } from '../logger.js';

/**
 * Internal event bus: domain modules publish, platform modules (and later
 * rail/ee modules registered at boot) subscribe. Deliberately synchronous
 * fan-out with error isolation — a failing subscriber never breaks the
 * publisher's request path.
 */
export type PlatformEvents = {
  /**
   * Fired by the identity layer (Better Auth databaseHooks.user.create.after,
   * wired in boot) for EVERY account entrance — setup, invitation accept,
   * collaborator claim, future SSO JIT. Trustworthy by construction; call
   * sites never emit it.
   */
  'user.created': { userId: string; email: string };
  'member.joined': { workspaceId: string; userId: string; role: string };
  'member.updated': { workspaceId: string; userId: string };
  'member.removed': { workspaceId: string; userId: string };
  'apikey.created': { workspaceId: string; apiKeyId: string };
  'apikey.revoked': { workspaceId: string; apiKeyId: string };
  'invitation.created': { workspaceId: string; invitationId: string };
  'invitation.accepted': { workspaceId: string; invitationId: string; userId: string };
  'file.uploaded': { workspaceId: string; fileId: string; sizeBytes: number };
  /** workspaceId is null on the cloud edition — setup creates no workspace there. */
  /** A person created ANOTHER workspace from inside the product (POST /workspaces). */
  'workspace.created': { workspaceId: string; ownerUserId: string };
  'setup.completed': { workspaceId: string | null; instanceId: string };
};

/**
 * The events a bus carries: the chassis ones plus the tool's own (`TExtra`, a
 * map of event name to payload, declared by the tool that instantiates the bus).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type EventMap<TExtra = {}> = PlatformEvents & TExtra;

type Handler<M, E extends keyof M> = (payload: M[E]) => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class EventBus<TExtra = {}> {
  private handlers = new Map<keyof EventMap<TExtra>, Set<Handler<EventMap<TExtra>, never>>>();

  constructor(private readonly logger: Logger) {}

  on<E extends keyof EventMap<TExtra>>(event: E, handler: Handler<EventMap<TExtra>, E>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<EventMap<TExtra>, never>);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler<EventMap<TExtra>, never>);
  }

  emit<E extends keyof EventMap<TExtra>>(event: E, payload: EventMap<TExtra>[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      Promise.resolve((handler as Handler<EventMap<TExtra>, E>)(payload)).catch((err) => {
        this.logger.error({ err, event }, 'event handler failed');
      });
    }
  }
}
