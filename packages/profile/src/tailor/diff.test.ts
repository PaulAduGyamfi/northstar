import { describe, expect, it } from "vitest";
import { applySkillToggles, diffResume } from "./diff.js";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";

const master = sampleMaster();

describe("diffResume", () => {
  it("reports each atom as kept, moved or dropped against the master", () => {
    const resume = tailorResume(master, sampleJob(), { maxLines: 4 });
    expect(diffResume(master, resume).atoms).toEqual([
      { atomId: "atom-1", status: "kept", reworded: false },
      // atom-3 moved up past atom-2 inside its role.
      { atomId: "atom-2", status: "moved", reworded: false },
      { atomId: "atom-3", status: "moved", reworded: false },
      { atomId: "atom-4", status: "kept", reworded: false },
      { atomId: "atom-5", status: "dropped", reworded: false },
    ]);
  });

  it("flags a line whose text differs from its atom's resume line as reworded", () => {
    const resume = tailorResume(master, sampleJob());
    const second = resume.sections[1];
    if (second) second.lines = [{ text: "Built a Python route planner.", atomIds: ["atom-4"] }];
    expect(diffResume(master, resume).atoms[3]).toEqual({
      atomId: "atom-4",
      status: "kept",
      reworded: true,
    });
  });

  it("reports added, kept and removed skills", () => {
    const resume = tailorResume(master, sampleJob());
    resume.skills = resume.skills.filter((s) => s.name !== "Kafka");
    expect(diffResume(master, resume).skills).toEqual([
      { name: "Terraform", status: "added" },
      { name: "Postgres", status: "kept" },
      { name: "Python", status: "kept" },
      { name: "Go", status: "kept" },
      { name: "Kafka", status: "removed" },
    ]);
  });
});

describe("applySkillToggles", () => {
  it("drops an added skill Paul turned off", () => {
    const resume = applySkillToggles(tailorResume(master, sampleJob()), ["terraform"]);
    expect(resume.skills.map((s) => s.name)).toEqual(["Postgres", "Python", "Go", "Kafka"]);
  });

  it("refuses to drop a master skill", () => {
    expect(() => applySkillToggles(tailorResume(master, sampleJob()), ["Go"])).toThrow(
      "toggle 0 is not an added skill",
    );
  });
});
