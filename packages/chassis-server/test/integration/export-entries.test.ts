import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { workspaces, type Db } from '@antasphere/chassis-db';
import { createPlatform, type ExportEntry, type ToolDefinition } from '@antasphere/chassis-server';
import {
  createDatabase,
  extractCookie,
  makeCreateTestApp,
  readJson,
  SETUP_TOKEN,
  startPostgres
} from '@antasphere/chassis-server/testing';
import { minimalTool } from '../host/minimal-tool.js';

/**
 * The `api.exportEntries` slot (PRDCT-2543): a tool adds named entries of rows
 * to `GET /workspace/export`. This file carries its OWN two tools (the minimal
 * test tool with the slot filled, and the same without it), so it proves the
 * same thing under either runner of the suite: it never reads `@chassis-test/host`.
 *
 * The export bucket is 5 per user per 10 minutes: the filled tool's owner
 * exports four times here, the bare tool's owner once.
 */

const OWNER = {
  email: 'owner@export-entries.test',
  name: 'Export Owner',
  password: 'export-owner-password-1'
};
const IP = '10.7.0.1';

type MinimalTool = typeof minimalTool;

/** What the filled tool contributes: each test sets it, the slot reads it per export. */
let contribution: (db: Db, workspaceId: string) => Promise<ExportEntry[]> = async () => [];
const seen: Array<{ workspaceId: string }> = [];

const filledTool: MinimalTool = {
  ...minimalTool,
  api: {
    ...minimalTool.api,
    exportEntries: (domain) => {
      // Bound once, with the tool's domain (the minimal tool's is empty).
      expect(domain).toEqual({});
      return (db, workspaceId) => {
        seen.push({ workspaceId });
        return contribution(db, workspaceId);
      };
    }
  }
} satisfies ToolDefinition<Record<never, never>, Record<string, never>>;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const bootFilled = makeCreateTestApp((source?: NodeJS.ProcessEnv) => createPlatform(filledTool).boot(source));
const bootBare = makeCreateTestApp((source?: NodeJS.ProcessEnv) => createPlatform(minimalTool).boot(source));
type Booted = Awaited<ReturnType<typeof bootFilled>>;

let container: StartedPostgreSqlContainer;
let filled: Booted;
let bare: Booted;

async function claim(app: Booted): Promise<{ cookie: string; workspaceId: string }> {
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: SETUP_TOKEN, instanceName: 'Export Entries', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': IP })
  );
  expect(signIn.status).toBe(200);
  const cookie = extractCookie(signIn);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  return { cookie, workspaceId: me.workspace.id as string };
}

async function upload(app: Booted, cookie: string, name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

const exportAs = (app: Booted, cookie: string) =>
  app.app.request('/api/v1/workspace/export', { headers: { cookie, 'x-forwarded-for': IP } });

async function exportAuditRows(app: Booted, cookie: string): Promise<number> {
  const res = await app.app.request('/api/v1/audit?action=workspace.export', { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return (body.entries as Array<{ action: string }>).filter((e) => e.action === 'workspace.export').length;
}

let filledOwner: { cookie: string; workspaceId: string };
let filledBlobId: string;

beforeAll(async () => {
  container = await startPostgres();
  filled = await bootFilled(await createDatabase(container, 'export_entries_filled'));
  bare = await bootBare(await createDatabase(container, 'export_entries_bare'));
  filledOwner = await claim(filled);
  filledBlobId = await upload(filled, filledOwner.cookie, 'kept.bin', 'a blob that stays');
}, 240_000);

afterAll(async () => {
  await filled?.stop();
  await bare?.stop();
  await container?.stop();
});

describe('GET /workspace/export with the `api.exportEntries` slot filled', () => {
  it('writes the tool entries after files.json and before the blobs, rows as JSON, hostile names sanitized', async () => {
    contribution = async (db, workspaceId) => {
      // The handle is a live one and the id is the caller's workspace.
      const rows = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return [
        { name: 'things', rows },
        { name: '../../etc/cron.d/x', rows: [{ hostile: true }] },
        { name: 'ctl\u0000\u001f\u007fname', rows: [] }
      ];
    };
    const res = await exportAs(filled, filledOwner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'audit-log.ndjson',
      'files.json',
      'things.json',
      '.._.._etc_cron.d_x.json',
      'ctl___name.json',
      `files/${filledBlobId}-kept.bin`,
      'skipped-blobs.json'
    ]);
    expect(zip.readAsText('things.json')).toBe(
      JSON.stringify([{ id: filledOwner.workspaceId, name: 'Export Entries' }], null, 2) + '\n'
    );
    expect(JSON.parse(zip.readAsText('.._.._etc_cron.d_x.json'))).toEqual([{ hostile: true }]);
    expect(JSON.parse(zip.readAsText('ctl___name.json'))).toEqual([]);
    // The manifest does not list the tool's entries.
    expect(Object.keys(JSON.parse(zip.readAsText('manifest.json')))).toEqual([
      'formatVersion',
      'exportedAt',
      'instance',
      'workspaceId'
    ]);
    expect(seen.at(-1)).toEqual({ workspaceId: filledOwner.workspaceId });
    expect(await exportAuditRows(filled, filledOwner.cookie)).toBe(1);
  });

  it('an empty list writes nothing: the entry list is the bare one', async () => {
    contribution = async () => [];
    const res = await exportAs(filled, filledOwner.cookie);
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'audit-log.ndjson',
      'files.json',
      `files/${filledBlobId}-kept.bin`,
      'skipped-blobs.json'
    ]);
    expect(await exportAuditRows(filled, filledOwner.cookie)).toBe(2);
  });

  it('a name that collides with a chassis entry answers 500, no zip, no audit row', async () => {
    contribution = async () => [{ name: 'files', rows: [{ overwrite: true }] }];
    const res = await exportAs(filled, filledOwner.cookie);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = await readJson(res);
    expect(JSON.stringify(body)).not.toContain('already an entry');
    expect(await exportAuditRows(filled, filledOwner.cookie)).toBe(2);
  });

  it('a contribution that throws answers 500, no zip, no audit row', async () => {
    contribution = async () => {
      throw new Error('the tool could not read its rows');
    };
    const calls = seen.length;
    const res = await exportAs(filled, filledOwner.cookie);
    expect(seen.length).toBe(calls + 1);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await exportAuditRows(filled, filledOwner.cookie)).toBe(2);
  });
});

describe('GET /workspace/export with the slot ABSENT', () => {
  it("the bundle's entry list is exactly the chassis sections and the blobs", async () => {
    const owner = await claim(bare);
    const blobId = await upload(bare, owner.cookie, 'kept.bin', 'a blob that stays');
    const res = await exportAs(bare, owner.cookie);
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'audit-log.ndjson',
      'files.json',
      `files/${blobId}-kept.bin`,
      'skipped-blobs.json'
    ]);
    expect(await exportAuditRows(bare, owner.cookie)).toBe(1);
  });
});
