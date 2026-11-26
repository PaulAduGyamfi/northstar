import { defineConfig } from "vitest/config";

// The sweep's dead-letter test uses @northstar/db's test database: the migrated PGlite
// snapshot is built once per run by its global setup (built to dist by `turbo run test`'s
// ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/dist/test/global-setup.js"],
  },
});
