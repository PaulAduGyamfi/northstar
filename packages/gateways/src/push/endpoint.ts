// Which push endpoints the sender may call (NS-193, ADR-0032 item 3). A subscription's endpoint
// comes from the browser, so the sender checks it against the push services Northstar knows
// before any request: a stored endpoint can never point the worker at an internal or other host.

// The push services of Chrome/Edge-on-Android (FCM), Firefox, Safari and Windows. A host must be
// one of these or under one (`web.push.apple.com`, `wns2-par02p.notify.windows.com`).
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
] as const;

// An endpoint is at most this long; real ones are a few hundred characters.
const MAX_ENDPOINT_LENGTH = 1024;

// The endpoint as a URL when the sender may call it, else null: https, the default port, no
// user info or fragment, and a host under a known push service (never an IP literal, which
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
  // `URL` lower-cases the host and turns a trailing-dot or IDN form into its canonical one.
  const host = url.hostname;
  const known = PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return known ? url : null;
}

export function endpointAllowed(endpoint: string): boolean {
  return allowedEndpoint(endpoint) !== null;
}
