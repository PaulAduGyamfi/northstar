import { describe, expect, it } from "vitest";
import { fakeWeb } from "../test/fake-web.js";
import { readTitle } from "./feed.js";
import { BoardUnavailable, listBoard } from "./list.js";

// RSS, Atom and JSON Feed watches (NS-282 slice 2), on a fake web. Every company, link and posting
// is invented; no test calls the network.

const FEED = "https://jobs.example.com/feed.xml";
const board = { ats: "feed" as const, board: FEED };
// The poll's clock: every fixture date is before it, except the one future date.
const NOW = new Date("2026-11-28T12:00:00Z");

function served(body: string | object, contentType = "application/rss+xml") {
  return fakeWeb({ [FEED]: { body, contentType } }).deps;
}

const rss = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example jobs</title>${items}</channel></rss>`;

describe("listBoard for an RSS feed (NS-282 slice 2)", () => {
  it("turns an item into a job with its title, company, link, date and description", async () => {
    const deps = served(
      rss(`<item>
        <title>Globex: Senior Backend Engineer (Remote)</title>
        <link>https://jobs.example.com/postings/101?utm_source=rss</link>
        <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate>
        <description>&lt;p&gt;We build things &amp;amp; ship them.&lt;/p&gt;</description>
      </item>`),
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.url).toBe("https://jobs.example.com/postings/101");
    expect(p?.extraction).toMatchObject({ method: "text", ats: null, atsPostingId: null });
    expect(p?.extraction.fields).toMatchObject({
      company: "Globex",
      title: "Senior Backend Engineer (Remote)",
      remote: "remote",
      postedAt: new Date("2026-11-23T10:00:00Z"),
      description: "We build things & ship them.",
    });
  });

  it("prefers content:encoded, and reads CDATA as literal text", async () => {
    const deps = served(
      rss(`<item>
        <title>Data Scientist at Initech</title>
        <link>https://jobs.example.com/postings/102</link>
        <description>Short.</description>
        <content:encoded><![CDATA[<p>Long &amp; detailed.</p>]]></content:encoded>
      </item>`),
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.extraction.fields).toMatchObject({
      title: "Data Scientist",
      company: "Initech",
      description: "Long & detailed.",
    });
  });

  it("skips items with no link, a non-https link, or a link on a site whose terms forbid reads", async () => {
    const deps = served(
      rss(`
        <item><title>Engineer at A Corp</title></item>
        <item><title>Engineer at B Corp</title><link>http://jobs.example.com/postings/1</link></item>
        <item><title>Engineer at C Corp</title><link>https://www.linkedin.com/jobs/view/1</link></item>
        <item><title>Engineer at D Corp</title><link>not a url</link></item>
        <item><title>Engineer at F Corp</title><link>https://www.workatastartup.com/jobs/6</link></item>
        <item><title>Engineer at E Corp</title><link>https://jobs.example.com/postings/5</link></item>`),
    );
    const postings = await listBoard(deps, board, NOW);
    expect(postings.map((p) => p.url)).toEqual(["https://jobs.example.com/postings/5"]);
  });

  it("never stores a bidi override or control character, however the feed escapes it", async () => {
    const deps = served(
      rss(`<item>
        <title>Glo&#x202E;bex: Backend&amp;#x200B; Engineer</title>
        <link>https://jobs.example.com/postings/103</link>
        <description>About&amp;#x202E;us&#7;</description>
      </item>`),
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.extraction.fields).toMatchObject({
      company: "Globex",
      title: "Backend Engineer",
      description: "Aboutus",
    });
  });

  it("gives a date in the future no posted date, so it can't stay fresh", async () => {
    const deps = served(
      rss(`<item><title>Engineer at Globex</title><link>https://jobs.example.com/p/1</link>
        <pubDate>Mon, 01 Jan 2029 00:00:00 GMT</pubDate></item>`),
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.extraction.fields.postedAt).toBeNull();
  });

  it("gives an impossible date no posted date", async () => {
    const deps = served(
      rss(`<item><title>Engineer at Globex</title><link>https://jobs.example.com/p/1</link>
        <pubDate>Fri, 01 Jan 2300 00:00:00 GMT</pubDate></item>`),
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.extraction.fields.postedAt).toBeNull();
  });
});

