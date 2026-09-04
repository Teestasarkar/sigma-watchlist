import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    /*
     * Generous, because the password tests are *meant* to be slow.
     *
     * scrypt at the OWASP cost is ~100ms and ~64MB per hash, and the hashing
     * gate deliberately caps concurrency at two - so when the auth and
     * password suites run in parallel they queue behind each other. Lowering
     * the cost for tests would make them fast and stop them testing the thing
     * that matters.
     */
    testTimeout: 45_000,
    hookTimeout: 180_000,
  },
});
