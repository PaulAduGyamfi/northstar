// The extension's two settings, kept in chrome.storage.local (NS-128). The token is the
// extension's own, scoped to its endpoints (ADR-0018); it is never a site password.

export type Settings = { apiOrigin: string; token: string };

export const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";

// Loopback only: the manifest can reach nothing else, and the token must never leave the machine.
const LOCAL_API = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function checkSettings(
  s: Settings,
): { ok: true; settings: Settings } | { ok: false; message: string } {
  const apiOrigin = s.apiOrigin.trim();
  const token = s.token.trim();
  if (!LOCAL_API.test(apiOrigin)) {
    return { ok: false, message: "The API address must be http://127.0.0.1:<port>." };
  }
  if (token.length === 0) return { ok: false, message: "Paste the extension token first." };
  return { ok: true, settings: { apiOrigin, token } };
}
