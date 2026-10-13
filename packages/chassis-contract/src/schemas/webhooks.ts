import { z } from 'zod';
import { cursorPageQuerySchema, hasControlChars, plainText } from './common.js';

/**
 * Outbound webhooks (PRDCT-3482): a URL a workspace registers to be told, by a
 * signed POST, when something happens to the tool's own subjects. The tool
 * declares the event types and the subjects they carry (the catalog); the
 * chassis stores the endpoints, matches the events against them, signs and
 * delivers, and keeps each delivery's history. Owners and admins manage them.
 *
 * The signing secret is NEVER part of an endpoint's shape: it is shown once,
 * at creation and at each rotation, and stored sealed.
 */

/**
 * What an endpoint subscribes to: an exact event type (`thing.created`), a
 * family (`thing.*`) or everything (`*`).
 */
export const webhookEventPatternSchema = z
  .string()
  .max(80)
  .regex(
    /^(\*|[a-z][a-z0-9_]*\.(\*|[a-z][a-z0-9_]*))$/,
    'an event type (thing.created), a family (thing.*) or everything (*)'
  );

/** A subject key of the catalog (`thing`, `project`): lowercase, digits and underscores. */
export const webhookSubjectKeySchema = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores, starting with a letter');

/**
 * Narrows a subscription by subject: a subject key mapped to the ids it
 * accepts. AND across keys, OR within a key; an event that does not carry a
 * filtered subject does not match. An empty object filters nothing.
 */
export const webhookFiltersSchema = z
  .record(webhookSubjectKeySchema, z.array(plainText(1, 200)).min(1).max(100))
  .refine((v) => Object.keys(v).length <= 10, { error: 'at most 10 subject keys' })
  .describe(
    'Subject key → ids; AND across keys, OR within a key; an event that does not carry a filtered subject does not match'
  );
export type WebhookFilters = z.infer<typeof webhookFiltersSchema>;

/**
 * The WHATWG URL parser, present in every runtime this contract runs in (Node,
 * the browser); typed here because the package compiles without DOM or Node
 * types, to stay runtime-neutral.
 */
type UrlParts = { protocol: string; username: string; password: string };
const UrlParser = (globalThis as unknown as { URL: new (input: string) => UrlParts }).URL;

