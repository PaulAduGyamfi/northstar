import { isIP } from "node:net";
import { underDomain } from "../prefilter.js";

// Link safety for magic links (VER-004). A link from an email is untrusted text: it is opened
// only when it points at a host the window allows. Plain code, no fetch: the gateway resolves
// redirects itself and passes every hop to checkRedirectChain.

export type LinkRefusal =
  | "not_a_url"
  | "not_https"
  | "has_credentials"
  | "ip_host"
  | "non_default_port"
  | "host_not_allowed"
  | "unsafe_characters";

// On success, href is the URL as parsed and checked. Callers use it, never the raw text.
export type LinkCheck = { ok: true; href: string } | { ok: false; reason: LinkRefusal };

// A backslash, a space, or a control character (code points up to U+0020, and U+007F).
function hasUnsafeCharacter(url: string): boolean {
  for (const ch of url) {
    const c = ch.codePointAt(0) as number;
    if (ch === "\\" || c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function checkLink(url: string, allowedHosts: readonly string[]): LinkCheck {
  // WHATWG URL reads "\\" as "/" and drops tabs and newlines; other parsers don't. Text that
  // two parsers could read as two different hosts is refused outright.
  if (hasUnsafeCharacter(url)) return { ok: false, reason: "unsafe_characters" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "not_https" };
  // `https://myworkday.com@evil.example/` really goes to evil.example: refuse any userinfo.
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "has_credentials" };
  }
  // URL keeps IPv6 hosts in brackets; isIP wants them bare.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return { ok: false, reason: "ip_host" };
  // URL drops the default port (443), so any port left is a non-default one.
  if (parsed.port !== "") return { ok: false, reason: "non_default_port" };
  const allowed = allowedHosts.some((h) => underDomain(host, h.toLowerCase()));
  return allowed ? { ok: true, href: parsed.href } : { ok: false, reason: "host_not_allowed" };
}

// Every hop must pass, not just the last: a tracker in the middle still receives the token.
export function checkRedirectChain(
  urls: readonly string[],
  allowedHosts: readonly string[],
): LinkCheck {
  if (urls.length === 0) return { ok: false, reason: "not_a_url" };
  let last: LinkCheck = { ok: false, reason: "not_a_url" };
  for (const url of urls) {
    last = checkLink(url, allowedHosts);
    if (!last.ok) return last;
  }
  // The final hop is where the gateway ends up.
  return last;
}
