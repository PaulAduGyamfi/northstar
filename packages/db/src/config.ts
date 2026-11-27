import { z } from "zod";

export type DbConfig = { databaseUrl: string };

const PostgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const Env = z.object({ DATABASE_URL: PostgresUrl });
const MigrationEnv = z.object({ DATABASE_MIGRATION_URL: PostgresUrl });

// Names the setting, never its value: a database URL carries a password. The hint covers the
// usual cause: a password character that ends the URL's password part (or, for #, starts a comment
// in Node's --env-file reader).
const badUrl = (name: string) =>
  new Error(
    `${name} is missing or is not a postgres:// URL (percent-encode # / ? @ % in the password)`,
  );

// The database owner's credentials (NS-235), and libpq's fallbacks that pg would use to fill in a
// password or user missing from DATABASE_URL. They belong only to compose and `db:migrate` (the
// root .env); in an app's environment they could let it connect as the owner and disable the
// append-only triggers that the northstar_app role can't. Apps load .env.app instead. This keeps
// them out of the process environment; it is not a file boundary (the app runs as Paul's user).
export const OWNER_SETTINGS = [
  "DATABASE_MIGRATION_URL",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "PGUSER",
  "PGPASSFILE",
] as const;

// The one place this package reads settings. Callers pass the environment in, so only the entry
// point (src/migrate.ts) touches process.env (AGENTS.md: one typed config module). Every app
// connects through here, so here is where an app refuses the owner's credentials.
export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
  const owner = OWNER_SETTINGS.find((name) => (env[name] ?? "") !== "");
  if (owner) {
    // Names the setting, never its value.
    throw new Error(
      `${owner} is set for an app: remove it from .env.app (and the shell). The owner's credentials belong only in .env, for compose and db:migrate`,
    );
  }
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw badUrl("DATABASE_URL");
  return { databaseUrl: parsed.data.DATABASE_URL };
}

// The owner's URL, for migrations only (NS-212): the app's DATABASE_URL connects as northstar_app,
// which can't create tables or grant. Read only by src/migrate.ts.
export function loadMigrationConfig(env: Record<string, string | undefined>): DbConfig {
  const parsed = MigrationEnv.safeParse(env);
  if (!parsed.success) throw badUrl("DATABASE_MIGRATION_URL");
  return { databaseUrl: parsed.data.DATABASE_MIGRATION_URL };
}
