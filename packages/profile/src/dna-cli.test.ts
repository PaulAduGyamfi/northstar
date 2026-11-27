import type { CareerDnaSnapshot, StoredCareerDna, StoryView } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { type DnaCliDeps, dnaCommand } from "./dna-cli.js";

// `profile dna` (NS-130 slice 5) on an in-memory store. Synthetic atoms and stories only.

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

// An in-memory store that keeps versions like saveCareerDnaReport (a new one only on change).
function harness(over: Partial<DnaCliDeps> = {}) {
  const lines: string[] = [];
  const versions: StoredCareerDna[] = [];
  const stories: StoryView[] = [];
  const deps: DnaCliDeps = {
    print: (l) => lines.push(l),
    readScoringProfile: async () => ({
      sourceId: id(9),
      atoms: [
        { id: id(1), what: "Built a payments ledger", how: ["Java"] },
        { id: id(2), what: "Implemented retry queues", how: [] },
        // The term only in the imported quote: it counts once the quote joins by id.
        { id: id(3), what: "Claims triage", how: [] },
      ],
      skills: [],
    }),
    readThesisProfile: async () => ({
      roles: [],
      atoms: [{ id: id(3), roleId: null, quote: "Shipped a claims triage service." }],
      skills: [],
    }),
    readStories: async () => stories,
    readCareerDnaHistory: async () => [...versions].reverse(),
    saveCareerDnaReport: async (snapshot: CareerDnaSnapshot) => {
      const newest = versions.at(-1);
      const same =
        newest &&
        JSON.stringify({ ...newest, id: 0, version: 0, createdAt: 0 }) ===
          JSON.stringify({ ...snapshot, id: 0, version: 0, createdAt: 0 });
      if (newest && same) {
        return { ok: true, value: { stored: false, version: newest.version, reportId: newest.id } };
      }
      const row = {
        ...snapshot,
        id: id(versions.length + 5),
        version: versions.length + 1,
        createdAt: new Date(),
      };
      versions.push(row);
      return { ok: true, value: { stored: true, version: row.version, reportId: row.id } };
    },
    ...over,
  };
  return { deps, lines, versions, stories };
}

describe("profile dna", () => {
  it("says to import a resume first and stores nothing without one", async () => {
    const h = harness({ readScoringProfile: async () => null });
    expect([await dnaCommand(h.deps, []), h.lines, h.versions]).toEqual([
      1,
      ["No Career DNA yet: import your resume first (profile import-resume <path>)."],
      [],
    ]);
  });

  it("saves the first report, then stores nothing when nothing changed", async () => {
    const h = harness();
    expect(await dnaCommand(h.deps, [])).toBe(0);
    expect(h.lines).toContain("Engineering: low confidence, 3 pieces of evidence.");
    expect(h.lines.slice(-3)).toEqual([
      "Saved as version 1.",
      "What changed:",
      "  This is your first Career DNA report.",
    ]);
    h.lines.length = 0;
    await dnaCommand(h.deps, []);
    expect(h.lines.slice(-3)).toEqual([
      "Unchanged since version 1; nothing stored.",
      "What changed:",
      "  Nothing changed since your last report.",
    ]);
    expect(h.versions).toHaveLength(1);
  });

  // A synthetic approved story with the given competencies.
  const story = (n: number, competencies: string[]): StoryView => ({
    id: id(n),
    title: "Ledger",
    situation: "s",
    task: "t",
    action: "a",
    result: "r",
    competencies,
    atomIds: [],
  });

  it("stores version 2 after a new approved story, with changed lines and what changed", async () => {
    const h = harness();
    await dnaCommand(h.deps, []);
    h.stories.push(story(4, ["technical-depth"]));
    h.lines.length = 0;
    await dnaCommand(h.deps, []);
    expect(h.lines).toContain("Engineering: low confidence, 4 pieces of evidence.");
    expect(h.lines).not.toContain("Engineering: low confidence, 3 pieces of evidence.");
    expect(h.lines).toContain("Saved as version 2.");
    expect(h.lines).toContain("  1 new piece of evidence.");
  });

  it("drops a story's unknown competencies, so they count toward nothing", async () => {
    const h = harness();
    await dnaCommand(h.deps, []);
    h.stories.push(story(4, ["not-a-competency"]));
    h.lines.length = 0;
    await dnaCommand(h.deps, []);
    expect(h.lines).toContain("Unchanged since version 1; nothing stored.");
    expect(h.versions).toHaveLength(1);
  });

  it("stores nothing and exits 1 when the report fails the citation check", async () => {
    const h = harness({ checkReport: () => [{ kind: "uncited", line: 0 }] });
    expect([await dnaCommand(h.deps, []), h.lines, h.versions]).toEqual([
      1,
      ["Not stored: the report didn't pass its checks. Nothing was changed."],
      [],
    ]);
  });

  it("says nothing was stored when the save refuses the report", async () => {
    const h = harness({
      saveCareerDnaReport: async () => ({
        ok: false,
        error: { kind: "InvalidReport", fields: ["dimensions"] },
      }),
    });
    expect(await dnaCommand(h.deps, [])).toBe(1);
    expect(h.lines).toEqual([
      "Not stored: the report didn't pass its checks. Nothing was changed.",
    ]);
  });

  it("refuses extra arguments with its usage line", async () => {
    const h = harness();
    expect([await dnaCommand(h.deps, ["now"]), h.lines]).toEqual([1, ["usage: profile dna"]]);
  });
});
