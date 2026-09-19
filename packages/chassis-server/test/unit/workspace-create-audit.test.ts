import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { auditMiddleware, type AuditService, type AuditWrite } from '@antasphere/chassis-server/audit';
import type { Principal } from '@antasphere/chassis-contract';

/**
 * A workspace never learns what its members do elsewhere (PRDCT-2444): the
 * generic audit middleware attributes every mutation to the workspace the
 * caller is CURRENTLY in — for POST /workspaces that is the wrong trail, so
 * the path is exempt and the handler writes its one genesis row into the NEW
 * workspace itself. This pins the exemption, and that it is exact.
 */
function appWithAudit() {
  const writes: AuditWrite[] = [];
  const audit = {
    write: async (entry: AuditWrite) => {
      writes.push(entry);
    }
  } as unknown as AuditService;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('principal', { userId: 'user-1', workspaceId: 'ws-current', via: 'session' } as Principal);
    await next();
  });
  app.use(
    '*',
    auditMiddleware(audit, () => '127.0.0.1')
  );
  app.post('/api/v1/workspaces', (c) => c.json({ workspace: { id: 'ws-new', name: 'New' } }, 201));
  app.post('/api/v1/workspaces-other', (c) => c.json({ ok: true }, 201));
  return { app, writes };
}

describe('audit middleware and workspace creation', () => {
  it('lands NO generic row in the caller’s current workspace for POST /workspaces', async () => {
    const { app, writes } = appWithAudit();
    const res = await app.request('/api/v1/workspaces', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(writes).toEqual([]);
  });

  it('the exemption is exact — a neighbouring path is still audited', async () => {
    const { app, writes } = appWithAudit();
    await app.request('/api/v1/workspaces-other', { method: 'POST' });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.workspaceId).toBe('ws-current');
  });
});
