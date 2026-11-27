import type { FetchDeps } from "../fetch.js";

// A fake internet for tests: every host resolves to a public documentation address unless listed
// as private, and pages are served from a map. Synthetic content only; never the real network.
export type Page = {
  status?: number;
  body?: string | object;
  contentType?: string;
  location?: string;
  contentLength?: string;
};

export function fakeWeb(pages: Record<string, Page>, privateHosts: string[] = []) {
  const asked: string[] = [];
  // Each request's method and body, for the board reads that POST (NS-260).
  const sent: { url: string; method: string; body: string | null }[] = [];
  const deps: FetchDeps = {
    resolve: async (host) => (privateHosts.includes(host) ? ["10.0.0.5"] : ["93.184.216.34"]),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      sent.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      const p = pages[url];
      if (!p) return new Response("not found", { status: 404 });
      const json = typeof p.body === "object";
      const headers = new Headers({
        "content-type": p.contentType ?? (json ? "application/json" : "text/html; charset=utf-8"),
      });
      if (p.location) headers.set("location", p.location);
      if (p.contentLength) headers.set("content-length", p.contentLength);
      const body = json ? JSON.stringify(p.body) : (p.body as string | undefined);
      return new Response(body ?? "", { status: p.status ?? 200, headers });
    }) as typeof fetch,
  };
  return { deps, asked, sent };
}
