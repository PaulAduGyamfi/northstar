import type { JobFormQuestion, SaveJobFormResult } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { FORM_USAGE, type FormCliDeps, formCommand } from "./form-cli.js";

// `jobs form <job-id>` (NS-227) with every dependency faked. Invented board, job and questions.

const GH = "https://boards.greenhouse.io/globex/jobs/4012345";
const Q = (over: Partial<JobFormQuestion>): JobFormQuestion => ({
  fieldName: "first_name",
  label: "First Name",
  required: true,
  kind: "text",
  choices: null,
  group: 0,
  ...over,
});
const FORM = [
  Q({}),
  Q({ fieldName: "resume", label: "Resume/CV", kind: "file", group: 1 }),
  Q({ fieldName: "resume_text", label: "Resume/CV", kind: "textarea", group: 1 }),
  Q({ fieldName: "phone", label: "Phone", required: false, group: 2 }),
];

function deps(over: Partial<FormCliDeps> = {}) {
  const printed: string[] = [];
  const asked: { board: string; postingId: string }[] = [];
  const saved: JobFormQuestion[][] = [];
  const d: FormCliDeps & { print: (line: string) => void } = {
    print: (line) => printed.push(line),
    sources: async () => [
      { ats: "lever", url: "https://jobs.lever.co/globex/0c9a4b1e-1111-4222-8333-444455556666" },
      { ats: "greenhouse", url: GH },
    ],
    readGreenhouse: async (t) => {
      asked.push(t);
      return FORM;
    },
    save: async (_jobId, questions): Promise<SaveJobFormResult> => {
      saved.push(questions);
      return { status: "stored", questions: questions.length };
    },
    ...over,
  };
  return { d, printed, asked, saved };
}

describe("jobs form", () => {
  it("reads the Greenhouse form, stores it and names the required questions once each", async () => {
    const { d, printed, asked, saved } = deps();
    expect([await formCommand(d, ["form", "j1"]), asked, saved.length, printed]).toEqual([
      0,
      [{ board: "globex", postingId: "4012345" }],
      1,
      ["Stored job j1's form: 3 questions, 4 fields.", "Required: First Name; Resume/CV"],
    ]);
  });

  it("says when the form is unchanged", async () => {
    const { d, printed } = deps({
      save: async () => ({ status: "unchanged", questions: 4 }),
    });
    await formCommand(d, ["form", "j1"]);
    expect(printed[0]).toBe("Job j1's form is unchanged: 3 questions, 4 fields.");
  });

  it("refuses a job with no Greenhouse link, asking nothing", async () => {
    const { d, printed, asked } = deps({ sources: async () => [] });
    expect([await formCommand(d, ["form", "j1"]), asked, printed]).toEqual([
      1,
      [],
      [
        "Job j1 has no Greenhouse link. Only Greenhouse publishes its application questions; other forms wait for the browser driver.",
      ],
    ]);
  });

  it("stores nothing when the form can't be read or is over its bounds", async () => {
    const unread = deps({ readGreenhouse: async () => null });
    const big = deps({ save: async () => ({ status: "refused", reason: "too_many_fields" }) });
    const long = deps({ save: async () => ({ status: "refused", reason: "text_too_long" }) });
    expect([
      await formCommand(unread.d, ["form", "j1"]),
      unread.saved.length,
      unread.printed,
      await formCommand(big.d, ["form", "j1"]),
      big.printed,
      await formCommand(long.d, ["form", "j1"]),
      long.printed,
    ]).toEqual([
      1,
      0,
      [
        "Couldn't read the form: Greenhouse didn't answer, or the form has a field type Northstar doesn't know. Nothing stored.",
      ],
      1,
      ["Not stored: it has more than 200 fields."],
      1,
      ["Not stored: a label, field name or choice is longer than 1,000 characters."],
    ]);
  });

  it("leaves other commands alone and prints its own usage for a bad form command", async () => {
    const { d, printed } = deps();
    expect([
      await formCommand(d, ["list"]),
      await formCommand(d, ["form"]),
      await formCommand(d, ["form", "j1", "extra"]),
      printed,
    ]).toEqual([null, 1, 1, [FORM_USAGE, FORM_USAGE]]);
  });
});
