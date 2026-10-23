/**
 * The fleet (PRDCT-3772): the origins of the hub's registry tools, the list
 * a tool's webhook delivery guard reads from the hub's public
 * `GET /api/v1/tool-origins`. The hub owns the shape and publishes it as
 * `@antasphere/contract` (PRDCT-3325); re-exported here under the chassis's
 * names like the billing rail's messages (`entitlements.ts`), never
 * redefined.
 */
export { toolOriginSchema, toolOriginsSchema, type ToolOrigin, type ToolOrigins } from '@antasphere/contract';
