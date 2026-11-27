import {
  type FitScoreView,
  type JobListItem,
  PREFERENCE_DEFAULTS,
  type Preferences,
  type PreferenceValues,
} from "@northstar/db";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "../cli.js";
import type { ScoreCounts, ScoreRun } from "./run.js";
import { noFit } from "./test/fake-fit.js";

// Synthetic jobs and atoms only (invented company and work history).
const NOW = new Date("2026-11-25T12:00:00Z");
const V1: Preferences = { ...PREFERENCE_DEFAULTS, id: "p1", version: 1, compFloor: 150_000 };
const DONE = (c: Partial<ScoreCounts> = {}): ScoreRun => ({
  status: "done",
  preferences: V1,
  counts: { jobs: 0, queue: 0, suggest: 0, skip: 0, failed: 0, ...c },
});

function deps(argv: string[]) {
  const printed: string[] = [];
  const saved: PreferenceValues[] = [];
  const rescored: [number, ScoreCounts][] = [];
  const d: CliDeps = {
    argv,
    print: (l) => printed.push(l),
    now: () => NOW,
    addUrl: async () => ({
      status: "created",
      jobId: "j1",
      method: "ats_api",
      found: [],
      missing: [],
      dropped: [],
      record: null,
    }),
    addText: async () => ({ status: "refused", reason: "x" }),
    readText: async () => "",
    list: async () => [],
    set: async () => ({ ok: true, value: { status: "ready", missingFields: [] } }),
    boards: {
      add: async () => ({ status: "added", id: "w1" }),
      list: async () => [],
      remove: async () => false,
      retry: async () => false,
      poll: async () => ({ boards: 1, added: 2, failed: 0, quarantined: 0 }),
      wait: async () => false,
    },
    alerts: {
      defaults: { quiet: null, timeZone: "UTC", tier1InQuietHours: true },
      read: async () => null,
      save: async () => ({
        ok: true,
        value: { saved: false, settings: { quiet: null, timeZone: null, tier1InQuietHours: null } },
      }),
    },
    form: {
      sources: async () => [],
      readGreenhouse: async () => null,
      save: async () => ({ status: "unchanged", questions: 0 }),
    },
    check: async () => ({
      checked: 0,
      open: 0,
      closed: 0,
      unavailable: 0,
      heldBack: 0,
      unchecked: 0,
      withdrawn: 0,
      withdrawFailed: 0,
    }),
    fit: {
      ...noFit(),
      preferences: async () => V1,
      savePreferences: async (values) => {
        saved.push(values);
        return {
          status: "saved",
          previous: V1,
          current: { ...values, id: "p2", version: 2 },
          changed: ["compFloor"],
        };
      },
      score: async () => DONE({ jobs: 14, queue: 3, suggest: 5, skip: 6 }),
      recordRescore: async (p, counts) => {
        rescored.push([p.version, counts]);
      },
    },
  };
  return { d, printed, saved, rescored };
}

