import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATUSES,
  ApplicationsBody,
  type ApplicationView,
  boardColumns,
  cardTitle,
  changedAgo,
  filterQuery,
  parseFilters,
  STATUS_WORDS,
  tableRows,
} from "./pipeline";

// The pipeline page's plain logic (NS-168), without a browser. Synthetic jobs only.
const app = (over: Partial<ApplicationView>): ApplicationView => ({
  applicationId: "a1",
  status: "queued",
  jobTitle: "Backend Engineer",
  company: "Example Corp",
  ats: "greenhouse",
  fitScore: null,
  fitBand: null,
  createdAt: "2026-11-25T12:00:00.000Z",
  updatedAt: "2026-11-25T12:00:00.000Z",
  ...over,
});

describe("STATUS_WORDS", () => {
  it("has a word for every application status", () => {
    expect(APPLICATION_STATUSES.every((s) => STATUS_WORDS[s].length > 0)).toBe(true);
  });

  it("reads every ending that isn't an offer as a neutral 'closed' (UX-020)", () => {
    expect([STATUS_WORDS.rejected, STATUS_WORDS.withdrawn, STATUS_WORDS.ghosted]).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
  });

  it("uses the shared status vocabulary (UX-020)", () => {
    expect([
      STATUS_WORDS.discovered,
      STATUS_WORDS.awaiting_approval,
      STATUS_WORDS.needs_human,
      STATUS_WORDS.in_process,
    ]).toEqual(["found", "awaiting you", "needs your hands", "interviewing"]);
  });
});

describe("boardColumns", () => {
  it("makes one column per word that has applications, in the state machine's order", () => {
    const columns = boardColumns([
      app({ applicationId: "a", status: "rejected" }),
      app({ applicationId: "b", status: "queued" }),
      app({ applicationId: "c", status: "package_ready" }),
      app({ applicationId: "d", status: "ghosted" }),
    ]);
    expect(columns.map((c) => [c.word, c.items.map((i) => i.applicationId)])).toEqual([
      ["queued", ["b", "c"]],
      ["closed", ["a", "d"]],
    ]);
  });

  it("is empty when there are no applications", () => {
    expect(boardColumns([])).toEqual([]);
  });
});

describe("cardTitle", () => {
  it("names the job and company, or says what is missing on a draft", () => {
    expect([cardTitle(app({})), cardTitle(app({ jobTitle: null, company: null }))]).toEqual([
      "Backend Engineer at Example Corp",
      "Untitled job at Unknown company",
    ]);
  });
});

describe("ApplicationsBody", () => {
  it("refuses a status the state machine doesn't know", () => {
    expect(ApplicationsBody.safeParse({ items: [app({})] }).success).toBe(true);
    expect(ApplicationsBody.safeParse({ items: [{ ...app({}), status: "maybe" }] }).success).toBe(
      false,
    );
  });
});

describe("changedAgo", () => {
  it("never says 'just now ago'", () => {
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    expect([
      changedAgo("2026-11-25T11:59:50.000Z", now),
      changedAgo("2026-11-25T09:00:00.000Z", now),
    ]).toEqual(["changed just now", "changed 3 h ago"]);
  });
});

describe("parseFilters and filterQuery (NS-207)", () => {
  it("keeps only well-formed fields and the table view", () => {
    expect(
      parseFilters({
        company: " Globex ",
        band: "queue",
        source: "lever",
        from: "2026-11-01",
        to: "nope",
        view: "table",
        other: "x",
      }),
    ).toEqual({
      filters: { company: "Globex", band: "queue", source: "lever", from: "2026-11-01" },
      view: "table",
    });
  });

  it("drops an unknown band or source, an empty field and repeated values", () => {
    expect(
      parseFilters({ band: "great", source: "linkedin", company: "", to: ["2026-11-01", "x"] }),
    ).toEqual({ filters: {}, view: "board" });
  });

  it("writes the same URL for the same view, and reads it back", () => {
    const filters = { to: "2026-11-30", company: "Hooli Labs", band: "skip" as const };
    const query = filterQuery(filters, "table");
    const back = parseFilters(Object.fromEntries(new URLSearchParams(query.slice(1))));
    expect([query, back]).toEqual([
      "?company=Hooli+Labs&band=skip&to=2026-11-30&view=table",
      { filters, view: "table" },
    ]);
  });

  it("writes nothing for no filters on the board", () => {
    expect(filterQuery({})).toBe("");
  });
});

describe("tableRows (NS-207)", () => {
  it("shows the status in words, the fit and its band, or not scored", () => {
    const now = Date.parse("2026-11-25T15:00:00.000Z");
    expect(
      tableRows(
        [
          app({ status: "rejected", fitScore: 88, fitBand: "queue" }),
          app({ applicationId: "a2", jobTitle: null, company: null }),
        ],
        now,
      ).map((r) => [r.title, r.company, r.status, r.fit, r.changed]),
    ).toEqual([
      ["Backend Engineer", "Example Corp", "closed", "88 · Queue", "changed 3 h ago"],
      ["Untitled job", "Unknown company", "queued", "not scored", "changed 3 h ago"],
    ]);
  });
});