function isHttpUrlWithoutCredentials(value: string): boolean {
  let parsed: UrlParts;
  try {
    parsed = new UrlParser(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/**
 * Where the deliveries go: an http or https URL without credentials. Whitespace
 * and control characters are refused outright, because the URL parser silently
 * strips tabs and newlines, so the stored string would not be the address
 * delivered to. The address rules (ports, private networks, https on the cloud
 * edition) are the server's, answered `url_refused`.
 */
export const webhookUrlSchema = z
  .string()
  .max(2048)
  .refine((v) => !/\s/.test(v) && !hasControlChars(v), {
    error: 'must not contain whitespace or control characters',
    abort: true
  })
  .refine(isHttpUrlWithoutCredentials, { error: 'an http or https URL without credentials' });

export const webhookDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed', 'held']);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;

export const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string(),
  events: z.array(z.string()),
  filters: z.record(z.string(), z.array(z.string())),
  enabled: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set with `disabledReason` when the endpoint was switched off after failing too long. */
  disabledAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: z.string().nullable(),
  lastDeliveryStatus: z.enum(['delivered', 'failed']).nullable(),
  /** During a rotation, the previous secret keeps signing until this date. */
  previousSecretExpiresAt: z.string().nullable()
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/** The endpoint as created, with its signing secret (`whsec_…`), shown ONCE. */
export const webhookEndpointCreatedSchema = webhookEndpointSchema.extend({
  secret: z.string()
});
export type WebhookEndpointCreated = z.infer<typeof webhookEndpointCreatedSchema>;

/**
 * The endpoint after a rotation, with its new secret, shown ONCE; the previous
 * secret keeps signing until `previousSecretExpiresAt`.
 */
export const webhookSecretRotatedSchema = webhookEndpointSchema.extend({
  secret: z.string(),
  previousSecretExpiresAt: z.string()
});
export type WebhookSecretRotated = z.infer<typeof webhookSecretRotatedSchema>;

const webhookDescriptionSchema = plainText(0, 200);
const webhookEventsSchema = z.array(webhookEventPatternSchema).min(1).max(50);

export const webhookEndpointCreateSchema = z.object({
  url: webhookUrlSchema,
  description: webhookDescriptionSchema.default(''),
  events: webhookEventsSchema,
  filters: webhookFiltersSchema.default({}),
  enabled: z.boolean().default(true)
});
/** The INPUT shape: `description`, `filters` and `enabled` may be left out. */
export type WebhookEndpointCreate = z.input<typeof webhookEndpointCreateSchema>;

/** Every field optional, none defaulted (a PATCH never resets what it does not name). */
export const webhookEndpointUpdateSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    description: webhookDescriptionSchema.optional(),
    events: webhookEventsSchema.optional(),
    filters: webhookFiltersSchema.optional(),
    enabled: z.boolean().optional()
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { error: 'nothing to change' });
export type WebhookEndpointUpdate = z.infer<typeof webhookEndpointUpdateSchema>;

export const webhooksListSchema = z.object({
  webhooks: z.array(webhookEndpointSchema),
  nextCursor: z.string().nullable()
});
export type WebhooksList = z.infer<typeof webhooksListSchema>;

export const webhooksListQuerySchema = cursorPageQuerySchema;

/**
 * One event sent to one endpoint, with its attempts. `eventId` is the
 * receiver's dedupe key, the same on every attempt and on a redelivery;
 * `lastStatusCode` and `lastError` describe the latest attempt only;
 * `payload` is the envelope as sent.
 */
export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: webhookDeliveryStatusSchema,
  attempt: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  payload: z.record(z.string(), z.unknown())
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveriesListSchema = z.object({
  deliveries: z.array(webhookDeliverySchema),
  nextCursor: z.string().nullable()
});
export type WebhookDeliveriesList = z.infer<typeof webhookDeliveriesListSchema>;

export const webhookDeliveriesListQuerySchema = cursorPageQuerySchema.extend({
  status: webhookDeliveryStatusSchema.optional()
});

/** The `webhook.ping` attempted inline: its outcome is on the delivery row. */
export const webhookTestResultSchema = z.object({
  delivery: webhookDeliverySchema
});
export type WebhookTestResult = z.infer<typeof webhookTestResultSchema>;

/** A subject events can carry and endpoints can filter on: its key, the field of `data` holding its id. */
export const webhookCatalogSubjectSchema = z.object({
  key: z.string(),
  field: z.string(),
  description: z.string()
});
export type WebhookCatalogSubject = z.infer<typeof webhookCatalogSubjectSchema>;

export const webhookCatalogEventSchema = z.object({
  type: z.string(),
  description: z.string(),
  /** The subject keys this event carries (what a filter can match it on). */
  subjects: z.array(z.string()),
  /** The JSON Schema of the event's `data`. */
  schema: z.record(z.string(), z.unknown())
});
export type WebhookCatalogEvent = z.infer<typeof webhookCatalogEventSchema>;

export const webhookCatalogSchema = z.object({
  subjects: z.array(webhookCatalogSubjectSchema),
  events: z.array(webhookCatalogEventSchema)
});
export type WebhookCatalog = z.infer<typeof webhookCatalogSchema>;

/** `{id}` the endpoint (a uuid, as every `{id}` path param). */
export const webhookParamsSchema = z.object({ id: z.uuid() });

/** `{id}` the endpoint, `{deliveryId}` one of its deliveries: both uuids. */
export const webhookDeliveryParamsSchema = webhookParamsSchema.extend({ deliveryId: z.uuid() });
