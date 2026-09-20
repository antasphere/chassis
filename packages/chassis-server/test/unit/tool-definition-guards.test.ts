import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolIdentity } from '@antasphere/chassis-contract';
import { createPlatform, type ToolCopy, type ToolDefinition } from '@antasphere/chassis-server';
import { assertToolCopy, assertToolIdentity } from '../../src/tool-definition.js';
import { THINGS_COPY, THINGS_IDENTITY } from '../host/identity.js';
import { minimalTool } from '../host/minimal-tool.js';

/**
 * The boot-time half of "identity is required" (PRDCT-2531, verifier F-1).
 *
 * The types refuse a tool that omits `identity` or `copy`; these guards exist
 * for the definition the types cannot see (plain JS, a cast). Every case below
 * is therefore built through a cast, and every expectation is the whole
 * message, because the message naming the field is the point of the guard.
 *
 * The last block proves the BOOT calls them: a guard nobody calls passes every
 * test above it. Both guards run before the env is parsed and before any
 * database is touched, so the boot rejects without Postgres and this stays a
 * unit test.
 */

/** A deep, mutable copy of the host's identity, one field replaced (dotted path). */
function identityWith(path: string, value: unknown): ToolIdentity {
  const copy = JSON.parse(JSON.stringify(THINGS_IDENTITY)) as Record<string, unknown>;
  const segments = path.split('.');
  const last = segments.pop()!;
  let at = copy;
  for (const segment of segments) at = at[segment] as Record<string, unknown>;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy as unknown as ToolIdentity;
}

const IDENTITY_FIELDS = [
  'slug',
  'displayName',
  'apiKeyPrefix',
  'scopes.read',
  'scopes.write',
  'scopes.dataExport',
  'cliKeyScopesLabel',
  'cli.bin',
  'cli.envPrefix',
  'cli.legacyConfigDir',
  'mcp.serverName',
  'mcp.toolPrefix',
  'otelServiceName',
  'imageName'
] as const;

const COPY_SENTENCES = ['guestForbidden', 'guestTarget', 'fileInUse'] as const;

describe('assertToolIdentity', () => {
  it('passes a complete identity', () => {
    expect(() => assertToolIdentity(THINGS_IDENTITY)).not.toThrow();
  });

  it('refuses a definition whose slot is missing', () => {
    expect(() => assertToolIdentity(undefined)).toThrow(
      new Error('tool definition: the `identity` slot is required')
    );
  });

  it.each(IDENTITY_FIELDS)('refuses an EMPTY %s, naming the field', (field) => {
    expect(() => assertToolIdentity(identityWith(field, ''))).toThrow(
      new Error(`tool definition: identity.${field} is required (a non-empty string)`)
    );
  });

  it.each(IDENTITY_FIELDS)('refuses a MISSING %s, naming the field', (field) => {
    expect(() => assertToolIdentity(identityWith(field, undefined))).toThrow(
      new Error(`tool definition: identity.${field} is required (a non-empty string)`)
    );
  });

  it('refuses a whole group left out (no `mcp`), naming its first field', () => {
    expect(() => assertToolIdentity(identityWith('mcp', undefined))).toThrow(
      new Error('tool definition: identity.mcp.serverName is required (a non-empty string)')
    );
  });

  it('refuses a value that is not a string', () => {
    expect(() => assertToolIdentity(identityWith('apiKeyPrefix', 42))).toThrow(
      new Error('tool definition: identity.apiKeyPrefix is required (a non-empty string)')
    );
  });
});

describe('assertToolCopy', () => {
  it('passes a complete copy', () => {
    expect(() => assertToolCopy(THINGS_COPY)).not.toThrow();
  });

  it('refuses a definition whose slot is missing', () => {
    expect(() => assertToolCopy(undefined)).toThrow(
      new Error('tool definition: the `copy` slot is required')
    );
  });

  it.each(COPY_SENTENCES)('refuses an EMPTY %s, naming the sentence', (name) => {
    expect(() => assertToolCopy({ ...THINGS_COPY, [name]: '' })).toThrow(
      new Error(`tool definition: copy.${name} is required (a non-empty sentence)`)
    );
  });

  it.each(COPY_SENTENCES)('refuses a MISSING %s, naming the sentence', (name) => {
    const copy: Partial<ToolCopy> = { ...THINGS_COPY };
    delete copy[name];
    expect(() => assertToolCopy(copy as ToolCopy)).toThrow(
      new Error(`tool definition: copy.${name} is required (a non-empty sentence)`)
    );
  });
});

describe('the boot calls both guards, before it reads anything', () => {
  // An env the parser refuses (no DATABASE_URL): the guards speak first, so the
  // rejection is theirs and no database is needed to see it. The parser's own
  // refusal is a printed table and `process.exit(1)`; both are stubbed, so a boot
  // that got past the guards ends here as a plain rejection, quietly.
  const NO_ENV = {};
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`env parser: process.exit(${String(code)})`);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  type AnyTool = ToolDefinition<Record<string, never>, Record<string, never>>;
  const without = (slot: 'identity' | 'copy'): AnyTool => {
    const tool: Partial<typeof minimalTool> = { ...minimalTool };
    delete tool[slot];
    return tool as unknown as AnyTool;
  };

  it('a complete tool gets past the guards (the rejection is the env parser’s)', async () => {
    await expect(createPlatform(minimalTool).boot(NO_ENV)).rejects.toThrow(
      new Error('env parser: process.exit(1)')
    );
  });

  it('a tool cast past the types without `identity` does not boot', async () => {
    await expect(createPlatform(without('identity')).boot(NO_ENV)).rejects.toThrow(
      new Error('tool definition: the `identity` slot is required')
    );
  });

  it('a tool cast past the types without `copy` does not boot', async () => {
    await expect(createPlatform(without('copy')).boot(NO_ENV)).rejects.toThrow(
      new Error('tool definition: the `copy` slot is required')
    );
  });

  it('a tool with one empty identity field does not boot, and the boot names the field', async () => {
    const tool = { ...minimalTool, identity: identityWith('mcp.toolPrefix', '') } as unknown as AnyTool;
    await expect(createPlatform(tool).boot(NO_ENV)).rejects.toThrow(
      new Error('tool definition: identity.mcp.toolPrefix is required (a non-empty string)')
    );
  });

  it('a tool with one empty copy sentence does not boot, and the boot names the sentence', async () => {
    const tool = { ...minimalTool, copy: { ...THINGS_COPY, fileInUse: '' } } as unknown as AnyTool;
    await expect(createPlatform(tool).boot(NO_ENV)).rejects.toThrow(
      new Error('tool definition: copy.fileInUse is required (a non-empty sentence)')
    );
  });
});
