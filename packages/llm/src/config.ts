import { z } from "zod";

export type LlmConfig = { apiKey: string };

const Env = z.object({ ANTHROPIC_API_KEY: z.string().min(1) });

// The one place this package reads settings. Entry points pass the environment in; app code
// never reads process.env (AGENTS.md). Replay mode needs no config at all.
export function loadLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Name the setting, never its value.
    throw new Error("ANTHROPIC_API_KEY is missing");
  }
  // The .env.example placeholder would only fail later as 401s on every call.
  if (parsed.data.ANTHROPIC_API_KEY === "change-me") {
    throw new Error("ANTHROPIC_API_KEY is still the placeholder");
  }
  return { apiKey: parsed.data.ANTHROPIC_API_KEY };
}
