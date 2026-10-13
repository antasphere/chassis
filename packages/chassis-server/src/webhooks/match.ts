import type { WebhookSubjectValue } from './catalog.js';

/**
 * The subscription rule, pure and unit-tested (`webhook-match.test.ts`): an
 * endpoint's `events` are matched against an event's type, its `filters`
 * against the event's subjects. The chassis never knows what a subject IS,
 * only that it is a key with one or several ids.
 */

/** `*` matches every type; `family.*` matches the family; a type matches itself. */
export function matchesEventType(patterns: readonly string[], type: string): boolean {
  const family = type.slice(0, type.indexOf('.'));
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === type) return true;
    if (pattern.endsWith('.*') && pattern.slice(0, -2) === family) return true;
  }
  return false;
}

/**
 * AND across the filter's keys, OR within a key's ids. An event that does not
 * carry a filtered subject does not match (a filter on `project` excludes an
 * event with no project). An empty filter matches everything.
 */
export function matchesFilters(
  filters: Readonly<Record<string, readonly string[]>>,
  subjects: Readonly<Record<string, WebhookSubjectValue>>
): boolean {
  for (const [key, ids] of Object.entries(filters)) {
    if (ids.length === 0) continue;
    const value = subjects[key];
    if (value === undefined) return false;
    const values = typeof value === 'string' ? [value] : value;
    if (!values.some((v) => ids.includes(v))) return false;
  }
  return true;
}

/** Whether an endpoint takes this event: enabled, the type subscribed, the filters satisfied. */
export function endpointWants(
  endpoint: { enabled: boolean; events: readonly string[]; filters: Readonly<Record<string, readonly string[]>> },
  type: string,
  subjects: Readonly<Record<string, WebhookSubjectValue>>
): boolean {
  return endpoint.enabled && matchesEventType(endpoint.events, type) && matchesFilters(endpoint.filters, subjects);
}