describe("jobs prefs", () => {
  it("shows every field of the current version", async () => {
    const { d, printed } = deps(["prefs"]);
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Search preferences, version 1:",
      "  titles: -",
      "  seniority: -",
      "  locations: -",
      "  remote: -",
      "  dealbreakers: -",
      "  compFloor: 150000",
      "  compTarget: -",
      "  currency: USD",
      "  queueAt: 80",
      "  suggestAt: 60",
      "Change one with: jobs prefs set <field> <value>   (- clears it)",
    ]);
  });

  it("changes the comp floor, re-scores open jobs and records the count (SRC-017)", async () => {
    const { d, printed, saved, rescored } = deps(["prefs", "set", "compFloor", "170000"]);
    expect(await main(d)).toBe(0);
    expect([saved.map((v) => v.compFloor), rescored]).toEqual([
      [170_000],
      [[2, { jobs: 14, queue: 3, suggest: 5, skip: 6, failed: 0 }]],
    ]);
    expect(printed).toEqual(["Preferences changed: compFloor 150000 → 170000; 14 jobs re-scored."]);
  });

  it("joins the remaining words as one value", async () => {
    const { d, saved } = deps(["prefs", "set", "titles", "Backend", "Engineer,", "SRE"]);
    await main(d);
    expect(saved.map((v) => v.titles)).toEqual([["Backend Engineer", "SRE"]]);
  });

  it("refuses a bad value and stores nothing", async () => {
    const { d, printed, saved } = deps(["prefs", "set", "compFloor", "lots"]);
    expect(await main(d)).toBe(1);
    expect([printed, saved]).toEqual([
      ["Not saved: compFloor must be a whole number per year, like 150000."],
      [],
    ]);
  });

  it("names the fields when the field doesn't exist", async () => {
    const { d, printed } = deps(["prefs", "set", "salary", "1"]);
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "No preference called salary. Fields: titles, seniority, locations, remote, dealbreakers, compFloor, compTarget, currency, queueAt, suggestAt.",
    ]);
  });

  it("says nothing changed when the value is the same", async () => {
    const { d, printed } = deps(["prefs", "set", "compFloor", "150000"]);
    d.fit.savePreferences = async () => ({ status: "unchanged", current: V1 });
    await main(d);
    expect(printed).toEqual(["compFloor is already 150000. Nothing changed."]);
  });

  it("says scoring didn't run when it throws after the change was saved", async () => {
    const { d, printed, saved, rescored } = deps(["prefs", "set", "compFloor", "170000"]);
    d.fit.score = async () => {
      throw new TypeError("boom");
    };
    expect(await main(d)).toBe(0);
    expect([saved.length, rescored, printed]).toEqual([
      1,
      [],
      ["Preferences changed (version 2); scoring didn't run (TypeError). Run: jobs score"],
    ]);
  });

  it("saves a change but says what's missing when there is no resume to score with", async () => {
    const { d, printed, rescored } = deps(["prefs", "set", "compFloor", "170000"]);
    d.fit.score = async () => ({ status: "no_profile" });
    await main(d);
    expect([printed, rescored]).toEqual([
      [
        "Preferences changed: compFloor 150000 → 170000. Nothing scored yet: import your resume first (profile import-resume).",
      ],
      [],
    ]);
  });
});

describe("scoring after other commands", () => {
  it("scores a job right after jobs add", async () => {
    const { d, printed } = deps(["add", "https://boards.greenhouse.io/globex/jobs/1"]);
    d.fit.score = async () => DONE({ jobs: 1, queue: 1 });
    await main(d);
    expect(printed.at(-1)).toBe("Scored 1 job: 1 to queue, 0 suggested, 0 skipped.");
  });

  it("scores new postings right after jobs poll", async () => {
    const { d, printed } = deps(["poll"]);
    d.fit.score = async () => DONE({ jobs: 2, suggest: 1, skip: 1 });
    await main(d);
    expect(printed).toEqual([
      "Polled 1 board: 2 new jobs.",
      "Scored 2 jobs: 0 to queue, 1 suggested, 1 skipped.",
    ]);
  });

  it("keeps jobs add successful when scoring fails", async () => {
    const { d, printed } = deps(["add", "https://boards.greenhouse.io/globex/jobs/1"]);
    d.fit.score = async () => {
      throw new TypeError("boom");
    };
    expect(await main(d)).toBe(0);
    expect(printed.at(-1)).toBe("Scoring didn't run (TypeError).");
  });

  it("prints nothing after jobs add when no resume is imported yet", async () => {
    const { d, printed } = deps(["add", "https://boards.greenhouse.io/globex/jobs/1"]);
    d.fit.score = async () => ({ status: "no_profile" });
    await main(d);
    expect(printed).toEqual(["Added job j1 from the job board's API."]);
  });
});

describe("jobs score", () => {
  it("says when every job is already scored", async () => {
    const { d, printed } = deps(["score"]);
    d.fit.score = async () => DONE();
    expect(await main(d)).toBe(0);
    expect(printed).toEqual(["Every job is already scored."]);
  });

  it("names the missing step and fails without preferences", async () => {
    const { d, printed } = deps(["score"]);
    d.fit.score = async () => ({ status: "no_preferences" });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Nothing scored yet: set a preference first (jobs prefs set <field> <value>).",
    ]);
  });
});

