import { defineConfig } from "vitest/config";

// One test here (verification-store.test.ts) runs the inbox's stored catcher on @northstar/db's
// test database: the migrated PGlite snapshot is built once per run by its global setup (built to
// dist by `turbo run test`'s ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
    // Each database test's beforeEach opens a PGlite from that snapshot: past the default 10 s
    // hook limit on a busy CI runner (mail-link-step and verification-store timed out on #305's
    // run). The same fix as apps/worker's and apps/api's. Only the setup gets longer; every
    // assertion is unchanged.
    hookTimeout: 30_000,
  },
});
