import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The host of the chassis suite (test/suite): here, the minimal `things`
      // tool. The tool's CLI package aliases the same specifier to its own kit
      // and runs the same files a second time.
      { find: '@chassis-cli-test/host', replacement: at('./test/host/minimal-host.ts') },
      // This package's tests exercise its SOURCE, under the names its
      // consumers import (under the tool's CLI package these names resolve to
      // the built package): ONE loaded copy per run, which `context.ts` and
      // `stdin.ts` need, since their module-level WeakMaps are what keeps
      // `--json` off the sanitizer and stdin spent once.
      { find: /^@antasphere\/chassis-cli$/, replacement: at('./src/index.ts') },
      { find: /^@antasphere\/chassis-cli\/testing$/, replacement: at('./src/testing/index.ts') }
    ]
  },
  test: {
    include: ['test/**/*.test.ts']
  }
});
