import { describe, expect, it } from "vitest";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";

const ids = (r: ReturnType<typeof tailorResume>) =>
  r.sections.map((s) => [s.roleId, s.lines.map((l) => l.atomIds.join("+"))]);

describe("tailorResume", () => {
  it("leaves a skill no atom proves out of the resume and notes it as not claimed", () => {
    const resume = tailorResume(sampleMaster(), sampleJob());
    const text = JSON.stringify([resume.summary, resume.sections, resume.skills]);
    expect(text.includes("Kubernetes")).toBe(false);
    expect(resume.notClaimed).toEqual(["not claimed: Kubernetes (no evidence)"]);
  });

  it("puts atoms the job asks for first inside a role and keeps roles in resume order", () => {
    const resume = tailorResume(sampleMaster(), sampleJob());
    expect(ids(resume)).toEqual([
      // atom-1 (Postgres) and atom-3 (Terraform) each meet one must-have; resume order breaks
      // the tie. atom-2 meets nothing.
      ["role-1", ["atom-1", "atom-3", "atom-2"]],
      ["role-2", ["atom-4"]],
      [null, ["atom-5"]],
    ]);
  });

  it("uses each atom's own resume line verbatim without its bullet marker", () => {
    const resume = tailorResume(sampleMaster(), sampleJob());
    expect(resume.sections[1]?.lines).toEqual([
      {
        text: "Built a route planner in Python that cut planning time by 35%.",
        atomIds: ["atom-4"],
      },
    ]);
  });

  it("drops the least relevant atoms past the line budget and keeps every role", () => {
    const resume = tailorResume(sampleMaster(), sampleJob(), { maxLines: 3 });
    expect(ids(resume)).toEqual([
      ["role-1", ["atom-1", "atom-3"]],
      ["role-2", ["atom-4"]],
      [null, []],
    ]);
  });

  it("drops the atom further down the resume first when relevance ties", () => {
    const resume = tailorResume(
      sampleMaster(),
      { title: null, requirements: [], niceToHaves: [] },
      {
        maxLines: 2,
      },
    );
    expect(ids(resume)).toEqual([
      ["role-1", ["atom-1", "atom-2"]],
      ["role-2", []],
      [null, []],
    ]);
  });

  it("adds a skill the job asks for when an atom proves it, citing that atom", () => {
    const resume = tailorResume(sampleMaster(), sampleJob());
    expect(resume.skills).toEqual([
      // The job's order first (Terraform, then Postgres, then Python), then the rest.
      { name: "Terraform", atomIds: ["atom-3"], added: true },
      { name: "Postgres", atomIds: [], added: false },
      { name: "Python", atomIds: [], added: false },
      { name: "Go", atomIds: [], added: false },
      { name: "Kafka", atomIds: [], added: false },
    ]);
  });

  it("writes no summary line", () => {
    expect(tailorResume(sampleMaster(), sampleJob()).summary).toEqual([]);
  });

  it("tailors the same inputs to the same resume", () => {
    expect(tailorResume(sampleMaster(), sampleJob())).toEqual(
      tailorResume(sampleMaster(), sampleJob()),
    );
  });

  it("counts a skill the master's skills list names as claimed, even with no atom behind it", () => {
    const master = { ...sampleMaster(), skills: [...sampleMaster().skills, "Rust"] };
    const job = { title: null, requirements: ["Rust", "Kubernetes"], niceToHaves: [] };
    expect(tailorResume(master, job).notClaimed).toEqual(["not claimed: Kubernetes (no evidence)"]);
  });

  it("gives a master with no atoms its role headers and skills and claims nothing", () => {
    const bare = { ...sampleMaster(), atoms: [] };
    const resume = tailorResume(bare, { ...sampleJob(), requirements: ["Terraform"] });
    expect([resume.sections, resume.notClaimed]).toEqual([
      [
        { roleId: "role-1", lines: [] },
        { roleId: "role-2", lines: [] },
      ],
      ["not claimed: Terraform (no evidence)"],
    ]);
  });
});
