import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/testing/loadEnv.ts'],
    // Database tests share one cluster; run files serially so they cannot interleave.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
