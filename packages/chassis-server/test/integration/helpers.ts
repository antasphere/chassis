import { makeCreateTestApp, type TestApp as ChassisTestApp } from '@antasphere/chassis-server/testing';
import { host, type HostBootResult } from '@chassis-test/host';

/**
 * The chassis suite's harness. Every file of this directory (but
 * `empty-tool.test.ts`, which carries its own tool) runs TWICE: by this
 * package against the minimal test tool (`test/host/minimal-host.ts`), and by
 * the tool's app against its real composition. `@chassis-test/host` is the ONE
 * module specifier each runner's vitest config aliases to its own host; the
 * suite never spells a tool's scope names or routes, it takes them from `host`.
 */
export {
  RecordingEmailDriver,
  SETUP_TOKEN,
  PG_IMAGE,
  startPostgres,
  expectBootRefusal,
  createDatabase,
  truncateAll,
  readJson,
  extractCookie
} from '@antasphere/chassis-server/testing';

export { host };

export type TestApp = ChassisTestApp<HostBootResult>;

/** Boot the host's real app (real migrations, real Better Auth) against a database. */
export const createTestApp = makeCreateTestApp(host.boot);
