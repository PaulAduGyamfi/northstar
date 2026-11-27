import { defineConfig } from "vitest/config";

// The Apply Gateway's database tests use @northstar/db's test database: the migrated PGlite
// snapshot is built once per run by its global setup (built to dist by `turbo run test`'s
// ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
    // Each database test's beforeEach opens a fresh PGlite copy of that snapshot. Under CI's
    // parallel turbo load that has taken over vitest's 10 s hook default in sweep-db, submit-db
    // and others (NS-258). This only gives setup hooks more time; no test or assertion changes.
    hookTimeout: 30_000,
  },
});
