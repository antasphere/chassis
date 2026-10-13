import { z } from 'zod';
import type { WebhookCatalog } from '@antasphere/chassis-contract';

/**
 * The event catalog (PRDCT-3482): what an instance can deliver to a webhook
 * endpoint. The TOOL declares its events through the `webhooks` slot of its
 * definition (its subjects, its event types, the zod schema of each event's
 * `data`); the chassis adds its own events, checks the whole at boot, matches
 * subscriptions against it and serves it on `GET /webhooks/events` with the
 * JSON Schema of every payload, so an agent discovers the types and the
 * shapes without reading a page of documentation.
 *
 * A SUBJECT is a filterable key the tool exposes (`thing`, `project`): an
 * endpoint narrows its subscription to a list of ids per subject, and the
 * envelope carries each subject's value under the FIELD the tool names for it
 * (`thingId`, `projectIds`). An event declares which subjects it carries.
 */

/** One filterable key of the tool, as the slot declares it. */
export interface WebhookSubjectDeclaration {
  /** The envelope field the subject's value is written under (`thingId`, `projectIds`). */
  field: string;
  description: string;
}

/** One event type of the tool, as the slot declares it. */
export interface WebhookEventDeclaration {
  /** `thing.created`: a lowercase family, a dot, a lowercase verb. */
  type: string;
  description: string;
  /** The subjects this event carries, by key; every one must be declared in `subjects`. */
  subjects: readonly string[];
  /** The schema of the event's `data`, validated at emit (a mismatch is a bug, logged and skipped). */
  data: z.ZodType;
}

/** The `webhooks` slot of a tool definition. */
export interface WebhookCatalogDeclaration {
  subjects: Readonly<Record<string, WebhookSubjectDeclaration>>;
  events: readonly WebhookEventDeclaration[];
}

/** The value one emit gives a subject: one id, or a list (a thing in several projects). */
export type WebhookSubjectValue = string | readonly string[];

/** An event type: `family.verb`, lowercase, digits and underscores allowed after the first letter. */
export const WEBHOOK_EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const SUBJECT_KEY = /^[a-z][a-z0-9_]*$/;

/** The test ping every endpoint can be sent (`POST /webhooks/{id}/test`). */
export const WEBHOOK_PING_EVENT = 'webhook.ping';

/**
 * The chassis's own events: what the generic half knows happened, bridged
 * from the in-process bus (member, workspace, key events) or emitted inside
 * the write's transaction where the chassis owns it (projects, the ping).
 * None names a tool. A tool may not re-declare one of these types.
 */
export const CHASSIS_WEBHOOK_EVENTS: readonly WebhookEventDeclaration[] = [
  {
    type: WEBHOOK_PING_EVENT,
    description: 'A test delivery, sent on request from the endpoint page or the API.',
    subjects: [],
    data: z.object({ endpointId: z.string(), sentBy: z.string().nullable() })
  },
  {
    type: 'member.joined',
    description: 'A person joined the workspace (setup, an accepted invitation, a claimed grant).',
    subjects: [],
    data: z.object({ userId: z.string(), role: z.string() })
  },
  {
    type: 'member.removed',
    description: 'A person was removed from the workspace.',
    subjects: [],
    data: z.object({ userId: z.string() })
  },
  {
    type: 'workspace.created',
    description: 'A workspace was created from inside the product.',
    subjects: [],
    data: z.object({ ownerUserId: z.string() })
  },
  {
    type: 'apikey.created',
    description: 'An API key was created in the workspace.',
    subjects: [],
    data: z.object({ apiKeyId: z.string() })
  },
  {
    type: 'apikey.revoked',
    description: 'An API key of the workspace was revoked.',
    subjects: [],
    data: z.object({ apiKeyId: z.string() })
  },
  {
    type: 'project.created',
    description: 'A project was created in the workspace.',
    subjects: ['project'],
    data: z.object({ projectId: z.string(), name: z.string(), slug: z.string(), createdBy: z.string() })
  },
  {
    type: 'project.archived',
    description: 'A project of the workspace was archived.',
    subjects: ['project'],
    data: z.object({ projectId: z.string(), name: z.string(), slug: z.string() })
  }
];

