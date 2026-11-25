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
  | "host_not_allowed";

export type LinkCheck = { ok: true } | { ok: false; reason: LinkRefusal };

export function checkLink(url: string, allowedHosts: readonly string[]): LinkCheck {
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
  return allowed ? { ok: true } : { ok: false, reason: "host_not_allowed" };
}

// Every hop must pass, not just the last: a tracker in the middle still receives the token.
export function checkRedirectChain(
  urls: readonly string[],
  allowedHosts: readonly string[],
): LinkCheck {
  if (urls.length === 0) return { ok: false, reason: "not_a_url" };
  for (const url of urls) {
    const check = checkLink(url, allowedHosts);
    if (!check.ok) return check;
  }
  return { ok: true };
}
