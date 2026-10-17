import type { OpenAPIHono } from '@hono/zod-openapi';
import { appsListRoute } from '@antasphere/chassis-contract/routes';
import { requireAuth } from '../middleware/auth-context.js';
import type { AppsService } from './service.js';

/** The Apps page's one route. */
export const APPS_TREE = '/apps';

/**
 * `GET /apps` (PRDCT-3493): the other tools of the person's organization
 * (`./service.ts`). A browser session's alone: the scope allowlist names no
 * rule for it, so an API key or an OAuth token is refused 403 before the
 * handler (fail-closed), and the handler says the same to anything that is
 * not a session. Every member reads it, a guest included: it lists only what
 * the hub (or the operator) says the person may open.
 */
export function registerAppsRoutes(api: OpenAPIHono, service: AppsService): void {
  api.use(APPS_TREE, requireAuth());

  api.openapi(appsListRoute, async (c) => {
    const principal = c.get('principal')!;
    if (principal.via !== 'session') {
      return c.json(
        { error: { code: 'session_required', message: 'The apps list is read in a browser session' } },
        403
      );
    }
    return c.json(await service.list(principal), 200);
  });
}
