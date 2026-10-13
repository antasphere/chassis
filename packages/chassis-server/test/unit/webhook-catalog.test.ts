import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildWebhookCatalog,
  catalogToWire,
  CHASSIS_WEBHOOK_EVENTS,
  type WebhookCatalogDeclaration,
  type WebhookEventDeclaration
} from '../../src/webhooks/catalog.js';

/**
 * The boot check of the webhooks catalog (PRDCT-3482, verifier round 1, G7):
 * the chassis's events merged with the tool's, every fault named at boot, and
 * the wire form `GET /webhooks/events` answers.
 */

const thingCreated: WebhookEventDeclaration = {
  type: 'thing.created',
  description: 'A thing was created.',
  subjects: ['thing', 'project'],
  data: z.object({ thingId: z.string(), name: z.string() })
};

const tool = (over: Partial<WebhookCatalogDeclaration> = {}): WebhookCatalogDeclaration => ({
  subjects: { thing: { field: 'thingId', description: 'A thing, by id' } },
  events: [thingCreated],
  ...over
});

describe('buildWebhookCatalog', () => {
  it('merges the chassis events with the tool events', () => {
    const catalog = buildWebhookCatalog(tool());
    for (const e of CHASSIS_WEBHOOK_EVENTS) expect(catalog.events.has(e.type), e.type).toBe(true);
    expect(catalog.events.get('thing.created')).toBe(thingCreated);
    expect(Object.keys(catalog.subjects).sort()).toEqual(['project', 'thing']);
  });

  it('a tool with no webhooks slot gets the chassis catalog alone', () => {
    const catalog = buildWebhookCatalog(undefined);
    expect([...catalog.events.keys()].sort()).toEqual(CHASSIS_WEBHOOK_EVENTS.map((e) => e.type).sort());
    expect(catalog.subjects.project).toMatchObject({ field: 'projectId' });
  });

  it('refuses a type declared twice', () => {
    expect(() => buildWebhookCatalog(tool({ events: [thingCreated, { ...thingCreated }] }))).toThrow(
      /"thing\.created" is declared twice/
    );
  });

  it('refuses a tool re-declaring a chassis type', () => {
    expect(() =>
      buildWebhookCatalog(tool({ events: [{ ...thingCreated, type: 'project.created' }] }))
    ).toThrow(/"project\.created" is declared twice/);
  });

  it('refuses an event carrying a subject nobody declared', () => {
    expect(() =>
      buildWebhookCatalog(tool({ events: [{ ...thingCreated, subjects: ['thing', 'widget'] }] }))
    ).toThrow(/carries the subject "widget", which webhooks\.subjects does not declare/);
  });

  it.each(['Thing.created', 'thing', 'thing.created.now', 'thing-x.created', '1thing.created', 'thing.'])(
    'refuses the malformed type %s',
    (type) => {
      expect(() => buildWebhookCatalog(tool({ events: [{ ...thingCreated, type }] }))).toThrow(
        /must be family\.verb/
      );
    }
  );

  it.each(['*', 'thing.*'])('refuses the pattern %s as a type', (type) => {
    expect(() => buildWebhookCatalog(tool({ events: [{ ...thingCreated, type }] }))).toThrow(
      new RegExp(`"${type.replace(/[.*]/g, '\\$&')}"`)
    );
  });

  it('refuses an event without a description', () => {
    expect(() => buildWebhookCatalog(tool({ events: [{ ...thingCreated, description: '' }] }))).toThrow(
      /"thing\.created" needs a description/
    );
  });

  it('refuses a malformed subject key and a subject without a field', () => {
    expect(() =>
      buildWebhookCatalog(tool({ subjects: { 'Bad-Key': { field: 'x', description: 'x' } } }))
    ).toThrow(/webhooks\.subjects key "Bad-Key"/);
    expect(() => buildWebhookCatalog(tool({ subjects: { thing: { field: '', description: 'x' } } }))).toThrow(
      /webhooks\.subjects\.thing\.field is required/
    );
  });

  it('accepts a tool renaming the project subject’s field (a list under projectIds)', () => {
    const catalog = buildWebhookCatalog(
      tool({
        subjects: {
          thing: { field: 'thingId', description: 'A thing, by id' },
          project: { field: 'projectIds', description: 'The projects of a thing', list: true }
        }
      })
    );
    expect(catalog.subjects.project).toEqual({
      field: 'projectIds',
      description: 'The projects of a thing',
      list: true
    });
    // The chassis's own project events now carry the tool's declaration.
    expect(catalog.events.get('project.created')?.subjects).toEqual(['project']);
  });
});

describe('catalogToWire', () => {
  it('carries list: true for a list subject and false otherwise, and the JSON Schema of every event', () => {
    const wire = catalogToWire(
      buildWebhookCatalog(
        tool({
          subjects: {
            thing: { field: 'thingId', description: 'A thing, by id' },
            project: { field: 'projectIds', description: 'The projects of a thing', list: true }
          }
        })
      )
    );
    expect(wire.subjects).toEqual(
      expect.arrayContaining([
        { key: 'thing', field: 'thingId', description: 'A thing, by id', list: false },
        { key: 'project', field: 'projectIds', description: 'The projects of a thing', list: true }
      ])
    );
    expect(wire.subjects).toHaveLength(2);
    const created = wire.events.find((e) => e.type === 'thing.created');
    expect(created).toMatchObject({
      description: 'A thing was created.',
      subjects: ['thing', 'project'],
      schema: {
        type: 'object',
        properties: { thingId: { type: 'string' }, name: { type: 'string' } },
        required: ['thingId', 'name']
      }
    });
    expect(wire.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['webhook.ping', 'project.created', 'thing.created'])
    );
  });

  it('the chassis’s own project subject reads list: false', () => {
    const wire = catalogToWire(buildWebhookCatalog(undefined));
    expect(wire.subjects).toEqual([
      { key: 'project', field: 'projectId', description: expect.any(String), list: false }
    ]);
  });
});
