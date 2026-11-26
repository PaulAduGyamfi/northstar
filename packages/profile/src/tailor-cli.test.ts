import { describe, expect, it } from "vitest";
import type { TailorRun } from "./tailor/run.js";
import { sampleMaster } from "./tailor/test/master.js";
import { parseDrop, tailorCommand } from "./tailor-cli.js";

// `profile tailor` (NS-146). A fake run; synthetic master.

function fake(run: TailorRun) {
  const printed: string[] = [];
  const calls: [string, string[]][] = [];
  return {
    printed,
    calls,
    deps: {
      print: (line: string) => printed.push(line),
      runTailor: async (jobId: string, drop: string[]) => {
        calls.push([jobId, drop]);
        return run;
      },
    },
  };
}

const master = sampleMaster();
const atom = master.atoms[0];

const tailored = (over: Partial<Extract<TailorRun, { kind: "tailored" }>> = {}): TailorRun => ({
  kind: "tailored",
  master,
  resume: { summary: [], sections: [], skills: [], notClaimed: ["Kubernetes (no evidence)"] },
  validation: { ok: true },
  score: {
    title: "partial",
    keywords: { covered: 3, total: 4, missing: ["kubernetes"] },
    ats: { recovered: 0.98, missingHeaders: [], pass: true },
  },
  diff: {
    atoms: [{ atomId: atom?.id ?? "", status: "dropped", reworded: false }],
    skills: [{ name: "Terraform", status: "added" }],
    work: [],
  },
  pages: 1,
  version: 2,
  saved: true,
  ...over,
});

describe("profile tailor", () => {
  it("prints the diff, not-claimed requirements, the score and the saved version", async () => {
    const { deps, printed } = fake(tailored());
    expect(await tailorCommand(deps, "job-1", [])).toBe(0);
    expect(printed).toEqual([
      "Lines: 0 of 1 atoms, 1 page",
      `  dropped: ${atom?.what}`,
      "  skill added: Terraform",
      "Not claimed: Kubernetes (no evidence)",
      "Pre-send: title partial, keywords 3/4, ATS re-parse pass (98%)",
      "Missing keywords: kubernetes",
      "Every line cites an atom.",
      "Saved as version 2.",
    ]);
  });

  it("says when nothing changed since the last version", async () => {
    const { deps, printed } = fake(tailored({ saved: false }));
    await tailorCommand(deps, "job-1", []);
    expect(printed.at(-1)).toBe("Unchanged since version 2.");
  });

  it("exits 1 and lists the problems when validation fails", async () => {
    const { deps, printed } = fake(
      tailored({ validation: { ok: false, failures: [{ item: "line 1", problem: "no atom" }] } }),
    );
    expect(await tailorCommand(deps, "job-1", [])).toBe(1);
    expect(printed).toContain("Problem: line 1: no atom");
  });

  it("names a refused job plainly", async () => {
    const { deps, printed } = fake({ kind: "refused", reason: "JobNotReady" });
    expect(await tailorCommand(deps, "job-1", [])).toBe(1);
    expect(printed).toEqual(["That job is a draft: give it a title and company first (jobs set)."]);
  });

  it("refuses to drop a skill the master lists", async () => {
    const { deps, printed } = fake({ kind: "bad_toggle", names: ["Postgres"] });
    expect(await tailorCommand(deps, "job-1", ["Postgres"])).toBe(1);
    expect(printed).toEqual([
      "Not tailored: only skills the tailor added can be turned off (Postgres).",
    ]);
  });
});

describe("parseDrop", () => {
  it("reads a comma list after --drop and refuses anything else", () => {
    expect([
      parseDrop([]),
      parseDrop(["--drop", "Terraform, Kafka"]),
      parseDrop(["--drop"]),
      parseDrop(["--drop", " , "]),
      parseDrop(["--keep", "Go"]),
    ]).toEqual([[], ["Terraform", "Kafka"], undefined, undefined, undefined]);
  });
});
