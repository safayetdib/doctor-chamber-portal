import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
