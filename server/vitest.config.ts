import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    /*
     * Cap the parallelism.
     *
     * Most files here stand up a real embedded Postgres (PGlite, compiled to
     * WebAssembly), and each instance costs real memory. Left unbounded,
     * vitest forks one worker per core and a developer machine that is also
     * running a browser and a dev server runs out - which surfaces as two
     * suites failing to *load* and forty tests skipped, rather than as
     * anything resembling a test failure.
     *
     * Four is comfortably faster than serial and survives a two-core CI
     * runner. Correctness of the suite should not depend on how much else the
     * machine happens to be doing.
     */
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
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