describe("listBoard for an Atom feed (NS-282 slice 2)", () => {
  it("reads each entry's alternate link, title, date and content", async () => {
    const deps = served(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Jobs</title>
        <entry>
          <title type="text">Product Designer at Hooli</title>
          <link rel="self" href="https://jobs.example.com/api/entries/7"/>
          <link rel="alternate" href="https://jobs.example.com/postings/7?a=1&amp;b=2"/>
          <published>2026-11-20T09:30:00Z</published>
          <updated>2026-11-22T09:30:00Z</updated>
          <content type="html">&lt;b&gt;Design&lt;/b&gt; with us.</content>
        </entry>
      </feed>`,
      "application/atom+xml",
    );
    const [p] = await listBoard(deps, board, NOW);
    expect(p?.url).toBe("https://jobs.example.com/postings/7?a=1&b=2");
    expect(p?.extraction.fields).toMatchObject({
      title: "Product Designer",
      company: "Hooli",
      postedAt: new Date("2026-11-20T09:30:00Z"),
      description: "Design with us.",
    });
  });
});

describe("listBoard for a JSON Feed (NS-282 slice 2)", () => {
  it("reads each item's url, title, date and plain or HTML content", async () => {
    const deps = served(
      {
        version: "https://jsonfeed.org/version/1.1",
        title: "Jobs",
        items: [
          {
            id: "1",
            url: "https://jobs.example.com/postings/201",
            title: "Umbrella: Site Reliability Engineer",
            date_published: "2026-11-21T08:00:00Z",
            content_text: "Keep it running.\nOn call one week in six.",
          },
          {
            id: "2",
            url: "https://jobs.example.com/postings/202",
            title: "We're hiring!",
            content_html: "<p>Many roles.</p>",
          },
        ],
      },
      "application/feed+json",
    );
    const postings = await listBoard(deps, board, NOW);
    expect(postings.map((p) => p.extraction.fields)).toMatchObject([
      {
        company: "Umbrella",
        title: "Site Reliability Engineer",
        postedAt: new Date("2026-11-21T08:00:00Z"),
        description: "Keep it running.\nOn call one week in six.",
      },
      { company: null, title: null, description: "Many roles." },
    ]);
  });

  it("says the feed is unavailable for JSON that isn't a JSON Feed", async () => {
    await expect(listBoard(served({ items: [] }), board, NOW)).rejects.toBeInstanceOf(
      BoardUnavailable,
    );
  });
});

describe("listBoard refuses a feed it can't read safely (NS-282 slice 2)", () => {
  it("refuses a feed that declares a DOCTYPE, so no entity it defines is ever expanded", async () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;">]><rss><channel><item><title>&b;</title><link>https://jobs.example.com/p/1</link></item></channel></rss>`;
    await expect(listBoard(served(laughs), board, NOW)).rejects.toThrow("declares a DOCTYPE");
  });

  it("says the feed is unavailable for HTML, plain text or XML with no items", async () => {
    for (const body of ["<html><body>Jobs</body></html>", "jobs!", "<rss><channel/></rss>"]) {
      await expect(listBoard(served(body, "text/html"), board, NOW)).rejects.toBeInstanceOf(
        BoardUnavailable,
      );
    }
  });

  it("says the feed is unavailable when it answers with an error", async () => {
    const { deps } = fakeWeb({ [FEED]: { status: 500, body: "down" } });
    await expect(listBoard(deps, board, NOW)).rejects.toThrow("the feed answered 500");
  });

  it("refuses a feed that redirects to a site whose terms forbid automated reads", async () => {
    const { deps } = fakeWeb({
      [FEED]: { status: 301, location: "https://www.linkedin.com/jobs/feed" },
      "https://www.linkedin.com/jobs/feed": { body: rss("") },
    });
    await expect(listBoard(deps, board, NOW)).rejects.toThrow(
      "www.linkedin.com doesn't allow automated reading",
    );
  });
});

describe("readTitle (NS-282 slice 2)", () => {
  it("reads 'Role at Company' and 'Company: Role'", () => {
    expect([readTitle("Staff Engineer at Acme"), readTitle("Acme: Staff Engineer")]).toEqual([
      { title: "Staff Engineer", company: "Acme" },
      { title: "Staff Engineer", company: "Acme" },
    ]);
  });

  it("guesses no company when both forms fit the title", () => {
    expect(readTitle("Globex: Engineer at Night")).toEqual({
      title: "Globex: Engineer at Night",
      company: null,
    });
  });

  it("keeps a title naming a role with no company, and guesses nothing else", () => {
    expect([
      readTitle("Staff Engineer"),
      readTitle("Acme is hiring"),
      readTitle("Engineer at Engineering Manager"),
      readTitle("Engineer at https://acme.example.com"),
    ]).toEqual([
      { title: "Staff Engineer", company: null },
      { title: null, company: null },
      { title: "Engineer at Engineering Manager", company: null },
      { title: null, company: null },
    ]);
  });
});
