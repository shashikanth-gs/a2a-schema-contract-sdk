import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 5000,
    hookTimeout: 10000,
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 95,
        lines: 95,
        'src/core/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/{client,server,adapters}/**': {
          statements: 80,
          branches: 80,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
