import { describe, expect, it } from 'vitest';
import { buildEnvSchema } from '../../src/env.js';

/**
 * The webhooks' environment (PRDCT-3482, verifier round 1, G8): the switch
 * that opens private networks is refused on the cloud edition, by name, and
 * the delivery log's retention defaults to thirty days.
 */

const schema = buildEnvSchema({ version: '0.0.0-test' });
const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
const CLOUD = {
  ...BASE,
  EDITION: 'cloud',
  HUB_ISSUER_URL: 'https://account.example.com',
  HUB_CLIENT_ID: 'tool-client',
  HUB_CLIENT_SECRET: 'a-hub-client-secret-of-length'
};

const issuesOf = (source: Record<string, string>) => {
  const result = schema.safeParse(source);
  return result.success
    ? []
    : result.error.issues.map((i) => ({ key: i.path.join('.'), message: i.message }));
};

describe('WEBHOOKS_ALLOW_PRIVATE_NETWORKS', () => {
  it('is refused on EDITION=cloud, naming the key', () => {
    const issues = issuesOf({ ...CLOUD, WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' });
    expect(issues).toEqual([
      { key: 'WEBHOOKS_ALLOW_PRIVATE_NETWORKS', message: expect.stringMatching(/never on EDITION=cloud/) }
    ]);
  });

  it('a cloud env without it parses (the refusal is the switch, not the edition)', () => {
    expect(issuesOf(CLOUD)).toEqual([]);
    expect(
      schema.parse({ ...CLOUD, WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'false' }).WEBHOOKS_ALLOW_PRIVATE_NETWORKS
    ).toBe(false);
  });

  it('parses true on oss, and defaults to false', () => {
    expect(
      schema.parse({ ...BASE, WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' }).WEBHOOKS_ALLOW_PRIVATE_NETWORKS
    ).toBe(true);
    expect(schema.parse(BASE).WEBHOOKS_ALLOW_PRIVATE_NETWORKS).toBe(false);
  });
});

describe('WEBHOOK_DELIVERY_RETENTION_DAYS', () => {
  it('defaults to 30, takes 0 (keep forever), refuses a negative', () => {
    expect(schema.parse(BASE).WEBHOOK_DELIVERY_RETENTION_DAYS).toBe(30);
    expect(
      schema.parse({ ...BASE, WEBHOOK_DELIVERY_RETENTION_DAYS: '0' }).WEBHOOK_DELIVERY_RETENTION_DAYS
    ).toBe(0);
    expect(issuesOf({ ...BASE, WEBHOOK_DELIVERY_RETENTION_DAYS: '-1' }).map((i) => i.key)).toEqual([
      'WEBHOOK_DELIVERY_RETENTION_DAYS'
    ]);
  });
});
