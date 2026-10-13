import { describe, expect, it } from 'vitest';
import { endpointWants, matchesEventType, matchesFilters } from '../../src/webhooks/match.js';

/**
 * The subscription rule (PRDCT-3482, verifier round 1, G7): an endpoint's
 * event patterns against a type, its filters against the event's subjects.
 */

describe('matchesEventType', () => {
  it('`*` matches every type', () => {
    expect(matchesEventType(['*'], 'thing.created')).toBe(true);
    expect(matchesEventType(['*'], 'webhook.ping')).toBe(true);
  });

  it('a family matches its own types only', () => {
    expect(matchesEventType(['thing.*'], 'thing.created')).toBe(true);
    expect(matchesEventType(['thing.*'], 'thing.deleted')).toBe(true);
    expect(matchesEventType(['thing.*'], 'project.created')).toBe(false);
    // A family is the whole segment before the dot, never a prefix of it.
    expect(matchesEventType(['thing.*'], 'things.created')).toBe(false);
    expect(matchesEventType(['thin.*'], 'thing.created')).toBe(false);
  });

  it('an exact type matches itself only', () => {
    expect(matchesEventType(['thing.created'], 'thing.created')).toBe(true);
    expect(matchesEventType(['thing.created'], 'thing.deleted')).toBe(false);
  });

  it('any of several patterns; none is no match', () => {
    expect(matchesEventType(['project.created', 'thing.deleted'], 'thing.deleted')).toBe(true);
    expect(matchesEventType(['project.created', 'thing.deleted'], 'thing.created')).toBe(false);
    expect(matchesEventType([], 'thing.created')).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('an empty filter matches everything, an event with no subject included', () => {
    expect(matchesFilters({}, {})).toBe(true);
    expect(matchesFilters({}, { thing: 't1' })).toBe(true);
  });

  it('a key with no ids is no constraint', () => {
    expect(matchesFilters({ project: [] }, { thing: 't1' })).toBe(true);
  });

  it('OR within one key: any id matches, on a scalar or a list', () => {
    expect(matchesFilters({ thing: ['t1', 't2'] }, { thing: 't2' })).toBe(true);
    expect(matchesFilters({ thing: ['t1', 't2'] }, { thing: 't3' })).toBe(false);
    expect(matchesFilters({ project: ['p9'] }, { project: ['p1', 'p9'] })).toBe(true);
    expect(matchesFilters({ project: ['p9'] }, { project: ['p1', 'p2'] })).toBe(false);
  });

  it('AND across keys: every filtered key must match', () => {
    const filters = { thing: ['t-a'], project: ['p-a'] };
    expect(matchesFilters(filters, { thing: 't-a', project: ['p-a'] })).toBe(true);
    expect(matchesFilters(filters, { thing: 't-a', project: ['p-b'] })).toBe(false);
    expect(matchesFilters(filters, { thing: 't-b', project: ['p-a'] })).toBe(false);
  });

  it('an event missing a filtered subject does not match', () => {
    expect(matchesFilters({ project: ['p1'] }, { thing: 't1' })).toBe(false);
    expect(matchesFilters({ thing: ['t1'], project: ['p1'] }, { thing: 't1' })).toBe(false);
  });
});

describe('endpointWants', () => {
  const endpoint = { enabled: true, events: ['thing.*'], filters: { thing: ['t1'] } };

  it('enabled, the type subscribed and the filters satisfied', () => {
    expect(endpointWants(endpoint, 'thing.created', { thing: 't1' })).toBe(true);
  });

  it('a disabled endpoint wants nothing', () => {
    expect(endpointWants({ ...endpoint, enabled: false }, 'thing.created', { thing: 't1' })).toBe(false);
  });

  it('the type unsubscribed, or the filters unmet, is no', () => {
    expect(endpointWants(endpoint, 'project.created', { thing: 't1' })).toBe(false);
    expect(endpointWants(endpoint, 'thing.created', { thing: 't2' })).toBe(false);
  });
});
