import type { SaveTailoredInput } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { type TailorRunDeps, tailorForJob } from "./run.js";
import { sampleJob, sampleMaster } from "./test/master.js";

// Tailoring a stored job end to end (NS-146). Fakes for the database; the sample master and job.

const JOB_ID = "00000000-0000-4000-8000-000000000001";

function fake(read: Awaited<ReturnType<TailorRunDeps["readInput"]>> | null = null) {
  const saved: Omit<SaveTailoredInput, "candidateId">[] = [];
  const deps: TailorRunDeps = {
    readInput: async () =>
      read ?? {
        ok: true,
        value: {
          profileSourceId: "source-1",
          master: sampleMaster(),
          job: { id: JOB_ID, ...sampleJob() },
        },
      },
    save: async (input) => {
      saved.push(input);
      return { version: saved.length, saved: true };
    },
  };
  return { deps, saved };
}

describe("tailorForJob", () => {
  it("tailors, validates, scores and saves a one-page resume", async () => {
    const { deps, saved } = fake();
    const run = await tailorForJob(deps, JOB_ID, []);
    if (run.kind !== "tailored") throw new Error(run.kind);
    expect([run.pages, run.validation.ok, run.version, saved.length, saved[0]?.jobId]).toEqual([
      1,
      true,
      1,
      1,
      JOB_ID,
    ]);
  });

  it("turns an added skill off before scoring and saving", async () => {
    const { deps, saved } = fake();
    const run = await tailorForJob(deps, JOB_ID, ["terraform"]);
    if (run.kind !== "tailored") throw new Error(run.kind);
    expect([
      run.resume.skills.some((s) => s.name === "Terraform"),
      run.diff.skills.find((s) => s.name === "Terraform")?.status,
      saved[0]?.droppedSkills,
      saved[0]?.summary.droppedSkills,
    ]).toEqual([false, undefined, ["terraform"], 1]);
  });

  it("refuses to turn off a skill the master lists, and saves nothing", async () => {
    const { deps, saved } = fake();
    expect([await tailorForJob(deps, JOB_ID, ["Postgres"]), saved]).toEqual([
      { kind: "bad_toggle", names: ["Postgres"] },
      [],
    ]);
  });

  it("passes on the reader's refusal and saves nothing", async () => {
    const { deps, saved } = fake({ ok: false, error: { kind: "JobNotReady" } });
    expect([await tailorForJob(deps, JOB_ID, []), saved]).toEqual([
      { kind: "refused", reason: "JobNotReady" },
      [],
    ]);
  });

  it("summarizes with counts and flags only", async () => {
    const { deps, saved } = fake();
    await tailorForJob(deps, JOB_ID, []);
    const summary = saved[0]?.summary ?? {};
    const types = Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, typeof v]));
    expect(types).toEqual({
      lines: "number",
      atoms: "number",
      addedSkills: "number",
      droppedSkills: "number",
      notClaimed: "number",
      keywordsCovered: "number",
      keywordsTotal: "number",
      titleMatch: "string",
      atsPass: "boolean",
      valid: "boolean",
      failures: "number",
    });
  });
});
