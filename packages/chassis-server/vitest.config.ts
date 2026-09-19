import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres container; run files sequentially
    // so state isolation stays deliberate (truncate helpers, not luck).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000 // first run pulls the pgvector image
  }
});
