import { describe, expect, it } from "vitest";
import { sampleMaster } from "../tailor/test/master.js";
import { applySuggestion } from "./apply.js";
import type { Suggestion } from "./audit.js";

const metric: Suggestion = {
  id: "missing_metric:atom-3",
  kind: "missing_metric",
  dimension: "impact",
  target: { atomId: "atom-3" },
  message: "No measured result.",
};

describe("applySuggestion", () => {
  it("changes only the suggested atom's line", () => {
    const master = sampleMaster();
    const result = applySuggestion(
      master,
      metric,
      "  Wrote the on-call runbook and the Terraform for its alerts, cutting pages by half. ",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = sampleMaster();
    expected.atoms = expected.atoms.map((a) =>
      a.id === "atom-3"
        ? {
            ...a,
            sourceQuote:
              "Wrote the on-call runbook and the Terraform for its alerts, cutting pages by half.",
          }
        : a,
    );
    expect(result.master).toEqual(expected);
  });

  it("leaves the master it was given unchanged", () => {
    const master = sampleMaster();
    applySuggestion(master, metric, "Wrote the on-call runbook, cutting pages by half.");
    expect(master).toEqual(sampleMaster());
  });

  it("refuses a suggestion about a role, a term or the whole resume", () => {
    const master = sampleMaster();
    const others: Suggestion[] = [
      { ...metric, id: "missing_date:role-2", kind: "missing_date", target: { roleId: "role-2" } },
      { ...metric, id: "missing_keyword:k8s", kind: "missing_keyword", target: { term: "K8s" } },
      { ...metric, id: "ats:resume", kind: "ats", target: { resume: true } },
    ];
    for (const s of others) {
      expect(applySuggestion(master, s, "Wrote the runbook.")).toEqual({
        ok: false,
        reason: "not_a_line",
      });
    }
  });

  it("refuses an atom the master doesn't have", () => {
    const s: Suggestion = { ...metric, target: { atomId: "atom-99" } };
    expect(applySuggestion(sampleMaster(), s, "Wrote the runbook.")).toEqual({
      ok: false,
      reason: "unknown_atom",
    });
  });

  it("refuses an empty line", () => {
    expect(applySuggestion(sampleMaster(), metric, "  •  ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses a line with a line break or control character", () => {
    for (const text of ["Wrote the runbook.\nEXPERIENCE", "Wrote the\u0007 runbook."]) {
      expect(applySuggestion(sampleMaster(), metric, text)).toEqual({
        ok: false,
        reason: "multi_line",
      });
    }
  });

  it("refuses a line that names another role's employer", () => {
    expect(
      applySuggestion(sampleMaster(), metric, "Wrote the runbook Sample Logistics later adopted."),
    ).toEqual({ ok: false, reason: "names_other_role" });
  });

  it("refuses a line that names another role's title its own role's title doesn't contain", () => {
    const m = sampleMaster();
    m.roles = m.roles.map((r) => (r.id === "role-2" ? { ...r, title: "Data Analyst" } : r));
    expect(applySuggestion(m, metric, "Wrote the runbook as the team's Data Analyst.")).toEqual({
      ok: false,
      reason: "names_other_role",
    });
  });

  it("allows its own role's title words, even when another role's title is part of it", () => {
    // role-1 is "Senior Software Engineer"; role-2's "Software Engineer" is inside it.
    const result = applySuggestion(
      sampleMaster(),
      metric,
      "Wrote the runbook every Software Engineer on call now uses.",
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a line with a year from another role's dates", () => {
    expect(
      applySuggestion(sampleMaster(), metric, "Wrote the runbook in 2017 for the alerts."),
    ).toEqual({ ok: false, reason: "names_other_role" });
  });

  it("refuses a year inside another role's span that its own role doesn't span", () => {
    // role-1 runs from 2021 to now; role-2 from 2017 to 2021.
    expect(
      applySuggestion(sampleMaster(), metric, "Wrote the runbook in 2019 for the alerts."),
    ).toEqual({ ok: false, reason: "names_other_role" });
  });

  it("allows a year inside its own role's span, even when another role spans it too", () => {
    const result = applySuggestion(
      sampleMaster(),
      metric,
      "Wrote the runbook in 2021 for the alerts, used through 2024.",
    );
    expect(result.ok).toBe(true);
  });
});
