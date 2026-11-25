import { defineConfig } from "vitest/config";

// The migrated test database is built once per run, before any test (src/test/global-setup.ts).
export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
  },
});
