import { defineConfig } from "vitest/config";

// The approval queue's real-write-path test (NS-139) uses @northstar/db's test database: the
// migrated PGlite snapshot is built once per run by its global setup (built to dist by
// `turbo run test`'s ^build dependency), as in packages/gateways.
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/dist/test/global-setup.js"],
    // Each database test's beforeEach opens a PGlite from that snapshot: past the default 10 s
    // hook limit on a busy CI runner (vault-reveal.test.ts timed out on main's run for #296 and
    // on #300's). The same fix as apps/worker's (NS-227 slice 2). Only the setup gets longer;
    // every assertion is unchanged.
    hookTimeout: 30_000,
  },
});
