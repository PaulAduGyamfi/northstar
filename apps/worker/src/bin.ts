import { main } from "./main.js";

// The worker process's entry point (NS-225): the only file that reads process.env, which it
// hands to the config loaders. `pnpm --filter @northstar/worker start` loads the apps' settings
// file, like the API.
try {
  await main(process.env);
} catch (error) {
  // Config errors name the setting, never its value (config.ts, packages/db's config). Only the
  // message: a stack could carry a connection string's parts.
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(JSON.stringify({ level: "error", msg: "worker stopped", reason: message }));
  process.exitCode = 1;
}
