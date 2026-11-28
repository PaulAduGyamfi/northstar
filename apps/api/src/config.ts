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
    "NORTHSTAR_WEB_ORIGIN must be an http(s) origin such as http://northstar.localhost:3100",
};

const Env = z.object({
  NORTHSTAR_SIGNIN_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  NORTHSTAR_API_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  // Its own *.localhost name, not 127.0.0.1: cookies are scoped by host, not port, so on
  // 127.0.0.1 the session cookie would reach every other local service (ADR-0018).
  NORTHSTAR_WEB_ORIGIN: z.string().regex(ORIGIN).default("http://northstar.localhost:3100"),
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

const ExtensionHash = z.string().regex(/^[0-9a-f]{64}$/);

// The extension token's SHA-256 (NS-128), or null to leave the extension off: unset or still
// change-me means every extension request is refused, so sign-in works without it.
export function loadExtensionTokenHash(env: Record<string, string | undefined>): string | null {
  const raw = env.NORTHSTAR_EXTENSION_TOKEN_SHA256;
  if (raw === undefined || raw === "" || raw === "change-me") return null;
  const parsed = ExtensionHash.safeParse(raw);
  if (!parsed.success) {
    // Name the setting, never its value.
    throw new Error(
      "NORTHSTAR_EXTENSION_TOKEN_SHA256 must be the SHA-256 of the extension token (64 lowercase hex), or change-me to leave the extension off",
    );
  }
  return parsed.data;
}

// A P-256 public point as base64url: 65 bytes starting 0x04, so "B" then 86 characters.
const PushPublicKey = z.string().regex(/^B[A-Za-z0-9_-]{86}$/);

// The VAPID public key the browser subscribes with (NS-193, ADR-0032), or null while push isn't
// set up (unset or a placeholder). The API never reads the private key: only the sender does.
export function loadPushPublicKey(env: Record<string, string | undefined>): string | null {
  const raw = env.PUSH_VAPID_PUBLIC_KEY?.trim();
  if (raw === undefined || raw === "" || raw.includes("change-me")) return null;
  const parsed = PushPublicKey.safeParse(raw);
  if (!parsed.success) {
    // Name the setting, never its value.
    throw new Error(
      "PUSH_VAPID_PUBLIC_KEY must be a P-256 public key in base64url (87 characters)",
    );
  }
  return parsed.data;
}
