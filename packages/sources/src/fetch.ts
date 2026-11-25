import { BlockList, isIP } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { termsFor } from "./terms.js";

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

// One `source.fetch` span per fetch (OBV-001): the host, final status, bytes and redirect count.
// Never the path or query (they can carry ids from Paul's search) or any page content.
export async function safeFetch(deps: FetchDeps, start: string): Promise<Fetched> {
  const tracer = trace.getTracer("@northstar/sources");
  return tracer.startActiveSpan("source.fetch", async (span) => {
    try {
      span.setAttribute("server.address", hostOf(start));
      const r = await fetchHops(deps, start);
      span.setAttribute("http.response.status_code", r.status);
      span.setAttribute("source.bytes", Buffer.byteLength(r.body));
      span.setAttribute("source.redirects", r.redirects);
      return r;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).name });
      throw error;
    } finally {
      span.end();
    }
  });
}

const hostOf = (raw: string) => {
  try {
    return new URL(raw).hostname;
  } catch {
    return "invalid";
  }
};

async function fetchHops(deps: FetchDeps, start: string): Promise<Fetched> {
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
  // Checked on every hop, so a short link or a redirect can't land on a prohibited site (ADR-0003).
  if (termsFor(raw).terms === "prohibited") {
    throw new FetchRefused(`${u.hostname} doesn't allow automated reading`);
  }
  if (u.username || u.password)
    throw new FetchRefused("links with a user name or password are not fetched");
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

// Every address range that isn't the public internet, as Node's own BlockList: loopback,
// private, link-local (including the 169.254.169.254 metadata service), carrier-grade NAT,
// multicast and reserved space, plus the IPv6 forms that carry an IPv4 address (mapped, NAT64,
// 6to4, Teredo, IPv4-compatible), which are refused outright rather than unwrapped.
// Two lists: Node's BlockList also tests an IPv4 address against IPv6 rules (as ::ffff:a.b.c.d),
// so a single list holding ::ffff:0:0/96 would block every IPv4 address.
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NOT_PUBLIC_V4.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC_V6.addSubnet(net, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 0) return false;
  return kind === 4 ? !NOT_PUBLIC_V4.check(address, "ipv4") : !NOT_PUBLIC_V6.check(address, "ipv6");
}

// Parameters that only track where a click came from; dropping them makes two links to the same
// posting compare equal (SRC-006).
const TRACKING =
  /^(utm_.*|gh_src|lever-source|lever-origin|source|ref|refid|trk|trkinfo|src|ashby_jid_source|fbclid|gclid|mc_cid|mc_eid)$/i;

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  // A user name or password in a link is never part of a posting's identity.
  u.username = "";
  u.password = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}
