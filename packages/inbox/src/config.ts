import { z } from "zod";

export type GoogleConfig = { clientId: string; clientSecret: string };

const Env = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
});

// The one place this package reads settings (ADR-0014). Entry points pass the environment in; app
// code never reads process.env. Errors name the setting, never its value.
export function loadGoogleConfig(env: Record<string, string | undefined>): GoogleConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`${missing} missing: create a Desktop OAuth client (see AGENTS.md)`);
  }
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret } =
    parsed.data;
  // The .env.example placeholder would only fail later at Google's consent page.
  if (clientId === "change-me" || clientSecret === "change-me") {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET is still the placeholder",
    );
  }
  return { clientId, clientSecret };
}
