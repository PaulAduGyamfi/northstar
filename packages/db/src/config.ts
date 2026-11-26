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

// The one place this package reads settings. Callers pass the environment in, so only the entry
// point (src/migrate.ts) touches process.env (AGENTS.md: one typed config module).
export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
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
