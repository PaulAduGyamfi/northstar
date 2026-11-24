import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.js";

// Any Drizzle Postgres database with our schema: node-postgres in the apps, PGlite in tests.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
