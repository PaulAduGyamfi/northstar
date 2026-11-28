import { defineConfig } from "vitest/config";

// The voice store's, independent work's and reply filing's tests use @northstar/db's test
// database: the migrated PGlite snapshot is built once per run by its global setup (built to dist
// by `turbo run test`'s ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
    // A database test file opens a PGlite copy of that snapshot in a setup hook. Under CI's
    // parallel turbo load that has taken over vitest's 10 s hook default (nudge.test.ts on #467
    // and #473; NS-287), as it did in packages/gateways (NS-258). The same 30 s budget as db's
    // other dependents; only setup hooks get more time, no test or assertion changes.
    hookTimeout: 30_000,
  },
});
