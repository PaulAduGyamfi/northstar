import { createServer } from "node:http";
import { loadApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";

// Entry point for `pnpm --filter @northstar/api start`. The only place in this app that reads
// process.env. Listens on loopback only: Northstar is local first (NS-156, ADR-0018).
try {
  const config = loadApiConfig(process.env);
  const server = createServer(createApi({ config, sessions: createSessions(Date.now) }));
  server.listen(config.port, "127.0.0.1", () => {
    console.log(JSON.stringify({ level: "info", msg: "api listening", port: config.port }));
  });
} catch (error) {
  // Config errors name the setting, never its value (config.ts).
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(JSON.stringify({ level: "error", msg: "api did not start", reason: message }));
  process.exitCode = 1;
}
