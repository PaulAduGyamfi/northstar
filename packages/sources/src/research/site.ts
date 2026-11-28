import { isSharedDomain, normalizeDomain } from "@northstar/db";
import type { SitePage } from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type FetchDeps, FetchRefused, safeFetch } from "../fetch.js";
import { companySiteTerms } from "../terms.js";
import { htmlText } from "./html-text.js";

// The Research Service's site read (NS-283, #461): one company's own home page, from a domain
// Paul entered himself (`jobs domains`, NS-252), never one learned from a posting or mail. Its
// terms status is declared before anything is read (ADR-0003), its robots.txt is asked first, and
// both reads go through `safeFetch` (https, public addresses, 2 MB, 15 s). The page is untrusted
// text (NFR-SEC-004): it becomes plain text that the snapshot only quotes, verbatim, citing this
// page's URL, and nothing in it is followed, run or sent anywhere.

export type SiteRefusal =
  // Not a plain domain, or a shared one (freemail, hosting, a public suffix).
  | "invalid_domain"
  | "shared_domain"
  // Its declared terms forbid reading it, or it is an ATS host (read through its own API).
  | "terms"
  // robots.txt keeps everyone out of the home page, or couldn't be read (a 5xx: read as "no").
  | "robots_disallow"
  | "robots_unreadable"
  // The home page: not a 200, not HTML, redirected off the company's domain, or no text.
  | "http_error"
  | "not_html"
  | "off_domain"
  | "empty"
  // safeFetch refused it (a private address, too large, too many redirects), or it didn't answer.
  | "fetch_refused"
  | "unreachable";

export type SiteRead = { ok: true; page: SitePage } | { ok: false; reason: SiteRefusal };

// robots.txt is small; a larger one is read as unreadable.
const ROBOTS_MAX_BYTES = 64 * 1024;

// True unless robots.txt's group for every agent ("*") disallows the whole site ("/" or "/*").
// Northstar reads one page once, at Paul's request, so only a site-wide "keep out" applies.
export function robotsAllowsHome(robots: string): boolean {
  let agents: string[] = [];
  // Whether the last line read was a user-agent line (consecutive ones share a group).
  let inAgents = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      agents = inAgents ? [...agents, value] : [value];
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (field === "disallow" && agents.includes("*") && (value === "/" || value === "/*")) {
      return false;
    }
  }
  return true;
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export async function readCompanySite(deps: FetchDeps, rawDomain: string): Promise<SiteRead> {
  const tracer = trace.getTracer("@northstar/sources");
  return tracer.startActiveSpan("research.site_read", async (span) => {
    try {
      const result = await readSite(deps, rawDomain);
      // The outcome only: never the page's text or path.
      span.setAttribute("research.site.result", result.ok ? "read" : result.reason);
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).name });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function readSite(deps: FetchDeps, rawDomain: string): Promise<SiteRead> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { ok: false, reason: "invalid_domain" };
  if (isSharedDomain(domain)) return { ok: false, reason: "shared_domain" };
  const home = `https://${domain}/`;
  // Declared before any read.
  if (companySiteTerms(home).terms === "prohibited") return { ok: false, reason: "terms" };
  trace.getActiveSpan()?.setAttribute("server.address", domain);

  const robots = await fetched(() =>
    safeFetch(deps, `https://${domain}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES }),
  );
  if (!robots.ok) return robots;
  const r = robots.value;
  // No robots.txt (4xx) means no rules; a server error means we can't tell, so we don't read.
  if (r.status >= 500) return { ok: false, reason: "robots_unreadable" };
  if (r.status === 200 && !robotsAllowsHome(r.body)) {
    return { ok: false, reason: "robots_disallow" };
  }

  const page = await fetched(() => safeFetch(deps, home));
  if (!page.ok) return page;
  const p = page.value;
  // The page must end on the company's own domain: safeFetch follows redirects itself, so a page
  // that ended elsewhere was read but is dropped here, and nothing from it is ever quoted.
  if (!onDomain(new URL(p.url).hostname, domain)) return { ok: false, reason: "off_domain" };
  if (p.status !== 200) return { ok: false, reason: "http_error" };
  if (!/^\s*text\/html\b/i.test(p.contentType)) return { ok: false, reason: "not_html" };
  const text = htmlText(p.body);
  if (text === "") return { ok: false, reason: "empty" };
  return { ok: true, page: { url: p.url, text } };
}

type Got<T> = { ok: true; value: T } | { ok: false; reason: "fetch_refused" | "unreachable" };

// A fetch's refusal or failure as a reason: one site not answering never fails its caller.
async function fetched<T>(read: () => Promise<T>): Promise<Got<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, reason: error instanceof FetchRefused ? "fetch_refused" : "unreachable" };
  }
}
