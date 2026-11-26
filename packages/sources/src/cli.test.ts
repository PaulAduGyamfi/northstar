import type { JobListItem } from "@northstar/db";
import { HeldBack, LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "./cli.js";
import { noFit } from "./fit/test/fake-fit.js";
import type { IngestResult } from "./ingest.js";

// Synthetic jobs only (invented companies).
const NOW = new Date("2026-11-25T12:00:00Z");

function deps(argv: string[], result?: IngestResult | Error) {
  const printed: string[] = [];
  const calls: unknown[] = [];
  const d: CliDeps = {
    argv,
    print: (l) => printed.push(l),
    now: () => NOW,
    addUrl: async (url) => {
      calls.push(["url", url]);
      if (result instanceof Error) throw result;
      return result ?? { status: "refused", reason: "x" };
    },
    addText: async (url, text) => {
      calls.push(["text", url, text]);
      if (result instanceof Error) throw result;
      return result ?? { status: "refused", reason: "x" };
    },
    readText: async () => "Backend Engineer\nGlobex",
    list: async () => [],
    set: async () => ({ ok: true, value: { status: "ready", missingFields: [] } }),
    boards: {
      add: async () => ({ status: "added", id: "w1" }),
      list: async () => [],
      remove: async () => false,
      retry: async () => false,
      poll: async () => ({ boards: 0, added: 0, failed: 0, quarantined: 0 }),
      wait: async () => false,
    },
    fit: noFit(),
    check: async () => ({ checked: 0, open: 0, closed: 0, unavailable: 0, heldBack: 0 }),
  };
  return { d, printed, calls };
}

describe("jobs check (NS-173)", () => {
  it("prints the pass's counts", async () => {
    const { d, printed } = deps(["check"]);
    d.check = async () => ({ checked: 3, open: 1, closed: 1, unavailable: 1, heldBack: 2 });
    expect([await main(d), printed]).toEqual([
      0,
      [
        "Checked 3 postings: 1 open, 1 closed, 1 couldn't be reached, 2 held back by a switch or breaker",
      ],
    ]);
  });
});

describe("jobs add", () => {
  it("reports a new job and how it was read", async () => {
    const { d, printed } = deps(["add", "https://boards.greenhouse.io/globex/jobs/1"], {
      status: "created",
      jobId: "j1",
      method: "ats_api",
      found: ["title", "company", "location"],
      missing: [],
      dropped: [],
      record: null,
    });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Added job j1 from the job board's API.",
      "  Found: title, company, location.",
    ]);
  });

  it("says what a draft is missing and how to fill it", async () => {
    const { d, printed } = deps(["add", "https://careers.example/job/77"], {
      status: "created",
      jobId: "j2",
      method: "model",
      found: [],
      missing: ["company"],
      dropped: ["seniority"],
      record: null,
    });
    await main(d);
    expect(printed).toEqual([
      "Added job j2 from the page text, read by the model.",
      "  Left out (not on the page): seniority.",
      "  Draft: company not found. Fill in with: jobs set j2 <field> <value>",
    ]);
  });

  it("explains a refused link and exits 1", async () => {
    const { d, printed } = deps(["add", "https://www.linkedin.com/jobs/view/1"], {
      status: "refused",
      reason:
        "www.linkedin.com doesn't allow automated reading; save the description to a file and use jobs add --text",
    });
    expect(await main(d)).toBe(1);
    expect(printed[0]).toBe(
      "Not added: www.linkedin.com doesn't allow automated reading; save the description to a file and use jobs add --text.",
    );
  });

  it("reports a repeat link and a merged duplicate without failing", async () => {
    const a = deps(["add", "https://x.example/1"], {
      status: "unchanged",
      jobId: "j1",
      method: "ats_api",
      found: [],
      missing: [],
      dropped: [],
      record: null,
    });
    const b = deps(["add", "https://x.example/2"], {
      status: "merged",
      jobId: "j1",
      method: "jsonld",
      found: [],
      missing: [],
      dropped: [],
      record: null,
    });
    expect(await main(a.d)).toBe(0);
    expect(await main(b.d)).toBe(0);
    expect(a.printed[0]).toBe("Already added (job j1). Nothing changed.");
    expect(b.printed[0]).toBe("Same role as job j1; added this link as another source.");
  });

  it("names an unexpected error without quoting it", async () => {
    const { d, printed } = deps(
      ["add", "https://x.example/1"],
      new RangeError("row contains secret text"),
    );
    expect(await main(d)).toBe(1);
    expect(printed).toEqual(["Not added: RangeError."]);
  });

  it("reports a Claude API outage by status", async () => {
    const { d, printed } = deps(
      ["add", "https://x.example/1"],
      new LlmTransportError({ status: 529, retryable: true }),
    );
    await main(d);
    expect(printed).toEqual([
      "Not added: the Claude API didn't answer (status 529). Try again later.",
    ]);
  });

  it("says which breaker held the model back and when to try again", async () => {
    const { d, printed } = deps(
      ["add", "https://x.example/1"],
      new HeldBack("breaker", "anthropic", new Date("2026-11-25T22:30:00Z")),
    );
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Not added: the anthropic breaker is open until 2026-11-25T22:30:00.000Z. Try again later.",
    ]);
  });

  it("add --text reads the file and passes it with its link", async () => {
    const { d, calls } = deps(
      ["add", "--text", "data/jd.txt", "--url", "https://www.linkedin.com/jobs/view/9"],
      {
        status: "created",
        jobId: "j3",
        method: "text",
        found: [],
        missing: [],
        dropped: [],
        record: null,
      },
    );
    expect(await main(d)).toBe(0);
    expect(calls).toEqual([
      ["text", "https://www.linkedin.com/jobs/view/9", "Backend Engineer\nGlobex"],
    ]);
  });
});

