import { describe, expect, it } from "vitest";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";
import type { TailoredResume } from "./types.js";
import { validateTailoredResume } from "./validate.js";

const master = sampleMaster();
const job = sampleJob();
const tailored = (): TailoredResume => tailorResume(master, job);
const terms = [...job.requirements, "Kubernetes"];

// The resume with role-1's first line replaced.
function withLine(text: string, atomIds: string[]): TailoredResume {
  const r = tailored();
  const [first] = r.sections;
  if (first) first.lines[0] = { text, atomIds };
  return r;
}

describe("validateTailoredResume", () => {
  it("passes the tailor's own output", () => {
    expect(validateTailoredResume(tailored(), master, { terms })).toEqual({ ok: true });
  });

  it("blocks a line that cites no atom", () => {
    expect(validateTailoredResume(withLine("Shipped things.", []), master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "cites no atom" }],
    });
  });

  it("blocks a line that cites an atom the master doesn't have", () => {
    expect(validateTailoredResume(withLine("Shipped things.", ["atom-9"]), master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "cites unknown atom 0" }],
    });
  });

  it("blocks a line that cites an atom of another role", () => {
    const text = "Built a route planner in Python that cut planning time by 35%.";
    const r = withLine(text, ["atom-4"]);
    // Remove atom-4's own line so the duplicate rule doesn't also fire.
    const second = r.sections[1];
    if (second) second.lines = [];
    expect(validateTailoredResume(r, master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "cites atom 0 from another section" }],
    });
  });

  it("blocks a section for a role the master doesn't have", () => {
    const r = tailored();
    r.sections.push({ roleId: "role-9", lines: [] });
    expect(validateTailoredResume(r, master)).toEqual({
      ok: false,
      failures: [{ item: "section 3", problem: "unknown role" }],
    });
  });

  it("blocks a line with a number its atoms don't state", () => {
    const text = "Made payment retries idempotent in Go and Postgres for 3 million users.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "number 3 is not in its atoms" }],
    });
  });

  it("blocks a line naming a master skill its atoms don't name", () => {
    const text = "Made payment retries idempotent in Go, Kafka and Postgres.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "term Kafka is not in its atoms" }],
    });
  });

  it("blocks a line naming a job keyword no atom names", () => {
    const text = "Made payment retries idempotent in Go and Postgres on Kubernetes.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, { terms })).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "term Kubernetes is not in its atoms" }],
    });
  });

  it("blocks a summary line without provenance", () => {
    const r = tailored();
    r.summary = [{ text: "Platform engineer with Kubernetes depth.", atomIds: ["atom-1"] }];
    expect(validateTailoredResume(r, master, { terms })).toEqual({
      ok: false,
      failures: [{ item: "summary line 0", problem: "term Kubernetes is not in its atoms" }],
    });
  });

  it("blocks the same atom on two experience lines", () => {
    const r = tailored();
    const first = r.sections[0];
    if (first) first.lines.push({ text: "Made payment retries idempotent.", atomIds: ["atom-1"] });
    expect(validateTailoredResume(r, master)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 3", problem: "atom 0 is already on another line" }],
    });
  });

  it("blocks an added skill no cited atom names", () => {
    const r = tailored();
    r.skills.push({ name: "Kubernetes", atomIds: ["atom-1"], added: true });
    expect(validateTailoredResume(r, master)).toEqual({
      ok: false,
      failures: [{ item: "skill 5", problem: "not a master skill and not named by its atoms" }],
    });
  });

  it("blocks a skill that cites an unknown atom", () => {
    const r = tailored();
    r.skills.push({ name: "Go", atomIds: ["atom-9"], added: false });
    expect(validateTailoredResume(r, master)).toEqual({
      ok: false,
      failures: [{ item: "skill 5", problem: "cites unknown atom 0" }],
    });
  });
});
