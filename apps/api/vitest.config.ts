import { defineConfig } from "vitest/config";

// The approval queue's real-write-path test (NS-139) uses @northstar/db's test database: the
// migrated PGlite snapshot is built once per run by its global setup (built to dist by
// `turbo run test`'s ^build dependency), as in packages/gateways.
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/dist/test/global-setup.js"],
  },
});
