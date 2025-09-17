import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    timeout: 30000,
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    reporters: ['verbose'],
    // Run tests sequentially to avoid conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});