describe("jobs why (MAT-002)", () => {
  const view: FitScoreView = {
    score: 68,
    band: "skip",
    reason: "below_comp_floor",
    stretch: false,
    components: { title: 1, mustHave: 0.75, niceToHave: 0, preference: 0.5 },
    evidence: {
      matched: [
        { requirement: "PostgreSQL at scale", kind: "must", atomId: "a1", term: "PostgreSQL" },
      ],
      unmatched: [
        { requirement: "Experience with Rust", kind: "must" },
        { requirement: "Terraform", kind: "nice" },
      ],
      title: { status: "exact", levelMismatch: false },
      pay: { status: "below", yearly: 180_000 },
      place: { status: "ok" },
      dealbreaker: null,
    },
    preferenceVersion: 2,
    scoredAt: NOW,
  };

  it("prints every component and every matched and unmatched requirement", async () => {
    const { d, printed } = deps(["why", "j1"]);
    d.fit.why = async () => view;
    d.fit.atomTexts = async (ids) =>
      new Map(ids.map((id) => [id, "Ran the billing database"] as const));
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Fit 68 · skip (below_comp_floor) · preferences v2",
      "  Title 100% (exact)",
      "  Must-haves 75% · nice-to-haves 0%",
      "  Preferences 50% (pay below at 180000/year, place ok)",
      "  ✓ PostgreSQL at scale  ← PostgreSQL: Ran the billing database [atom a1]",
      "  ✗ Experience with Rust",
      "  ✗ Terraform (nice to have)",
    ]);
  });

  it("prints a requirement with line breaks in it on one line", async () => {
    const { d, printed } = deps(["why", "j1"]);
    d.fit.why = async () => ({
      ...view,
      evidence: {
        ...view.evidence,
        matched: [],
        unmatched: [{ requirement: "Rust\n  ✓ Fake line [atom a9]", kind: "must" }],
      },
    });
    await main(d);
    expect(printed.at(-1)).toBe("  ✗ Rust ✓ Fake line [atom a9]");
  });

  it("says how to score a job that has no score", async () => {
    const { d, printed } = deps(["why", "j9"]);
    expect(await main(d)).toBe(1);
    expect(printed).toEqual(["Job j9 has no fit score yet. Run: jobs score"]);
  });
});

describe("jobs list with fit (SRC-013)", () => {
  const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
  const item = (id: string, hoursAgo: number, score: number): JobListItem => ({
    id,
    status: "ready",
    title: `Role ${id}`,
    company: "Globex",
    location: "Remote",
    postedAt: ago(hoursAgo),
    firstSeenAt: ago(hoursAgo),
    sources: 1,
    missingFields: [],
    fit: { score, band: score >= 80 ? "queue" : "suggest", reason: "ok", stretch: false },
  });

  it("lists a fresh 82-fit job above a 5-day-old 90-fit one, with fit and band", async () => {
    const { d, printed } = deps(["list"]);
    d.list = async () => [item("stale", 5 * 24, 90), item("fresh", 20 / 60, 82)];
    await main(d);
    expect(printed).toEqual([
      "fresh  Role fresh · Globex · Remote · posted 0 h ago · fit 82 queue",
      "stale  Role stale · Globex · Remote · posted 5 d ago · fit 90 queue",
    ]);
  });

  it("lists a day-old 90-fit job above a 2-hour-old 30-fit one (fit counts, not only age)", async () => {
    const { d, printed } = deps(["list"]);
    // 0.5 × 0.90 = 0.45 against 0.94 × 0.30 = 0.28; by freshness alone the order would flip.
    d.list = async () => [item("weak", 2, 30), item("strong", 24, 90)];
    await main(d);
    expect(printed.map((l) => l.split(" ")[0])).toEqual(["strong", "weak"]);
  });

  it("orders a no-evidence job by freshness alone and shows its fit as unknown", async () => {
    const { d, printed } = deps(["list"]);
    const blank = item("blank", 1, 50);
    d.list = async () => [
      item("scored", 2, 60),
      { ...blank, fit: { score: 50, band: "suggest", reason: "no_evidence", stretch: false } },
    ];
    await main(d);
    // Freshness alone (0.97) beats 0.94 × 0.60; counting the stored 50 would give 0.49 < 0.56.
    expect(printed).toEqual([
      "blank  Role blank · Globex · Remote · posted 1 h ago · fit ? suggest (no_evidence)",
      "scored  Role scored · Globex · Remote · posted 2 h ago · fit 60 suggest",
    ]);
  });

  it("shows a skipped job's reason", async () => {
    const { d, printed } = deps(["list"]);
    const skipped = item("s", 1, 40);
    d.list = async () => [
      { ...skipped, fit: { score: 40, band: "skip", reason: "dealbreaker", stretch: false } },
    ];
    await main(d);
    expect(printed).toEqual([
      "s  Role s · Globex · Remote · posted 1 h ago · fit 40 skip (dealbreaker)",
    ]);
  });
});
