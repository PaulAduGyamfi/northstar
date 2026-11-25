import { describe, expect, it } from "vitest";
import { NUMBER_WORDS } from "../answer/validate.js";
import { sampleMaster } from "../tailor/test/master.js";
import type { MasterResume } from "../tailor/types.js";
import { numbers } from "../validate.js";
import { auditResume, fullResume } from "./audit.js";

// A synthetic master with one of each weak spot (invented person, public repo).
function weakMaster(): MasterResume {
  const m = sampleMaster();
  m.roles = m.roles.map((r) => (r.id === "role-2" ? { ...r, endMonth: null } : r));
  m.atoms.push(
    {
      id: "atom-6",
      roleId: "role-2",
      what: "Helped with the warehouse dashboard",
      how: [],
      sourceQuote: "• Helped with the warehouse dashboard for the operations team.",
    },
    {
      id: "atom-7",
      roleId: "role-2",
      what: "Manages the shipment tracking service",
      how: ["Python"],
      sourceQuote: "• Manages the shipment tracking service and its Python workers.",
    },
    {
      id: "atom-8",
      roleId: "role-1",
      what: "Rebuilt the settlement pipeline",
      how: ["Go"],
      sourceQuote: `• Rebuilt the settlement pipeline in Go, ${"with careful reviews, staged rollouts, shadow traffic and clear dashboards for every partner bank, ".repeat(2)}cutting failed settlements by 40%.`,
    },
  );
  return m;
}

// A master with no weak spot: every bullet measured, opened with an action verb, past tense in
// the past role, every date there and short lines.
function cleanMaster(): MasterResume {
  const m = sampleMaster();
  m.atoms = m.atoms.filter((a) => a.id === "atom-1" || a.id === "atom-2" || a.id === "atom-4");
  return m;
}

// Suggestion ids are `<kind>:<target>`.
const kinds = (audit: Awaited<ReturnType<typeof auditResume>>) =>
  audit.suggestions.map((s) => s.id);

