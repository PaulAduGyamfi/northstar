// Job embeddings' settings (NS-129, ADR-0033): off unless JOB_EMBEDDINGS=on, and then only with a
// real OPENAI_API_KEY. The one place they are read; entry points pass their environment in, app
// code never reads process.env (AGENTS.md). Errors name a setting, never its value.

export type EmbedConfig = { enabled: false } | { enabled: true; apiKey: string };

// The placeholder .env.example ships with: it would only fail later as a 401 on every call.
const PLACEHOLDER = "change-me";

export function loadEmbedConfig(env: Record<string, string | undefined>): EmbedConfig {
  const flag = (env.JOB_EMBEDDINGS ?? "").trim();
  // Unset or off: nothing is ever sent, whatever the key says.
  if (flag === "" || flag === "off") return { enabled: false };
  if (flag !== "on") throw new Error("JOB_EMBEDDINGS must be on or off");
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  if (apiKey === "") throw new Error("JOB_EMBEDDINGS is on but OPENAI_API_KEY is missing");
  if (apiKey === PLACEHOLDER) throw new Error("OPENAI_API_KEY is still the placeholder");
  return { enabled: true, apiKey };
}
