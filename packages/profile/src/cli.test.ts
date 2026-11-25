import type { ProfileView } from "@northstar/db";
import { LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "./cli.js";
import type { ImportResult } from "./import.js";
import { SAMPLE_RESUME } from "./test/sample.js";

const record = {
  route: "profile-extract",
  promptId: "profile-extract",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 2000,
  outputTokens: 900,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 4000,
  costUsd: 0.026,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

function deps(argv: string[], result: ImportResult | Error, view: ProfileView | null = null) {
  const printed: string[] = [];
  const d: CliDeps = {
    argv,
    print: (line) => printed.push(line),
    readText: async () => SAMPLE_RESUME,
    runImport: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    readProfile: async () => view,
  };
  return { d, printed };
}

describe("profile cli", () => {
  it("imports a resume and prints counts, cost and nothing from the resume", async () => {
    const { d, printed } = deps(["import-resume", "data/resume.pdf"], {
      kind: "imported",
      sourceId: "s1",
      counts: { roles: 2, education: 1, atoms: 3, skills: 4, certifications: 1, links: 2 },
      record,
    });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Imported resume.pdf: 2 roles, 1 education, 3 atoms, 4 skills, 1 certifications, 2 links.",
      "Model claude-opus-5-5, prompt v1, 2000 in / 900 out tokens, $0.026.",
      "Run `show` to read it back.",
    ]);
    expect(printed.join("\n")).not.toContain("idempotent");
  });

  it("says when the resume hasn't changed, and spends nothing", async () => {
    const { d, printed } = deps(["import-resume", "data/resume.pdf"], { kind: "unchanged" });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual(["resume.pdf is unchanged since the last import. Nothing to do."]);
  });

  it("lists provenance failures by item and problem, and exits 1", async () => {
    const { d, printed } = deps(["import-resume", "data/resume.pdf"], {
      kind: "rejected",
      failures: [{ item: "atom", index: 0, problem: "number_not_in_quote" }],
      record,
    });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Not imported: the extraction said something the resume doesn't. Nothing was written.",
      "  atom 0: number_not_in_quote",
      "Re-run to try again, or check that resume line.",
    ]);
  });

  it("reports a refusal or a cut-off answer without writing anything", async () => {
    const { d, printed } = deps(["import-resume", "data/resume.pdf"], {
      kind: "model",
      outcome: "Truncated",
      record,
    });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Not imported: the model's answer was Truncated. Nothing was written.",
    ]);
  });

  it("tells you to retry when the API is down", async () => {
    const { d, printed } = deps(
      ["import-resume", "data/resume.pdf"],
      new LlmTransportError({ status: 529, retryable: true }),
    );
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Not imported: the Claude API didn't answer (status 529). Nothing was written; try again later.",
    ]);
  });

  it("never prints a database error's details, which can hold resume text", async () => {
    const dbError = Object.assign(new Error('new row violates check constraint "x"'), {
      name: "DatabaseError",
      code: "23514",
      constraint: "experience_atom_evidence_link_http",
      detail: "Failing row contains (Made payment retries idempotent, Example Payments).",
    });
    const { d, printed } = deps(["import-resume", "data/resume.pdf"], dbError);
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Not imported: DatabaseError (code 23514, constraint experience_atom_evidence_link_http). Nothing was written.",
    ]);
    expect(printed.join("\n")).not.toContain("idempotent");
  });

  it("--reimport asks for a fresh extraction even when the file is unchanged", async () => {
    const seen: boolean[] = [];
    const { d } = deps(["import-resume", "data/resume.pdf", "--reimport"], { kind: "unchanged" });
    d.runImport = async (_name, _text, options) => {
      seen.push(options.reimport);
      return { kind: "unchanged" };
    };
    await main(d);
    expect(seen).toEqual([true]);
  });

  it("shows the current profile", async () => {
    const { d, printed } = deps(
      ["show"],
      { kind: "unchanged" },
      {
        roles: [
          {
            employer: "Example Payments",
            title: "Senior Engineer",
            startMonth: "2021-03",
            endMonth: null,
            current: true,
            atoms: ["Made payment retries idempotent"],
          },
          {
            employer: "Sample Logistics",
            title: "Engineer",
            startMonth: "2017",
            endMonth: null,
            current: false,
            atoms: [],
          },
        ],
        unassignedAtoms: ["Built a side project"],
        skills: ["Go", "Postgres"],
      },
    );
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Example Payments · Senior Engineer · 2021-03 – present (locked)",
      "  - Made payment retries idempotent",
      // Not current and no end date stated: unknown, never "present".
      "Sample Logistics · Engineer · 2017 – ? (locked)",
      "Other",
      "  - Built a side project",
      "Skills: Go, Postgres",
    ]);
  });

  it("says when there is no profile yet", async () => {
    const { d, printed } = deps(["show"], { kind: "unchanged" }, null);
    expect(await main(d)).toBe(0);
    expect(printed).toEqual(["No resume imported yet. Run: import-resume <path>"]);
  });

  it("prints usage for anything else", async () => {
    const { d, printed } = deps([], { kind: "unchanged" });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual(["usage: profile import-resume <path> [--reimport] | profile show"]);
  });
});
