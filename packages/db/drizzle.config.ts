import { defineConfig } from "drizzle-kit";

// Used by `pnpm db:generate` only, which compares the schema with the committed migrations and
// needs no database. Migrations are applied by src/migrate.ts, which reads the typed config.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/profile-schema.ts"],
  out: "./migrations",
});
