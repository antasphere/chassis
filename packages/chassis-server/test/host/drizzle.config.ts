import { defineConfig } from 'drizzle-kit';

/**
 * The chassis's own migration history, for its own test host: the chassis
 * tables alone, generated from the chassis schema into `test/host/drizzle`
 * (`pnpm db:generate` in this package). A tool's history starts from these
 * tables and adds its own; this one exists so the chassis suite boots without
 * a tool beside it.
 */
export default defineConfig({
  dialect: 'postgresql',
  // drizzle-kit resolves paths from the package root, where pnpm runs it.
  schema: '../chassis-db/src/schema.ts',
  out: './test/host/drizzle',
  verbose: true,
  strict: true
});
