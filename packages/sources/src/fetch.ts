import { isIP } from "node:net";

// Fetching a page Paul pasted (NS-114). The link is untrusted: it must not make Northstar read
// something on Paul's own network or the cloud metadata service (SSRF), and a huge or endless
// response must not hang the run. https only, public addresses only (checked again for every
// redirect), at most 5 redirects, 2 MB, 15 s.
//
// Known limit: the address check and the request each resolve DNS, so a host that changes its
// answer between the two (DNS rebinding) could slip through. Acceptable for a CLI Paul runs on
// links he chose; a server-side fetcher would pin the checked address.

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;

export type FetchDeps = {
  // All addresses a host name resolves to.
  resolve: (host: string) => Promise<string[]>;
  fetch: typeof fetch;
};

export type Fetched = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  redirects: number;
};

// A link Northstar won't fetch, with the reason in plain words (no page content).
export class FetchRefused extends Error {
  override name = "FetchRefused";
}

export async function safeFetch(deps: FetchDeps, start: string): Promise<Fetched> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = start;
  for (let redirects = 0; ; redirects++) {
    await checkTarget(deps, url);
    const res = await deps.fetch(url, {
      redirect: "manual",
      signal,
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS)
        throw new FetchRefused(`more than ${MAX_REDIRECTS} redirects`);
      // Relative locations resolve against the current URL.
      url = new URL(location, url).toString();
      continue;
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new FetchRefused("the page is larger than 2 MB");
    }
    return {
      url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: await readCapped(res),
      redirects,
    };
  }
}

async function checkTarget(deps: FetchDeps, raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused("not a valid link");
  }
  if (u.protocol !== "https:") throw new FetchRefused("only https links are fetched");
  // URL keeps IPv6 literals in brackets.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) throw new FetchRefused("links to an IP address are not fetched");
  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch {
    throw new FetchRefused(`${host} can't be found`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new FetchRefused(`${host} resolves to a private or local address`);
  }
}

// Reads the body as text, stopping (and refusing) once it passes MAX_BYTES, whatever the
// content-length said.
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FetchRefused("the page is larger than 2 MB");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Whether an address is on the public internet: not loopback, private, link-local (including the
// 169.254.169.254 metadata service), carrier-grade NAT, multicast, unspecified, unique-local, or
// an IPv4 address wrapped in IPv6.
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(address);
  if (kind !== 6) return false;
  const a = address.toLowerCase();
  // ::ffff:a.b.c.d and ::ffff:hhhh:hhhh carry an IPv4 address: judge that one.
  const mapped = /^::ffff:(.+)$/.exec(a)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return isPublicV4(mapped);
    const parts = mapped.split(":");
    if (parts.length === 2) {
      const hi = Number.parseInt(parts[0] ?? "", 16);
      const lo = Number.parseInt(parts[1] ?? "", 16);
      return isPublicV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  if (a === "::" || a === "::1") return false;
  const first = Number.parseInt(a.split(":")[0] || "0", 16);
  // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) {
    return false;
  }
  return true;
}

function isPublicV4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 224.0.0.0 and up: multicast and reserved.
  if (a >= 224) return false;
  return true;
}

// Parameters that only track where a click came from; dropping them makes two links to the same
// posting compare equal (SRC-006).
const TRACKING =
  /^(utm_.*|gh_src|lever-source|lever-origin|source|ref|refid|trk|trkinfo|src|ashby_jid_source|fbclid|gclid|mc_cid|mc_eid)$/i;

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}
