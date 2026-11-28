// Which push endpoints the sender may call (NS-193, ADR-0032 item 3). A subscription's endpoint
// comes from the browser, so the sender checks it against the push services Northstar knows
// before any request: a stored endpoint can never point the worker at an internal or other host.
// In packages/domain since slice 2, so the API and the database write path check the same rule.

// The push services of Chrome/Edge (FCM), Firefox, Safari and Windows. FCM, Mozilla and Apple
// are matched exactly; Windows hands out per-region hosts, so only subdomains of its name count
// (`wns2-par02p.notify.windows.com`), never the bare name.
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;
export const PUSH_SERVICE_SUFFIXES = [".notify.windows.com"] as const;

// An endpoint is at most this long; real ones are a few hundred characters.
const MAX_ENDPOINT_LENGTH = 1024;

// The endpoint as a URL when the sender may call it, else null: https, the default port, no
// user info or fragment, and a known push service's host (never an IP literal, which
// `URL` keeps in brackets or as dotted digits, neither of which can end with these names).
export function allowedEndpoint(endpoint: string): URL | null {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // `URL` drops the default port, so any port left is a non-default one.
  if (url.port !== "") return null;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  // `URL` lower-cases the host and punycodes an IDN; it keeps a trailing dot, so
  // `fcm.googleapis.com.` matches nothing below and is refused.
  const host = url.hostname;
  const known =
    (PUSH_SERVICE_HOSTS as readonly string[]).includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return known ? url : null;
}

export function endpointAllowed(endpoint: string): boolean {
  return allowedEndpoint(endpoint) !== null;
}
