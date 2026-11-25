import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { DbConfig } from "./config.js";
import type { Db } from "./db.js";
import * as profile from "./profile-schema.js";
import * as schema from "./schema.js";

// A real Postgres connection for entry points (CLIs, workers). Tests use PGlite instead.
export function connectDb(config: DbConfig): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle({ client: pool, schema: { ...schema, ...profile } }) as unknown as Db;
  return { db, close: () => pool.end() };
}