describe("auditResume", () => {
  it("scores a clean master 100 on every dimension and suggests nothing", async () => {
    const audit = await auditResume(cleanMaster(), ["Go", "Postgres"]);
    expect(audit.scores).toEqual({
      impact: 100,
      verbs: 100,
      ats: 100,
      length: 100,
      keywords: 100,
      consistency: 100,
    });
    expect(audit.overall).toBe(100);
    expect(audit.suggestions).toEqual([]);
    expect(audit.pages).toBe(1);
  });

  it("asks for a measured result on every bullet without a number or number word", async () => {
    const audit = await auditResume(sampleMaster(), []);
    // atom-3 and atom-5 have no number; atom-1 says "zero", a number word.
    expect(kinds(audit).filter((k) => k.startsWith("missing_metric"))).toEqual([
      "missing_metric:atom-3",
      "missing_metric:atom-5",
    ]);
    expect(audit.scores.impact).toBe(60);
  });

  it("names the weak opener a bullet starts with", async () => {
    const audit = await auditResume(weakMaster(), []);
    const weak = audit.suggestions.filter((s) => s.kind === "weak_opener");
    expect(weak).toHaveLength(1);
    expect(weak[0]?.target).toEqual({ atomId: "atom-6" });
    expect(weak[0]?.message).toContain('"Helped"');
    // 7 of 8 bullets open with an action verb.
    expect(audit.scores.verbs).toBe(88);
  });

  it("flags a present-tense opener in a past role but not in the current role or a project", async () => {
    const m = weakMaster();
    // A present-tense bullet in the current role is fine.
    m.atoms.push({
      id: "atom-9",
      roleId: "role-1",
      what: "Leading the fraud review",
      how: [],
      sourceQuote: "• Leading the fraud review with 3 analysts.",
    });
    const audit = await auditResume(m, []);
    expect(kinds(audit).filter((k) => k.startsWith("tense"))).toEqual(["tense:atom-7"]);
    // atom-5 ("Maintain …") is a project, so its tense isn't checked.
  });

  it("points a missing date to the official record instead of editing it", async () => {
    const m = weakMaster();
    m.roles = m.roles.map((r) => (r.id === "role-1" ? { ...r, startMonth: null } : r));
    const audit = await auditResume(m, []);
    const dates = audit.suggestions.filter((s) => s.kind === "missing_date");
    expect(dates.map((s) => s.target)).toEqual([{ roleId: "role-1" }, { roleId: "role-2" }]);
    expect(dates[0]?.message).toContain("profile facts");
  });

  it("scores consistency as the share of checks that pass", async () => {
    const audit = await auditResume(weakMaster(), []);
    // Checks: 2 roles' dates (role-2 has no end) and 3 past-role bullets (atom-7 is present
    // tense): 3 of 5 pass.
    expect(audit.scores.consistency).toBe(60);
  });

  it("flags a bullet over 200 characters", async () => {
    const audit = await auditResume(weakMaster(), []);
    expect(kinds(audit).filter((k) => k.startsWith("long_line"))).toEqual(["long_line:atom-8"]);
  });

  it("lists target terms the master never names and scores their coverage", async () => {
    const audit = await auditResume(sampleMaster(), ["Go", "terraform", "Kubernetes", "go"]);
    const missing = audit.suggestions.filter((s) => s.kind === "missing_keyword");
    expect(missing.map((s) => s.target)).toEqual([{ term: "Kubernetes" }]);
    expect(missing[0]?.message).toContain("only if you have done it");
    // Go and Terraform are named (once each, ignoring case); Kubernetes isn't.
    expect(audit.scores.keywords).toBe(67);
  });

  it("counts a target term the master names as a role title as covered", async () => {
    const audit = await auditResume(sampleMaster(), ["Senior Software Engineer"]);
    expect(audit.scores.keywords).toBe(100);
    expect(audit.suggestions.filter((s) => s.kind === "missing_keyword")).toEqual([]);
  });

  it("drops the length score by 25 for each page past the first", async () => {
    const m = sampleMaster();
    m.atoms = Array.from({ length: 60 }, (_, i) => ({
      id: `long-${i + 1}`,
      roleId: "role-1",
      what: `Shipped billing feature ${i + 1}`,
      how: ["Go"],
      sourceQuote: `• Shipped billing feature ${i + 1} in Go for the payments team, with integration tests, a staged rollout behind a flag, dashboards for its error rate and a runbook.`,
    }));
    const audit = await auditResume(m, []);
    // 60 bullets of two wrapped lines each fill three pages: two past the first.
    expect([audit.pages, audit.scores.length]).toEqual([3, 50]);
  });

  it("reports an ATS suggestion when the PDF can't carry the master's characters", async () => {
    const m = cleanMaster();
    m.atoms = m.atoms.map((a) =>
      a.id !== "atom-1"
        ? a
        : {
            ...a,
            sourceQuote:
              "• Made payment retries idempotent in Go, 漢字 漢字 漢字 漢字 cutting duplicates to zero.",
          },
    );
    const audit = await auditResume(m, []);
    // The four replaced words are about 5% of the rendered words, and no header is lost.
    expect(audit.scores.ats).toBe(95);
    expect(kinds(audit)).toContain("ats:resume");
  });

  it("gives the overall score as the rounded mean of the six", async () => {
    const audit = await auditResume(weakMaster(), ["Kubernetes"]);
    const values = Object.values(audit.scores);
    expect(audit.overall).toBe(Math.round(values.reduce((a, b) => a + b, 0) / values.length));
  });

  it("never puts a number in a suggestion that isn't in the master or a target term", async () => {
    const m = weakMaster();
    const targets = ["Kubernetes", "S3", "Go"];
    const audit = await auditResume(m, targets);
    const known = new Set([
      ...numbers(JSON.stringify(m)),
      ...targets.flatMap((t) => [...numbers(t)]),
    ]);
    const knownWords = new Set(
      `${JSON.stringify(m)} ${targets.join(" ")}`.toLowerCase().match(/\p{L}+/gu) ?? [],
    );
    expect(audit.suggestions.length).toBeGreaterThan(5);
    for (const s of audit.suggestions) {
      for (const n of numbers(s.message)) expect(known.has(n), `${s.id}: ${n}`).toBe(true);
      for (const w of s.message.toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (NUMBER_WORDS.has(w)) expect(knownWords.has(w), `${s.id}: ${w}`).toBe(true);
      }
    }
  });

  it("gives the same audit for the same master and targets, with stable ids", async () => {
    const a = await auditResume(weakMaster(), ["Kubernetes"]);
    const b = await auditResume(weakMaster(), ["Kubernetes"]);
    expect(a).toEqual(b);
    expect(new Set(a.suggestions.map((s) => s.id)).size).toBe(a.suggestions.length);
  });
});

describe("fullResume", () => {
  it("keeps every atom in master order and every master skill", () => {
    const m = sampleMaster();
    const r = fullResume(m);
    expect(r.sections.flatMap((s) => s.lines.flatMap((l) => l.atomIds))).toEqual(
      m.atoms.map((a) => a.id),
    );
    expect(r.skills.map((s) => s.name)).toEqual(m.skills);
  });
});

describe("the audit's word lists", () => {
  // One past-role bullet with the given line, so only its own checks run.
  async function auditLine(line: string) {
    const m = sampleMaster();
    m.atoms = [{ id: "a", roleId: "role-2", what: line, how: [], sourceQuote: `• ${line}` }];
    return auditResume(m, []);
  }

  it("names the whole two-word opener, keeping the line's case", async () => {
    const audit = await auditLine("Worked on the 3 billing services.");
    expect(audit.suggestions.map((s) => s.message)).toEqual([
      'Opens with "Worked on". Start with what you did, with an action verb.',
    ]);
  });

  it("doesn't call a word that only starts like a weak opener weak", async () => {
    const audit = await auditLine("Helmed the 3 billing services.");
    expect(audit.suggestions).toEqual([]);
  });

  it("doesn't flag a verb whose past form is its base form in a past role", async () => {
    const audit = await auditLine("Cut build time by 40%.");
    expect(audit.suggestions).toEqual([]);
  });

  it("flags every present form of a listed verb in a past role", async () => {
    for (const line of ["Run the 3 services.", "Runs the 3 services.", "Running the 3 services."]) {
      const audit = await auditLine(line);
      expect(audit.suggestions.map((s) => s.kind)).toEqual(["tense"]);
    }
  });
});
