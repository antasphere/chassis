import { describe, expect, it } from 'vitest';
import {
  webhookDeliveriesListQuerySchema,
  webhookDeliveryParamsSchema,
  webhookEndpointCreateSchema,
  webhookEndpointCreatedSchema,
  webhookEndpointSchema,
  webhookEndpointUpdateSchema,
  webhookEventPatternSchema,
  webhookFiltersSchema,
  webhookUrlSchema
} from '../src/index.js';
import {
  webhookCatalogRoute,
  webhookCreateRoute,
  webhookDeliveryGetRoute,
  webhookRedeliverRoute
} from '../src/routes/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

describe('webhook event patterns', () => {
  it('takes an exact type, a family or everything', () => {
    for (const v of ['thing.created', 'thing.*', '*', 'some_thing.status_changed', 'a1.b2']) {
      expect(ok(webhookEventPatternSchema, v), v).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const v of [
      '',
      'thing',
      '*.created',
      'thing.created.extra',
      'Thing.created',
      '1thing.x',
      'thing.',
      '**',
      `a.${'b'.repeat(80)}`
    ]) {
      expect(ok(webhookEventPatternSchema, v), v).toBe(false);
    }
  });
});

describe('webhook filters', () => {
  it('maps subject keys to non-empty id lists', () => {
    expect(ok(webhookFiltersSchema, {})).toBe(true);
    expect(ok(webhookFiltersSchema, { thing: ['a', 'b'], project: ['p'] })).toBe(true);
  });

  it('refuses a bad key, an empty list, an empty id, a control character and more than 10 keys', () => {
    expect(ok(webhookFiltersSchema, { Thing: ['a'] })).toBe(false);
    expect(ok(webhookFiltersSchema, { thing: [] })).toBe(false);
    expect(ok(webhookFiltersSchema, { thing: [''] })).toBe(false);
    expect(ok(webhookFiltersSchema, { thing: ['a\u0000'] })).toBe(false);
    expect(ok(webhookFiltersSchema, { thing: Array.from({ length: 101 }, (_, i) => `id${i}`) })).toBe(false);
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, ['x']]));
    expect(ok(webhookFiltersSchema, eleven)).toBe(false);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, ['x']]));
    expect(ok(webhookFiltersSchema, ten)).toBe(true);
  });
});

describe('webhook URL', () => {
  it('takes http and https URLs', () => {
    expect(ok(webhookUrlSchema, 'https://example.com/hooks')).toBe(true);
    expect(ok(webhookUrlSchema, 'http://example.com:8080/x?y=1')).toBe(true);
  });

  it('refuses another scheme, credentials, whitespace and a non-URL', () => {
    for (const v of [
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'https://user@example.com',
      'https://example.com/a\nb',
      ' https://example.com',
      'example.com',
      `https://example.com/${'a'.repeat(2048)}`
    ]) {
      expect(ok(webhookUrlSchema, v), v).toBe(false);
    }
  });
});

describe('webhook endpoint create and update', () => {
  it('fills the defaults on create', () => {
    const parsed = webhookEndpointCreateSchema.parse({ url: 'https://example.com', events: ['thing.*'] });
    expect(parsed).toEqual({
      url: 'https://example.com',
      description: '',
      events: ['thing.*'],
      filters: {},
      enabled: true
    });
  });

  it('needs at least one event, at most 50', () => {
    expect(ok(webhookEndpointCreateSchema, { url: 'https://example.com', events: [] })).toBe(false);
    expect(
      ok(webhookEndpointCreateSchema, { url: 'https://example.com', events: Array(51).fill('thing.created') })
    ).toBe(false);
  });

  it('defaults nothing on update and refuses an empty change', () => {
    expect(webhookEndpointUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(ok(webhookEndpointUpdateSchema, {})).toBe(false);
  });
});

describe('the signing secret', () => {
  it('is never part of an endpoint, only of the created answer', () => {
    expect('secret' in webhookEndpointSchema.shape).toBe(false);
    expect('secret' in webhookEndpointCreatedSchema.shape).toBe(true);
  });
});

describe('webhook params and queries', () => {
  it('takes uuids only', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(ok(webhookDeliveryParamsSchema, { id, deliveryId: id })).toBe(true);
    expect(ok(webhookDeliveryParamsSchema, { id, deliveryId: 'nope' })).toBe(false);
  });

  it('filters deliveries by a known status', () => {
    expect(ok(webhookDeliveriesListQuerySchema, { status: 'held' })).toBe(true);
    expect(ok(webhookDeliveriesListQuerySchema, { status: 'lost' })).toBe(false);
  });
});

describe('webhook routes', () => {
  it('declares the paths and the answers the server registers', () => {
    expect(webhookCatalogRoute.path).toBe('/webhooks/events');
    expect(Object.keys(webhookCreateRoute.responses)).toContain('201');
    expect(webhookDeliveryGetRoute.path).toBe('/webhooks/{id}/deliveries/{deliveryId}');
    expect(webhookRedeliverRoute.method).toBe('post');
    expect(Object.keys(webhookRedeliverRoute.responses)).toContain('201');
  });
});
