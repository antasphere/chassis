import { z } from 'zod';
import { cursorPageQuerySchema, hasControlChars, plainText } from './common.js';

/**
 * Connections (PRDCT-3773): every inbound webhook source a tool receives from
 * and every outbound key it holds, declared by the tool (the `connections`
 * slot: a key, a name, a kind, a verifier, the fields the source carries, a
 * handler), stored by the chassis (one row per workspace and source: the
 * sealed secret or key, the receiving token's hash, who connected it and
 * when, the declared fields, the last delivery), served on ONE page
 * (Settings › Connections, one card per source), one CLI group and one set
 * of MCP tools. The door, `POST /hooks/{source}/{token}`, lives outside
 * `/api/v1`: the signature is the credential.
 *
 * No answer ever carries a secret, a key or the receiving URL's token: the
 * URL is answered once, when it is made or rotated, and the secret never.
 */

/** A source key: lowercase, digits and underscores, starting with a letter (`meet`, `lemlist`). */
export const connectionSourceKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores, starting with a letter');

/** `inbound`: a source that posts to this instance; `key`: a key this instance holds; `both`. */
export const connectionKindSchema = z.enum(['inbound', 'key', 'both']);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

/** The path of the door, outside `/api/v1`: `<PUBLIC_BASE_URL>/hooks/<source>/<token>`. */
export const CONNECTION_HOOK_PATH = '/hooks';

/** One declared field of a source, as the page and the CLI show it. */
export const connectionFieldDeclarationSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  /** The value is a list of strings rather than one string. */
  multiple: z.boolean()
});
export type ConnectionFieldDeclaration = z.infer<typeof connectionFieldDeclarationSchema>;

/** What the tool declared about a source: the static half of a card. */
export const connectionDeclaredSchema = z.object({
  description: z.string().nullable(),
  /** `standard-webhooks`, `stripe`, or `custom` (the tool's own function); null for a key source. */
  verifier: z.string().nullable(),
  /** The event types the source sends (an inbound source); informative. */
  events: z.array(z.string()),
  /** What the secret looks like, for the form's placeholder (`whsec_…`); never a value. */
  secretHint: z.string().nullable(),
  fields: z.array(connectionFieldDeclarationSchema),
  /** The source is a sibling tool of the same hub (PRDCT-3774): its registry slug and the events to subscribe. */
  sibling: z.object({ toolSlug: z.string(), events: z.array(z.string()) }).nullable()
});
export type ConnectionDeclared = z.infer<typeof connectionDeclaredSchema>;

const member = z.object({ id: z.string(), name: z.string(), email: z.string() });

/** A field's stored value: a string, a list of strings, or null (unset). */
export const connectionFieldValueSchema = z.union([
  plainText(0, 2000),
  z.array(plainText(1, 2000)).max(200),
  z.null()
]);
export type ConnectionFieldValue = z.infer<typeof connectionFieldValueSchema>;

/** The stored fields of a connection, by declared key. */
export const connectionFieldsSchema = z.record(connectionSourceKeySchema, connectionFieldValueSchema);
export type ConnectionFields = z.infer<typeof connectionFieldsSchema>;

/** The outcome of one delivery the door took. */
export const connectionDeliveryOutcomeSchema = z.enum(['processed', 'ignored', 'failed']);
export type ConnectionDeliveryOutcome = z.infer<typeof connectionDeliveryOutcomeSchema>;

/**
 * One source as the page, the CLI and an agent read it: the declaration,
 * whether it is connected, who made the receiving URL and when (never the
 * URL), whether the secret is set and readable, by whom and when (never the
 * secret), the stored fields, the last delivery and the last test.
 */
export const connectionSchema = z.object({
  source: connectionSourceKeySchema,
  name: z.string(),
  kind: connectionKindSchema,
  declared: connectionDeclaredSchema,
  /** An inbound source: the URL is made and the secret set; a key source: the key is set. */
  connected: z.boolean(),
  /** The receiving URL's state (an inbound source): when the current one was made and by whom; null until made. */
  url: z.object({ madeAt: z.string(), madeBy: member.nullable() }).nullable(),
  secret: z.object({
    set: z.boolean(),
    /** False when the stored value no longer opens (the instance's auth secret changed): set it again. */
    readable: z.boolean(),
    setAt: z.string().nullable(),
    setBy: member.nullable()
  }),
  fields: connectionFieldsSchema,
  /** When the connection row was first made, by whom. */
  connectedAt: z.string().nullable(),
  connectedBy: member.nullable(),
  lastDelivery: z
    .object({ at: z.string(), type: z.string(), outcome: connectionDeliveryOutcomeSchema })
    .nullable(),
  /** The last test or probe: when, whether it passed, what it said. */
  check: z.object({ at: z.string(), ok: z.boolean(), detail: z.string() }).nullable(),
  /** A sibling source (PRDCT-3774): the endpoint registered on the sibling, null until connected as the person. */
  sibling: z.object({ endpointId: z.string().nullable() }).nullable()
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionsListSchema = z.object({ connections: z.array(connectionSchema) });
export type ConnectionsList = z.infer<typeof connectionsListSchema>;

/** `POST /connections/{source}`: the connection and the receiving URL, shown this once. */
export const connectionUrlMadeSchema = z.object({
  connection: connectionSchema,
  /** `<PUBLIC_BASE_URL>/hooks/<source>/<token>`: only the token's hash is kept, so the URL is never shown again. */
  receivingUrl: z.string()
});
export type ConnectionUrlMade = z.infer<typeof connectionUrlMadeSchema>;

/** `PUT /connections/{source}/secret`: the secret or the key as the source showed it. */
export const connectionSecretSchema = z.object({
  secret: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((v) => !/\s/.test(v) && !hasControlChars(v), {
      error: 'must not contain whitespace or control characters'
    })
});
export type ConnectionSecret = z.input<typeof connectionSecretSchema>;

/** `PATCH /connections/{source}`: the declared fields to store (a key absent keeps its value; null clears it). */
export const connectionFieldsUpdateSchema = z.object({ fields: connectionFieldsSchema });
export type ConnectionFieldsUpdate = z.infer<typeof connectionFieldsUpdateSchema>;

/** `POST /connections/{source}/test`: what the test found, and the connection after it. */
export const connectionTestResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  connection: connectionSchema
});
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

/** One delivery the door took for a source of a workspace. */
export const connectionDeliverySchema = z.object({
  id: z.string(),
  source: connectionSourceKeySchema,
  /** The sender's own id of the delivery (the `webhook-id` header, Stripe's event id): the dedupe key. */
  deliveryId: z.string(),
  type: z.string(),
  receivedAt: z.string(),
  outcome: connectionDeliveryOutcomeSchema,
  /** What the handler said, or null. */
  detail: z.string().nullable(),
  /** Why the handler failed, or null. */
  error: z.string().nullable()
});
export type ConnectionDelivery = z.infer<typeof connectionDeliverySchema>;

export const connectionDeliveriesListSchema = z.object({
  deliveries: z.array(connectionDeliverySchema),
  nextCursor: z.string().nullable()
});
export type ConnectionDeliveriesList = z.infer<typeof connectionDeliveriesListSchema>;

export const connectionDeliveriesListQuerySchema = cursorPageQuerySchema;

export const connectionParamsSchema = z.object({ source: connectionSourceKeySchema });
