import { describe, expect, it } from "vitest";
import { termsFor } from "../terms.js";
import { fakeWeb } from "../test/fake-web.js";
import { detectBoard } from "./detect.js";
import { readHead } from "./hn.js";
import { BoardUnavailable, listBoard } from "./list.js";

// The HN "Who is hiring?" thread (NS-282 slice 1), on a fake web shaped like HN's Algolia API.
// Every company, person and id is invented; no test calls the network.

const SEARCH =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20";
const ITEM = (id: string) => `https://hn.algolia.com/api/v1/items/${id}`;
const NOV = 1_764_547_200; // 2025-12-01T00:00:00Z, the thread's own time.

const search = {
  hits: [
    {
      objectID: "900000001",
      title: "Ask HN: Who wants to be hired? (December 2025)",
      created_at_i: NOV + 10,
    },
    { objectID: "900000002", title: "Ask HN: Who is hiring? (December 2025)", created_at_i: NOV },
    {
      objectID: "800000002",
      title: "Ask HN: Who is hiring? (November 2025)",
      created_at_i: NOV - 2_592_000,
    },
  ],
};

const comment = (id: number, text: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "comment",
  author: "someone",
  text,
  created_at_i: NOV + 3600,
  children: [{ id: id + 1, type: "comment", author: "replier", text: "Is this still open?" }],
  ...extra,
});

function web(children: unknown[]) {
  return fakeWeb({
    [SEARCH]: { body: search },
    [ITEM("900000002")]: { body: { id: 900000002, children } },
  });
}

describe("detectBoard and termsFor for HN (NS-282)", () => {
  it("takes the whoishiring account's page as the hn_hiring watch, and nothing else on HN", () => {
    expect(detectBoard("https://news.ycombinator.com/submitted?id=whoishiring")).toEqual({
      ats: "hn_hiring",
      board: "whoishiring",
      url: "https://news.ycombinator.com/submitted?id=whoishiring",
    });
    expect(
      [
        "https://news.ycombinator.com/item?id=900000002",
        "https://news.ycombinator.com/submitted?id=someoneelse",
        "https://news.ycombinator.com/submitted?id=whoishiring&p=2",
        "http://news.ycombinator.com/submitted?id=whoishiring",
        "https://news.ycombinator.com/",
      ].map(detectBoard),
    ).toEqual([null, null, null, null, null]);
  });

  it("calls HN's Algolia search API an official API", () => {
    expect(termsFor(SEARCH)).toEqual({ source: "hn", terms: "official-api" });
  });
});

describe("listBoard for hn_hiring (NS-282)", () => {
  it("reads the newest Who is hiring? thread, not the hired or older threads", async () => {
    const { deps } = web([comment(1001, "Globex | Backend Engineer | Remote (US)")]);
    const postings = await listBoard(deps, { ats: "hn_hiring", board: "whoishiring" });
    expect(postings.map((p) => p.url)).toEqual(["https://news.ycombinator.com/item?id=1001"]);
  });

  it("turns a comment that follows the convention into a job with its fields", async () => {
    const { deps } = web([
      comment(
        1001,
        "Globex Corp | Senior Backend Engineer | Berlin, Germany | ONSITE | Full-time | $150k<p>We build things.<p>Apply at https://globex.example.com/jobs",
      ),
    ]);
    const [p] = await listBoard(deps, { ats: "hn_hiring", board: "whoishiring" });
    expect(p?.extraction).toMatchObject({ method: "text", ats: null, atsPostingId: null });
    expect(p?.extraction.fields).toMatchObject({
      company: "Globex Corp",
      title: "Senior Backend Engineer",
      location: "Berlin, Germany",
      remote: "onsite",
      postedAt: new Date((NOV + 3600) * 1000),
    });
    expect(p?.extraction.fields.description).toContain("We build things.");
  });

  it("keeps a comment that doesn't follow the convention as a draft, with no title or company", async () => {
    const { deps } = web([comment(1001, "We're hiring engineers in many places, email me!")]);
    const [p] = await listBoard(deps, { ats: "hn_hiring", board: "whoishiring" });
    expect([p?.extraction.fields.title, p?.extraction.fields.company]).toEqual([null, null]);
    expect(p?.extraction.fields.description).toBe(
      "We're hiring engineers in many places, email me!",
    );
  });

  it("skips deleted, dead and authorless comments, and never reads replies", async () => {
    const { deps } = web([
      comment(1001, null),
      comment(1003, "Initech | Data Scientist | Remote", { author: null }),
      comment(1005, "Hooli | Product Designer | Remote", { type: "story" }),
      { id: "not-a-number" },
      comment(1007, "Umbrella | Site Reliability Engineer | Remote"),
    ]);
    const postings = await listBoard(deps, { ats: "hn_hiring", board: "whoishiring" });
    expect(postings.map((p) => p.url)).toEqual(["https://news.ycombinator.com/item?id=1007"]);
  });

  it("says the board is unavailable when no Who is hiring? thread is listed", async () => {
    const { deps } = fakeWeb({ [SEARCH]: { body: { hits: [] } } });
    await expect(
      listBoard(deps, { ats: "hn_hiring", board: "whoishiring" }),
    ).rejects.toBeInstanceOf(BoardUnavailable);
  });

  it("says the board is unavailable for a reply of the wrong shape, guessing nothing", async () => {
    const { deps } = fakeWeb({ [SEARCH]: { body: { results: "nope" } } });
    await expect(
      listBoard(deps, { ats: "hn_hiring", board: "whoishiring" }),
    ).rejects.toBeInstanceOf(BoardUnavailable);
  });
});

describe("readHead (NS-282)", () => {
  it("takes the company first, the first field naming a role as the title, and a place", () => {
    expect(readHead("Acme | Remote (EU) | Staff Software Engineer | Full-time")).toEqual({
      company: "Acme",
      title: "Staff Software Engineer",
      location: "Remote (EU)",
    });
  });

  it("guesses nothing with one field, no role, or a role where the company should be", () => {
    expect([
      readHead("Acme is hiring"),
      readHead("Acme | Berlin | Full-time"),
      readHead("Senior Engineer | Acme | Remote"),
    ]).toEqual(new Array(3).fill({ company: null, title: null, location: null }));
  });

  it("never stores a link or address as a name or place", () => {
    expect(readHead("https://acme.example.com | Backend Engineer | Remote")).toEqual({
      company: null,
      title: null,
      location: null,
    });
    expect(readHead("Acme | Backend Engineer | jobs@acme.example.com").location).toBeNull();
  });
});
