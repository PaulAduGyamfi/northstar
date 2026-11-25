import { defineConfig } from "drizzle-kit";

// Used by `pnpm db:generate` only, which compares the schema with the committed migrations and
// needs no database. Migrations are applied by src/migrate.ts, which reads the typed config.
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/schema.ts",
    "./src/profile-schema.ts",
    "./src/story-schema.ts",
    "./src/funnel-schema.ts",
    "./src/fit-schema.ts",
    "./src/approval-schema.ts",
    "./src/answer-schema.ts",
    "./src/resilience-schema.ts",
    "./src/apply-schema.ts",
  ],
  out: "./migrations",
});
