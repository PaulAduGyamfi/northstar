import type { AuditInput, AuditView, SaveAuditInput } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { sampleMaster } from "../tailor/test/master.js";
import { type AuditRunDeps, acceptSuggestion, rejectSuggestion, runAudit } from "./run.js";

// The audit run and Paul's decisions (NS-190) over fakes of packages/db's write paths (their own
// tests run on PGlite there). Synthetic master only.

const SOURCE = "source-1";

function world(over: { input?: AuditInput | null; rejected?: string[] } = {}) {
  const saved: Omit<SaveAuditInput, "candidateId">[] = [];
  const decided: unknown[] = [];
  let latest: AuditView | null = null;
  const input: AuditInput | null =
    over.input === undefined
      ? { profileSourceId: SOURCE, master: sampleMaster(), targets: ["Kubernetes"] }
      : over.input;
  const deps: AuditRunDeps = {
    readInput: async () => input,
    rejected: async () => new Set(over.rejected ?? []),
    save: async (s) => {
      saved.push(s);
      latest = {
        auditId: "audit-1",
        profileSourceId: s.profileSourceId,
        targets: s.targets,
        scores: s.scores,
        overall: s.overall,
        pages: s.pages,
        createdAt: new Date(0),
        suggestions: s.suggestions.map((x) => ({ ...x, decision: null, newLine: null })),
      };
      return { auditId: "audit-1" };
    },
    readLatest: async () => latest,
    decide: async (d) => {
      decided.push(d);
      return { ok: true, value: { decisionId: "decision-1" } };
    },
  };
  return { deps, saved, decided };
}

describe("runAudit", () => {
  it("refuses before any resume import, and stores nothing", async () => {
    const w = world({ input: null });
    expect([await runAudit(w.deps), w.saved.length]).toEqual([
      { kind: "refused", reason: "NoProfile" },
      0,
    ]);
  });

  it("stores the run with its scores, targets and suggestions", async () => {
    const w = world();
    const run = await runAudit(w.deps);
    if (run.kind !== "audited") throw new Error(run.kind);
    expect(w.saved).toEqual([
      {
        profileSourceId: SOURCE,
        targets: ["Kubernetes"],
        scores: run.audit.scores,
        overall: run.audit.overall,
        pages: run.audit.pages,
        suggestions: run.audit.suggestions,
      },
    ]);
    expect(run.audit.suggestions.length).toBeGreaterThan(0);
  });

  it("leaves out what Paul rejected before on this import, and counts it", async () => {
    const all = await runAudit(world().deps);
    if (all.kind !== "audited") throw new Error(all.kind);
    const first = all.audit.suggestions[0]?.id ?? "";
    const run = await runAudit(world({ rejected: [first] }).deps);
    if (run.kind !== "audited") throw new Error(run.kind);
    expect([run.audit.suggestions.some((s) => s.id === first), run.hidden]).toEqual([false, 1]);
  });
});

// The newest run's first suggestion about one line.
async function audited() {
  const w = world();
  const run = await runAudit(w.deps);
  if (run.kind !== "audited") throw new Error(run.kind);
  const line = run.audit.suggestions.find((s) => "atomId" in s.target);
  const term = run.audit.suggestions.find((s) => "term" in s.target);
  if (!line) throw new Error("no line suggestion");
  return { w, line, term };
}

describe("acceptSuggestion", () => {
  it("stores Paul's line, trimmed as applySuggestion normalised it", async () => {
    const { w, line } = await audited();
    expect(await acceptSuggestion(w.deps, line.id, "  Cut the on-call pages by half.  ")).toEqual({
      kind: "decided",
      decision: "accepted",
      key: line.id,
    });
    expect(w.decided).toEqual([
      {
        auditId: "audit-1",
        key: line.id,
        decision: "accepted",
        newLine: "Cut the on-call pages by half.",
      },
    ]);
  });

  it("refuses a line naming another role's employer, and stores nothing", async () => {
    const { w, line } = await audited();
    const r = await acceptSuggestion(w.deps, line.id, "Led the Sample Logistics routing rewrite.");
    const other = await acceptSuggestion(
      w.deps,
      line.id,
      "Led the Example Payments ledger rewrite.",
    );
    // Whichever role the atom belongs to, one of the two names the other role.
    expect([r, other].filter((x) => x.kind === "refused")).toEqual([
      { kind: "refused", reason: "names_other_role" },
    ]);
  });

  it("refuses a new line for a term suggestion", async () => {
    const { w, term } = await audited();
    if (!term) return;
    expect(await acceptSuggestion(w.deps, term.id, "Ran Kubernetes clusters.")).toEqual({
      kind: "refused",
      reason: "not_a_line",
    });
    expect(w.decided).toEqual([]);
  });

  it("refuses with no audit yet, an unknown key, or an audit of an older import", async () => {
    const empty = world();
    const { w, line } = await audited();
    const stale = {
      ...w.deps,
      readInput: async () => ({
        profileSourceId: "source-2",
        master: sampleMaster(),
        targets: [],
      }),
    };
    expect([
      await acceptSuggestion(empty.deps, line.id, "A line."),
      await acceptSuggestion(w.deps, "tense:nope", "A line."),
      await acceptSuggestion(stale, line.id, "A line."),
    ]).toEqual([
      { kind: "refused", reason: "NoAudit" },
      { kind: "refused", reason: "UnknownSuggestion" },
      { kind: "refused", reason: "StaleAudit" },
    ]);
  });
});

describe("rejectSuggestion", () => {
  it("stores a rejection of the newest run's suggestion", async () => {
    const { w, line } = await audited();
    expect(await rejectSuggestion(w.deps, line.id)).toEqual({
      kind: "decided",
      decision: "rejected",
      key: line.id,
    });
    expect(w.decided).toEqual([{ auditId: "audit-1", key: line.id, decision: "rejected" }]);
  });

  it("passes the store's refusal back", async () => {
    const { w, line } = await audited();
    w.deps.decide = async () => ({ ok: false, error: { kind: "AlreadyDecided" } });
    expect(await rejectSuggestion(w.deps, line.id)).toEqual({
      kind: "refused",
      reason: "AlreadyDecided",
    });
  });
});
