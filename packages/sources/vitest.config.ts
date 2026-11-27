import { defineConfig } from "vitest/config";

// Board polling's guard is tested on @northstar/db's test database (poll-guard.test.ts): the
// migrated PGlite snapshot is built once per run by its global setup (built to dist by
// `turbo run test`'s ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
    // Each database test's beforeEach opens a PGlite from that snapshot: past the default 10 s
    // hook limit on a busy CI runner (poll-guard timed out on #398's run). The same fix as
    // packages/funnel's, apps/worker's and apps/api's. Only the setup gets longer; every
    // assertion is unchanged.
    hookTimeout: 30_000,
  },
});
