import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { loadMigrationConfig } from "./config.js";

// `pnpm --filter @northstar/db db:migrate`: applies every pending migration as the tables' owner,
// DATABASE_MIGRATION_URL (NS-212). The app connects as northstar_app (DATABASE_URL) instead.
// Runs from dist/, so the committed migrations are one folder up.
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

const config = loadMigrationConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  // Drizzle applies all pending migrations in one transaction: on failure, none of them stick.
  await migrate(drizzle({ client: pool }), { migrationsFolder });
  console.log(JSON.stringify({ level: "info", msg: "migrations applied" }));
} finally {
  await pool.end();
}
