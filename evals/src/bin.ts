import { fileURLToPath } from "node:url";
import { createAnthropicClient, loadLlmConfig } from "@northstar/llm";
import { main } from "./cli.js";
import { registry } from "./routes.js";

// Entry point for `pnpm --filter evals eval <route>`. The only place in evals that reads
// process.env, and only --live/--record use it (for the API key).
const exitCode = await main({
  argv: process.argv.slice(2),
  // Only the API key: the loaded .env.app (NS-235) also holds the app's database URL and other secrets this never needs.
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  registry,
  // dist/bin.js runs from evals/dist, so the eval folders are one level up.
  root: fileURLToPath(new URL("..", import.meta.url)),
  print: (line) => console.log(line),
  now: () => performance.now(),
  today: () => new Date().toISOString().slice(0, 10),
  liveClient: (env) => createAnthropicClient(loadLlmConfig(env)),
});
process.exitCode = exitCode;
