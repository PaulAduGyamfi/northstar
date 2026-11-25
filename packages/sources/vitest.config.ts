import { defineConfig } from "vitest/config";

// Board polling's guard is tested on @northstar/db's test database (poll-guard.test.ts): the
// migrated PGlite snapshot is built once per run by its global setup (built to dist by
// `turbo run test`'s ^build dependency).
export default defineConfig({
  test: {
    globalSetup: ["../db/dist/test/global-setup.js"],
  },
});
