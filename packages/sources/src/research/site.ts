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

// robots.txt is small; safeFetch refuses a larger one, and the read stops (`fetch_refused`).
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

// Why one host's robots.txt stops the read, or null when it allows the home page. No robots.txt
// (any other 4xx) means no rules; a server error or a 429 means we can't tell, so we don't read. A robots.txt that
// redirected to another host is that host's rules, not this one's: read as no rules.
async function robotsBlock(
  deps: FetchDeps,
  host: string,
): Promise<"robots_disallow" | "robots_unreadable" | "fetch_refused" | "unreachable" | null> {
  const url = `https://${host}/robots.txt`;
  const robots = await fetched(() => safeFetch(deps, url, { maxBytes: ROBOTS_MAX_BYTES }));
  if (!robots.ok) return robots.reason;
  const r = robots.value;
  if (new URL(r.url).hostname !== host) return null;
  // A 429 is a busy server, not "no robots.txt": like a 5xx, we can't tell.
  if (r.status >= 500 || r.status === 429) return "robots_unreadable";
  if (r.status === 200 && !robotsAllowsHome(r.body)) return "robots_disallow";
  return null;
}

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

  const blocked = await robotsBlock(deps, domain);
  if (blocked) return { ok: false, reason: blocked };

  const page = await fetched(() => safeFetch(deps, home));
  if (!page.ok) return page;
  const p = page.value;
  // The page must end on the company's own domain or its www name: safeFetch follows redirects
  // itself, so a page that ended elsewhere (another site, or another subdomain whose robots.txt
  // was never asked) was read but is dropped here, and nothing from it is ever quoted.
  const host = new URL(p.url).hostname;
  if (host !== domain && host !== `www.${domain}`) return { ok: false, reason: "off_domain" };
  // A page served by the www name answers to that host's own robots.txt too.
  if (host !== domain) {
    const wwwBlocked = await robotsBlock(deps, host);
    if (wwwBlocked) return { ok: false, reason: wwwBlocked };
  }
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
