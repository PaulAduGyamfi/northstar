import { describe, expect, it } from "vitest";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";
import type { TailoredResume } from "./types.js";
import { TailoredResume as TailoredResumeSchema } from "./types.js";
import { validateTailoredResume } from "./validate.js";

const master = sampleMaster();
const job = sampleJob();
const tailored = (): TailoredResume => tailorResume(master, job);

// The resume with role-1's first line replaced.
function withLine(text: string, atomIds: string[]): TailoredResume {
  const r = tailored();
  const [first] = r.sections;
  if (first) first.lines[0] = { text, atomIds };
  return r;
}

describe("validateTailoredResume", () => {
  it("passes the tailor's own output", () => {
    expect(validateTailoredResume(tailored(), master, job)).toEqual({ ok: true });
  });

  it("blocks a line that cites no atom", () => {
    expect(validateTailoredResume(withLine("Shipped things.", []), master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "cites no atom" }],
    });
  });

  it("blocks a line that cites an atom the master doesn't have", () => {
    expect(validateTailoredResume(withLine("Shipped things.", ["atom-9"]), master, job)).toEqual({
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
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "cites atom 0 from another section" }],
    });
  });

  it("blocks a section for a role the master doesn't have", () => {
    const r = tailored();
    r.sections.push({ roleId: "role-9", lines: [] });
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 3", problem: "unknown role" }],
    });
  });

  it("blocks a line with a number its atoms don't state", () => {
    const text = "Made payment retries idempotent in Go and Postgres for 3 million users.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "number 3 is not in its atoms" }],
    });
  });

  it("blocks a line naming a master skill its atoms don't name", () => {
    const text = "Made payment retries idempotent in Go, Kafka and Postgres.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "term Kafka is not in its atoms" }],
    });
  });

  it("blocks a line naming a job keyword no atom names without being told the keyword", () => {
    const text = "Made payment retries idempotent in Go and Postgres on Kubernetes.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "term Kubernetes is not in its atoms" }],
    });
  });

  it("blocks a summary line without provenance", () => {
    const r = tailored();
    r.summary = [{ text: "Platform engineer with Kubernetes depth.", atomIds: ["atom-1"] }];
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "summary line 0", problem: "term Kubernetes is not in its atoms" }],
    });
  });

  it("blocks the same atom on two experience lines", () => {
    const r = tailored();
    const first = r.sections[0];
    if (first) first.lines.push({ text: "Made payment retries idempotent.", atomIds: ["atom-1"] });
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 3", problem: "atom 0 is already on another line" }],
    });
  });

  it("blocks an added skill no cited atom names", () => {
    const r = tailored();
    r.skills.push({ name: "Kubernetes", atomIds: ["atom-1"], added: true });
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "skill 5", problem: "not a master skill and not named by its atoms" }],
    });
  });

  it("blocks a skill that cites an unknown atom", () => {
    const r = tailored();
    r.skills.push({ name: "Go", atomIds: ["atom-9"], added: false });
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "skill 5", problem: "cites unknown atom 0" }],
    });
  });

  it("blocks a technology named inside a requirement sentence", () => {
    const sentenceJob = {
      title: null,
      requirements: ["Experience with Kubernetes"],
      niceToHaves: [],
    };
    const text = "Made payment retries idempotent in Go and Postgres on Kubernetes.";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, sentenceJob)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "term Kubernetes is not in its atoms" }],
    });
  });

  it("blocks a line with a line break that could fake a header", () => {
    const text = "Made payment retries idempotent.\n\nEXPERIENCE";
    expect(validateTailoredResume(withLine(text, ["atom-1"]), master, job)).toEqual({
      ok: false,
      failures: [{ item: "section 0 line 0", problem: "has a line break or control character" }],
    });
  });

  it("blocks a line using digits other than 0-9", () => {
    const text = "Led a team of \u0664 engineers through the ledger migration.";
    expect(validateTailoredResume(withLine(text, ["atom-2"]), master, job)).toEqual({
      ok: false,
      failures: [
        { item: "section 0 line 0", problem: "uses digits other than 0-9" },
        { item: "section 0 line 2", problem: "atom 0 is already on another line" },
      ],
    });
  });

  it("blocks a resume that leaves a role out", () => {
    const r = tailored();
    r.sections = r.sections.filter((s) => s.roleId !== "role-2");
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "role 1", problem: "has no section" }],
    });
  });

  it("blocks a resume that repeats a role", () => {
    const r = tailored();
    r.sections.push({ roleId: "role-1", lines: [] });
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "role 0", problem: "has more than one section" }],
    });
  });

  it("blocks a resume that swaps roles out of resume order", () => {
    const r = tailored();
    const [first, second, ...rest] = r.sections;
    if (first && second) r.sections = [second, first, ...rest];
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "sections", problem: "roles are out of resume order" }],
    });
  });

  it("blocks a master skill marked as added", () => {
    const r = tailored();
    const go = r.skills.find((s) => s.name === "Go");
    if (go) go.added = true;
    expect(validateTailoredResume(r, master, job)).toEqual({
      ok: false,
      failures: [{ item: "skill 3", problem: "added flag doesn't match the master" }],
    });
  });

  it("passes the tailor's output for an empty job and a one-line budget", () => {
    const empty = { title: null, requirements: [], niceToHaves: [] };
    const r = tailorResume(master, empty, { maxLines: 1 });
    expect(validateTailoredResume(r, master, empty)).toEqual({ ok: true });
  });

  it("passes the tailor's output for a master with no atoms", () => {
    const bare = { ...sampleMaster(), atoms: [] };
    expect(validateTailoredResume(tailorResume(bare, job), bare, job)).toEqual({ ok: true });
  });
});

describe("TailoredResume schema", () => {
  it("refuses a line with a line break", () => {
    const r = withLine("Made payment retries idempotent.\nEXPERIENCE", ["atom-1"]);
    expect(TailoredResumeSchema.safeParse(r).success).toBe(false);
  });
});
