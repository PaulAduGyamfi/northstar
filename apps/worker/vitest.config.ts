import { defineConfig } from "vitest/config";

// The sweep's dead-letter test uses @northstar/db's test database: the migrated PGlite
// snapshot is built once per run by its global setup (built to dist by `turbo run test`'s
// ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/dist/test/global-setup.js"],
    // Each database test's beforeEach opens a PGlite from that snapshot: 3.5-10 s on a busy CI
    // runner (8.6 s on main's run for NS-229), past the default 10 s hook limit. Only the setup
    // gets longer; every assertion is unchanged.
    hookTimeout: 30_000,
  },
});
