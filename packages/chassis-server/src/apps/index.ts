/**
 * The Apps page (PRDCT-3493): the other tools of the person's organization,
 * from the hub as the person (`GET /me/apps`) or from the operator's
 * `APPS_FILE`, served on `GET /apps` by the chassis core, so every tool on
 * the template lists its siblings with their registry descriptor and never
 * ships a copy of the others' look.
 */
export { AppsService, APPS_CACHE_TTL_MS, type AppsServiceOptions, type HubTokens } from './service.js';
export { registerAppsRoutes, APPS_TREE } from './routes.js';
export {
  HUB_APP_NAME,
  appsFromFile,
  readDescriptor,
  safeHttpUrl,
  selectHubApps,
  type FileApps
} from './select.js';
