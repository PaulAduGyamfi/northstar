import { z } from "zod";

export type ApiConfig = {
  // SHA-256 (hex) of Paul's sign-in key. The key itself is never stored anywhere.
  signinKeySha256: string;
  port: number;
  // The web app's origin: the only Origin a POST may come from.
  webOrigin: string;
};

// An origin as a browser sends it: scheme, host, optional port, nothing after.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

const MESSAGES: Record<string, string> = {
  NORTHSTAR_SIGNIN_KEY_SHA256:
    "NORTHSTAR_SIGNIN_KEY_SHA256 must be the SHA-256 of your sign-in key (64 lowercase hex)",
  NORTHSTAR_API_PORT: "NORTHSTAR_API_PORT must be a port from 1024 to 65535",
  NORTHSTAR_WEB_ORIGIN:
    "NORTHSTAR_WEB_ORIGIN must be an http(s) origin such as http://127.0.0.1:3100",
};

const Env = z.object({
  NORTHSTAR_SIGNIN_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  NORTHSTAR_API_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  NORTHSTAR_WEB_ORIGIN: z.string().regex(ORIGIN).default("http://127.0.0.1:3100"),
});

// The one place the API reads settings. Callers pass the environment in, so only bin.ts touches
// process.env (AGENTS.md: one typed config module).
export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Name the setting, never its value.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(names.map((n) => MESSAGES[n] ?? `${n} is invalid`).join("; "));
  }
  return {
    signinKeySha256: parsed.data.NORTHSTAR_SIGNIN_KEY_SHA256,
    port: parsed.data.NORTHSTAR_API_PORT,
    webOrigin: parsed.data.NORTHSTAR_WEB_ORIGIN,
  };
}
