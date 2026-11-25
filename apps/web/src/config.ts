import { z } from "zod";

export type WebConfig = {
  // Where the API listens. The browser never calls it directly: Next rewrites /api/* to it, and
  // server code asks it who is signed in.
  apiOrigin: string;
};

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

const Env = z.object({
  NORTHSTAR_API_ORIGIN: z.string().regex(ORIGIN).default("http://127.0.0.1:8787"),
});

// The one place the web app reads settings (AGENTS.md: one typed config module). It holds no
// secret: the web app only forwards Paul's session cookie to the API.
export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error("NORTHSTAR_API_ORIGIN must be an http(s) origin such as http://127.0.0.1:8787");
  }
  return { apiOrigin: parsed.data.NORTHSTAR_API_ORIGIN };
}

// The settings from this process's environment, for server code and next.config.ts.
export const webConfig = (): WebConfig => loadWebConfig(process.env);
