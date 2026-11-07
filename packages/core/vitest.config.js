import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // vitest 5 spawns heavier per-file workers than 2.x; under full-suite load the thrash benchmark (a throughput
    // test with its own assertions) exceeded the 5 s default while passing alone. Timeout only; no assertion changed.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/fingerprint/**/*.js'],
      thresholds: {
        branches: 90,
      },
    },
  },
});
