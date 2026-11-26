import { describe, expect, it } from "vitest";
import type { AuditRun, DecisionRun } from "./audit/run.js";
import { AUDIT_USAGE, type AuditCliDeps, auditCommand } from "./audit-cli.js";
import { sampleMaster } from "./tailor/test/master.js";

// `profile audit` and its decisions (NS-190), with the runner faked. Synthetic master only.

const master = sampleMaster();
const atom = master.atoms[0];

const audited: AuditRun = {
  kind: "audited",
  auditId: "audit-1",
  master,
  hidden: 1,
  audit: {
    scores: { impact: 40, verbs: 90, ats: 100, length: 100, keywords: 50, consistency: 100 },
    overall: 80,
    pages: 1,
    suggestions: [
      {
        id: `missing_metric:${atom?.id}`,
        kind: "missing_metric",
        dimension: "impact",
        target: { atomId: atom?.id ?? "" },
        message: "No measured result.",
      },
    ],
  },
};

function deps(over: Partial<AuditCliDeps> = {}) {
  const printed: string[] = [];
  const calls: unknown[] = [];
  const d: AuditCliDeps = {
    print: (line) => printed.push(line),
    runAudit: async () => audited,
    acceptSuggestion: async (key, line): Promise<DecisionRun> => {
      calls.push(["accept", key, line]);
      return { kind: "decided", decision: "accepted", key };
    },
    rejectSuggestion: async (key): Promise<DecisionRun> => {
      calls.push(["reject", key]);
      return { kind: "decided", decision: "rejected", key };
    },
    ...over,
  };
  return { d, printed, calls };
}

describe("profile audit", () => {
  it("prints the scores, each suggestion with its key and line, and what it left out", async () => {
    const { d, printed } = deps();
    expect(await auditCommand(d, [])).toBe(0);
    expect(printed).toEqual([
      "Overall 80/100: impact 40, verbs 90, ATS 100, length 100, keywords 50, consistency 100 (1 page)",
      `missing_metric:${atom?.id}`,
      `  line: ${atom?.sourceQuote}`,
      "  No measured result.",
      "1 suggestion you rejected before on this resume is left out.",
      'Saved. Accept one with your own line: profile audit accept <key> "<new line>". Reject: profile audit reject <key>.',
    ]);
  });

  it("says to import a resume first when there is none", async () => {
    const { d, printed } = deps({
      runAudit: async () => ({ kind: "refused", reason: "NoProfile" }),
    });
    expect([await auditCommand(d, []), printed]).toEqual([
      1,
      ["No resume imported yet. Run: profile import-resume data/<file>"],
    ]);
  });

  it("accepts a suggestion with Paul's line and says what changes", async () => {
    const { d, printed, calls } = deps();
    expect(await auditCommand(d, ["accept", "missing_metric:a1", "Cut pages by half."])).toBe(0);
    expect([calls, printed]).toEqual([
      [["accept", "missing_metric:a1", "Cut pages by half."]],
      ["Accepted missing_metric:a1. Tailored resumes use your new line from now on."],
    ]);
  });

  it("rejects a suggestion", async () => {
    const { d, printed } = deps();
    expect(await auditCommand(d, ["reject", "missing_keyword:k8s"])).toBe(0);
    expect(printed).toEqual([
      "Rejected missing_keyword:k8s. It won't come back for this resume import.",
    ]);
  });

  it("prints why a line was refused and stores nothing", async () => {
    const { d, printed } = deps({
      acceptSuggestion: async () => ({ kind: "refused", reason: "names_other_role" }),
    });
    expect(await auditCommand(d, ["accept", "missing_metric:a1", "At Sample Logistics…"])).toBe(1);
    expect(printed).toEqual([
      "Not saved: The new line names another role's employer, title or years: keep it to this role.",
    ]);
  });

  it("prints the audit usage for a malformed audit command", async () => {
    for (const args of [["accept", "k"], ["reject"], ["reject", "k", "extra"], ["what"]]) {
      const { d, printed, calls } = deps();
      expect([await auditCommand(d, args), printed, calls]).toEqual([1, [AUDIT_USAGE], []]);
    }
  });
});