describe("jobs list", () => {
  it("shows each job newest first with its age, sources and draft gaps", async () => {
    const jobs: JobListItem[] = [
      {
        id: "j1",
        status: "ready",
        title: "Backend Engineer",
        company: "Globex",
        location: "Remote - US",
        postedAt: new Date("2026-11-25T09:00:00Z"),
        firstSeenAt: NOW,
        sources: 2,
        missingFields: [],
        fit: null,
      },
      {
        id: "j2",
        status: "draft",
        title: "Data Scientist",
        company: null,
        location: null,
        postedAt: null,
        firstSeenAt: new Date("2026-11-21T12:00:00Z"),
        sources: 1,
        missingFields: ["company"],
        fit: null,
      },
    ];
    const { d, printed } = deps(["list"]);
    d.list = async () => jobs;
    await main(d);
    expect(printed).toEqual([
      "j1  Backend Engineer · Globex · Remote - US · posted 3 h ago · 2 sources",
      "j2  Data Scientist · ? · location ? · seen 4 d ago [draft: needs company]",
    ]);
  });

  it("says how to add the first job when there are none", async () => {
    const { d, printed } = deps(["list"]);
    await main(d);
    expect(printed).toEqual(["No jobs yet. Add one with: jobs add <url>"]);
  });
});

describe("jobs set", () => {
  it("joins the rest of the words as the value and reports a completed draft", async () => {
    const seen: string[][] = [];
    const { d, printed } = deps(["set", "j2", "company", "Umbrella", "Labs"]);
    d.set = async (id, field, value) => {
      seen.push([id, field, value]);
      return { ok: true, value: { status: "ready", missingFields: [] } };
    };
    expect(await main(d)).toBe(0);
    expect(seen).toEqual([["j2", "company", "Umbrella Labs"]]);
    expect(printed).toEqual(["Saved. Job j2 is ready."]);
  });

  it("explains a field that can't be edited", async () => {
    const { d, printed } = deps(["set", "j1", "url", "x"]);
    d.set = async () => ({ ok: false, error: { kind: "NotEditable", field: "url" } });
    expect(await main(d)).toBe(1);
    expect(printed[0]?.startsWith("url can't be set by hand.")).toBe(true);
  });
});

describe("usage", () => {
  it("prints usage for anything else", async () => {
    const { d, printed } = deps(["frobnicate"]);
    expect(await main(d)).toBe(1);
    expect(printed[0]?.startsWith("usage: jobs add <url>")).toBe(true);
  });
});
