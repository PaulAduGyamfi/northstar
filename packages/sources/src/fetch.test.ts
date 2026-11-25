import { describe, expect, it } from "vitest";
import { canonicalUrl, FetchRefused, isPublicAddress, safeFetch } from "./fetch.js";

// A fake DNS and web: every host and page here is invented (the repo is public).
const DNS: Record<string, string[]> = {
  "jobs.example.com": ["93.184.216.34"],
  "careers.example.com": ["93.184.216.35"],
  "internal.example.com": ["10.0.0.5"],
  "mixed.example.com": ["93.184.216.36", "127.0.0.1"],
};
type Page = { status: number; body?: string; location?: string; contentLength?: string };

function web(pages: Record<string, Page>) {
  const asked: string[] = [];
  const deps = {
    resolve: async (host: string) => {
      const addrs = DNS[host];
      if (!addrs) throw new Error("ENOTFOUND");
      return addrs;
    },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const p = pages[url];
      if (!p) return new Response("not found", { status: 404 });
      const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
      if (p.location) headers.set("location", p.location);
      if (p.contentLength) headers.set("content-length", p.contentLength);
      return new Response(p.body ?? "", { status: p.status, headers });
    }) as typeof fetch,
  };
  return { deps, asked };
}

describe("safeFetch", () => {
  it("returns the page body, status and final URL", async () => {
    const { deps } = web({ "https://jobs.example.com/1": { status: 200, body: "<h1>Job</h1>" } });
    expect(await safeFetch(deps, "https://jobs.example.com/1")).toEqual({
      url: "https://jobs.example.com/1",
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<h1>Job</h1>",
      redirects: 0,
    });
  });

  it("refuses plain http", async () => {
    const { deps, asked } = web({});
    await expect(safeFetch(deps, "http://jobs.example.com/1")).rejects.toThrow(
      new FetchRefused("only https links are fetched"),
    );
    expect(asked).toEqual([]);
  });

  it("refuses a host that resolves to a private address, before any request", async () => {
    const { deps, asked } = web({});
    await expect(safeFetch(deps, "https://internal.example.com/")).rejects.toThrow(
      new FetchRefused("internal.example.com resolves to a private or local address"),
    );
    expect(asked).toEqual([]);
  });

  it("refuses a host with any private address among its answers", async () => {
    const { deps } = web({});
    await expect(safeFetch(deps, "https://mixed.example.com/")).rejects.toThrow(FetchRefused);
  });

  it("refuses an IP literal in the URL", async () => {
    const { deps } = web({});
    await expect(safeFetch(deps, "https://127.0.0.1/")).rejects.toThrow(
      new FetchRefused("links to an IP address are not fetched"),
    );
    await expect(safeFetch(deps, "https://[::1]/")).rejects.toThrow(FetchRefused);
  });

  it("follows a redirect and checks the new host too", async () => {
    const { deps, asked } = web({
      "https://jobs.example.com/a": { status: 302, location: "https://careers.example.com/b" },
      "https://careers.example.com/b": { status: 200, body: "ok" },
      "https://jobs.example.com/evil": {
        status: 301,
        location: "https://internal.example.com/admin",
      },
    });
    expect((await safeFetch(deps, "https://jobs.example.com/a")).url).toBe(
      "https://careers.example.com/b",
    );
    await expect(safeFetch(deps, "https://jobs.example.com/evil")).rejects.toThrow(
      new FetchRefused("internal.example.com resolves to a private or local address"),
    );
    expect(asked).not.toContain("https://internal.example.com/admin");
  });

  it("refuses a redirect that lands on a prohibited site, without requesting it", async () => {
    const { deps, asked } = web({
      "https://jobs.example.com/short": {
        status: 302,
        location: "https://www.linkedin.com/jobs/view/1",
      },
    });
    await expect(safeFetch(deps, "https://jobs.example.com/short")).rejects.toThrow(
      new FetchRefused("www.linkedin.com doesn't allow automated reading"),
    );
    expect(asked).toEqual(["https://jobs.example.com/short"]);
  });

  it("refuses a link with a user name or password in it", async () => {
    const { deps, asked } = web({});
    await expect(safeFetch(deps, "https://user:secret@jobs.example.com/1")).rejects.toThrow(
      new FetchRefused("links with a user name or password are not fetched"),
    );
    expect(asked).toEqual([]);
  });

  it("stops after 5 redirects", async () => {
    const pages: Record<string, Page> = {};
    for (let i = 0; i < 7; i++) {
      pages[`https://jobs.example.com/${i}`] = { status: 302, location: `/${i + 1}` };
    }
    await expect(safeFetch(web(pages).deps, "https://jobs.example.com/0")).rejects.toThrow(
      new FetchRefused("more than 5 redirects"),
    );
  });

  it("refuses a body over 2 MB, by header or by actual size", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const { deps } = web({
      "https://jobs.example.com/declared": { status: 200, contentLength: String(3 * 1024 * 1024) },
      "https://jobs.example.com/actual": { status: 200, body: big },
    });
    await expect(safeFetch(deps, "https://jobs.example.com/declared")).rejects.toThrow(
      new FetchRefused("the page is larger than 2 MB"),
    );
    await expect(safeFetch(deps, "https://jobs.example.com/actual")).rejects.toThrow(
      new FetchRefused("the page is larger than 2 MB"),
    );
  });

  it("returns a non-200 status for the caller to report", async () => {
    const { deps } = web({});
    expect((await safeFetch(deps, "https://jobs.example.com/missing")).status).toBe(404);
  });
});

describe("isPublicAddress", () => {
  it("rejects loopback, private, link-local, CGNAT, unique-local and mapped addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("rejects the IPv6 forms that carry an IPv4 address: NAT64, 6to4, Teredo, IPv4-compatible", () => {
    for (const a of [
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "2002:7f00:1::",
      "2001::1",
      "::7f00:1",
      "fec0::1",
      "100::1",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("accepts ordinary public addresses", () => {
    for (const a of ["93.184.216.34", "172.32.0.1", "2606:2800:220:1::1"]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });
});

describe("canonicalUrl", () => {
  it("drops tracking parameters, the fragment and a trailing slash, and lowercases the host", () => {
    expect(
      canonicalUrl(
        "https://Jobs.Example.com/globex/jobs/1/?gh_src=abc&utm_source=x&lever-source=y#apply",
      ),
    ).toBe("https://jobs.example.com/globex/jobs/1");
  });

  it("keeps parameters that identify the posting", () => {
    expect(canonicalUrl("https://jobs.example.com/view?gh_jid=123&utm_medium=email")).toBe(
      "https://jobs.example.com/view?gh_jid=123",
    );
  });
});
