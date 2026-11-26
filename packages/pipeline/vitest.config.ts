import { defineConfig } from "vitest/config";

// The pipeline's filing test uses @northstar/db's test database: the migrated PGlite
// snapshot is built once per run by its global setup (built to dist by `turbo run test`'s
// ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
  },
});