/**
 * The chassis's own subject: a project, which every tool has (the chassis
 * owns projects). A tool that declares `project` itself must name the same
 * field; the boot refuses a different one.
 */
export const CHASSIS_WEBHOOK_SUBJECTS: Readonly<Record<string, WebhookSubjectDeclaration>> = {
  project: { field: 'projectId', description: 'A project of the workspace, by id' }
};

/** The merged, checked catalog an instance runs on. */
export interface WebhookCatalogIndex {
  subjects: Readonly<Record<string, WebhookSubjectDeclaration>>;
  events: ReadonlyMap<string, WebhookEventDeclaration>;
}

/**
 * Merge the chassis's events with the tool's and check the whole, at boot:
 * a type that is not `family.verb`, a type declared twice (or re-declaring a
 * chassis type), a subject key that is not a plain identifier, an event
 * carrying a subject nobody declared, or the chassis's `project` subject
 * declared under another field, stops the boot naming the fault.
 */
export function buildWebhookCatalog(tool: WebhookCatalogDeclaration | undefined): WebhookCatalogIndex {
  const subjects: Record<string, WebhookSubjectDeclaration> = { ...CHASSIS_WEBHOOK_SUBJECTS };
  for (const [key, subject] of Object.entries(tool?.subjects ?? {})) {
    if (!SUBJECT_KEY.test(key)) {
      throw new Error(`tool definition: webhooks.subjects key "${key}" must match ${SUBJECT_KEY}`);
    }
    if (typeof subject.field !== 'string' || subject.field === '') {
      throw new Error(`tool definition: webhooks.subjects.${key}.field is required (the envelope field)`);
    }
    const chassis = CHASSIS_WEBHOOK_SUBJECTS[key];
    if (chassis && chassis.field !== subject.field) {
      throw new Error(
        `tool definition: webhooks.subjects.${key} is the chassis's subject, written under "${chassis.field}", not "${subject.field}"`
      );
    }
    subjects[key] = subject;
  }
  const events = new Map<string, WebhookEventDeclaration>();
  for (const event of [...CHASSIS_WEBHOOK_EVENTS, ...(tool?.events ?? [])]) {
    if (!WEBHOOK_EVENT_TYPE.test(event.type)) {
      throw new Error(`tool definition: webhooks event type "${event.type}" must be family.verb (${WEBHOOK_EVENT_TYPE})`);
    }
    if (events.has(event.type)) {
      throw new Error(`tool definition: webhooks event type "${event.type}" is declared twice`);
    }
    if (event.type === '*' || event.type.endsWith('.*')) {
      throw new Error(`tool definition: webhooks event type "${event.type}" is a pattern, not a type`);
    }
    for (const key of event.subjects) {
      if (!(key in subjects)) {
        throw new Error(`tool definition: webhooks event "${event.type}" carries the subject "${key}", which webhooks.subjects does not declare`);
      }
    }
    if (typeof event.description !== 'string' || event.description === '') {
      throw new Error(`tool definition: webhooks event "${event.type}" needs a description`);
    }
    events.set(event.type, event);
  }
  return { subjects, events };
}

/** The catalog as `GET /webhooks/events` answers it: every event with the JSON Schema of its data. */
export function catalogToWire(catalog: WebhookCatalogIndex): WebhookCatalog {
  return {
    subjects: Object.entries(catalog.subjects).map(([key, s]) => ({
      key,
      field: s.field,
      description: s.description
    })),
    events: [...catalog.events.values()].map((e) => ({
      type: e.type,
      description: e.description,
      subjects: [...e.subjects],
      schema: z.toJSONSchema(e.data, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>
    }))
  };
}
