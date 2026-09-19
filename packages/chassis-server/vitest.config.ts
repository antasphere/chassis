import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The host of the chassis suite (test/integration): here, the minimal
      // test tool. The tool's app aliases the same specifier to its own host.
      { find: '@chassis-test/host', replacement: at('./test/host/minimal-host.ts') },
      // This package's tests exercise its SOURCE, under the names its
      // consumers import (the suite files run under the tool's app too, where
      // these names resolve to the built package): one loaded copy per run.
      { find: /^@antasphere\/chassis-server$/, replacement: at('./src/index.ts') },
      { find: /^@antasphere\/chassis-server\/(env|logger)$/, replacement: at('./src/') + '$1.ts' },
      { find: /^@antasphere\/chassis-server\/(.+)$/, replacement: at('./src/') + '$1/index.ts' }
    ]
  },
  test: {
    // Integration tests share one Postgres container; run files sequentially
    // so state isolation stays deliberate (truncate helpers, not luck).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000 // first run pulls the pgvector image
  }
});
