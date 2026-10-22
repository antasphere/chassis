import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AnyConnectionService } from './service.js';

/**
 * The door (PRDCT-3773): `POST /hooks/:source/:token`, outside `/api/v1`,
 * mounted by the chassis in the root app's public slot before the tool's own
 * public routes. No session, no key, no allowlist: the token names the
 * workspace, the signature on the RAW body is the credential, and the
 * verdicts are the service's (`receive`). A body over the cap is refused
 * before it is read; the wall is per address and the chassis's own.
 */

/** A delivery is a small JSON envelope: anything larger is refused before it is read. */
export const CONNECTION_BODY_MAX = 256 * 1024;

export function connectionDoor(service: AnyConnectionService, wall: MiddlewareHandler): Hono {
  const app = new Hono();
  app.post(
    '/hooks/:source/:token',
    wall,
    bodyLimit({
      maxSize: CONNECTION_BODY_MAX,
      onError: (c) => c.json({ ok: false, code: 'payload_too_large' }, 413)
    }),
    async (c) => {
      const source = c.req.param('source');
      const token = c.req.param('token');
      const raw = await c.req.text();
      const receipt = await service.receive(source, token, (name) => c.req.header(name), raw);
      return c.json(receipt.body, receipt.status);
    }
  );
  return app;
}
