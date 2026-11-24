import { z } from "zod";

export type DbConfig = { databaseUrl: string };

const Env = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

// The one place this package reads settings. Callers pass the environment in, so only the entry
// point (src/migrate.ts) touches process.env (AGENTS.md: one typed config module).
export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Name the setting, never its value: a database URL carries a password. The hint covers the
    // usual cause: a password character that ends the URL's password part (or, for #, starts a
    // comment in Node's --env-file reader).
    throw new Error(
      "DATABASE_URL is missing or is not a postgres:// URL (percent-encode # / ? @ % in the password)",
    );
  }
  return { databaseUrl: parsed.data.DATABASE_URL };
}
