import type { ProfileView, StoryView } from "@northstar/db";
import { LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "./cli.js";
import type { ImportResult } from "./import.js";
import type { InterviewOutcome } from "./interview.js";
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

function deps(
  argv: string[],
  result: ImportResult | Error,
  view: ProfileView | null = null,
  story: { interview?: InterviewOutcome | Error; stories?: StoryView[] } = {},
) {
  const printed: string[] = [];
  const interviewedAtoms: (string | undefined)[] = [];
  const d: CliDeps = {
    argv,
    print: (line) => printed.push(line),
    readText: async () => SAMPLE_RESUME,
    runImport: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    readProfile: async () => view,
    runInterview: async (atomId) => {
      interviewedAtoms.push(atomId);
      const outcome = story.interview ?? { kind: "no_atoms" };
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    readStories: async () => story.stories ?? [],
  };
  return { d, printed, interviewedAtoms };
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

  it("names the database error inside a Drizzle query error, without its query or values", async () => {
    // Drizzle wraps the pg error: its own name stays "Error" and its message holds the query and
    // parameters, which can be Paul's answers. The code and constraint sit on the cause.
    const cause = Object.assign(new Error('relation "story_interview" does not exist'), {
      name: "DatabaseError",
      code: "42P01",
    });
    const wrapped = Object.assign(
      new Error("Failed query: select ... params: I paired with the dispatch lead"),
      { cause },
    );
    const { d, printed } = deps(["interview"], new Error("unused"), null, { interview: wrapped });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "Interview stopped: DatabaseError (code 42P01). Answers given so far are saved.",
    ]);
    expect(printed.join("\n")).not.toContain("dispatch lead");
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
    expect(printed).toEqual([
      "usage: profile import-resume <path> [--reimport] | profile show | profile interview [--atom <id>] | profile stories",
    ]);
  });

  it("interview prints the summed cost of every call after an approved story, and no story text", async () => {
    const { d, printed } = deps(["interview"], new Error("unused"), null, {
      interview: {
        kind: "approved",
        storyId: "story-1",
        // A follow-up round: two calls, both counted.
        records: [
          { ...record, route: "story-draft" },
          { ...record, route: "story-draft", inputTokens: 1000, outputTokens: 100, costUsd: 0.004 },
        ],
      },
    });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Model claude-opus-5-5, prompt v1, 2 call(s), 3000 in / 1000 out tokens, $0.03.",
      "Run `profile interview` for the next atom, or `profile stories` to read them back.",
    ]);
  });

  it("interview --atom passes the atom id through", async () => {
    const id = "8c0b3a52-4c4e-4c41-9d1e-0e6f6f3b9a01";
    const { d, interviewedAtoms } = deps(["interview", "--atom", id], new Error("unused"), null, {
      interview: { kind: "skipped" },
    });
    expect(await main(d)).toBe(0);
    expect(interviewedAtoms).toEqual([id]);
  });

  it("interview reports an unknown atom id", async () => {
    const { d, printed } = deps(["interview", "--atom", "nope"], new Error("unused"), null, {
      interview: { kind: "atom_not_found" },
    });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual(["No atom with that id in your profile."]);
  });

  it("interview says answers are saved when the Claude API is down", async () => {
    const { d, printed } = deps(["interview"], new Error("unused"), null, {
      interview: new LlmTransportError({ status: 529, retryable: true }),
    });
    expect(await main(d)).toBe(1);
    expect(printed).toEqual([
      "The Claude API didn't answer (status 529). Your answers are saved; run `profile interview` again later.",
    ]);
  });

  it("stories lists approved stories and the competencies with none yet", async () => {
    const stories: StoryView[] = [
      {
        id: "story-1",
        title: "Routing around closures",
        situation: "Routes ignored closures.",
        task: "I owned the planner.",
        action: "I added a closures feed.",
        result: "Late deliveries went from 12% to 3%.",
        competencies: ["ownership", "scale"],
        atomIds: ["atom-1"],
      },
    ];
    const { d, printed } = deps(["stories"], new Error("unused"), null, { stories });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Routing around closures [ownership, scale]",
      "  Situation: Routes ignored closures.",
      "  Task: I owned the planner.",
      "  Action: I added a closures feed.",
      "  Result: Late deliveries went from 12% to 3%.",
      "No story yet for: leadership, conflict, ambiguity, failure, collaboration, technical-depth, customer-impact, learning",
    ]);
  });

  it("stories says how to start when the bank is empty", async () => {
    const { d, printed } = deps(["stories"], new Error("unused"));
    expect(await main(d)).toBe(0);
    expect(printed[0]).toBe("No stories yet. Run: profile interview");
  });
});
