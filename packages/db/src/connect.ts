import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { DbConfig } from "./config.js";
import type { Db } from "./db.js";
import * as profile from "./profile-schema.js";
import * as schema from "./schema.js";

// Limits on every connection (RES-005, NS-176): a database that doesn't answer fails the command
// instead of hanging it. Migrations (migrate.ts) use their own pool, without the statement limit.
export const CONNECT_TIMEOUT_MS = 10_000;
export const STATEMENT_TIMEOUT_MS = 60_000;

export function poolOptions(config: DbConfig): pg.PoolConfig {
  return {
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Postgres cancels a statement past this; the client also stops waiting a little later.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 5_000,
  };
}

// A real Postgres connection for entry points (CLIs, workers). Tests use PGlite instead.
export function connectDb(config: DbConfig): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool(poolOptions(config));
  const db = drizzle({ client: pool, schema: { ...schema, ...profile } }) as unknown as Db;
  return { db, close: () => pool.end() };
}
