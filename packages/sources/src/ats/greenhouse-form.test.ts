import { describe, expect, it } from "vitest";
import { fakeWeb } from "../test/fake-web.js";
import { readGreenhouseForm } from "./greenhouse-form.js";

// A Greenhouse posting's application questions (NS-227), from a synthetic answer shaped like the
// public job-board API's `?questions=true` (invented board, posting and questions).
const URL = "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345?questions=true";
const TARGET = { board: "globex", postingId: "4012345" };

const field = (name: string, type: string, values: { label: string; value: number }[] = []) => ({
  name,
  type,
  values,
});

const POSTING = {
  id: 4012345,
  title: "Backend Engineer",
  questions: [
    {
      required: true,
      label: "First Name",
      description: null,
      fields: [field("first_name", "input_text")],
    },
    {
      required: true,
      label: "Resume/CV",
      description: null,
      fields: [field("resume", "input_file"), field("resume_text", "textarea")],
    },
    {
      required: false,
      label: "Cover Letter",
      description: null,
      fields: [field("cover_letter", "input_file")],
    },
    {
      required: true,
      label: "Are you authorized to work in the US?",
      description: null,
      fields: [
        field("question_111", "multi_value_single_select", [
          { label: "Yes", value: 1 },
          { label: "No", value: 0 },
        ]),
      ],
    },
    {
      required: false,
      label: "Which teams interest you?",
      description: null,
      fields: [
        field("question_222[]", "multi_value_multi_select", [{ label: "Platform", value: 7 }]),
      ],
    },
    {
      required: false,
      label: "Source",
      description: null,
      fields: [field("source_token", "input_hidden")],
    },
  ],
  location_questions: [],
  compliance: [{ type: "eeoc", questions: [] }],
};

describe("readGreenhouseForm", () => {
  it("maps every field kind, keeping each question's group, requiredness and choices", async () => {
    const web = fakeWeb({ [URL]: { body: POSTING } });
    expect([await readGreenhouseForm(web.deps, TARGET), web.asked]).toEqual([
      [
        {
          fieldName: "first_name",
          label: "First Name",
          required: true,
          kind: "text",
          choices: null,
          group: 0,
        },
        {
          fieldName: "resume",
          label: "Resume/CV",
          required: true,
          kind: "file",
          choices: null,
          group: 1,
        },
        {
          fieldName: "resume_text",
          label: "Resume/CV",
          required: true,
          kind: "textarea",
          choices: null,
          group: 1,
        },
        {
          fieldName: "cover_letter",
          label: "Cover Letter",
          required: false,
          kind: "file",
          choices: null,
          group: 2,
        },
        {
          fieldName: "question_111",
          label: "Are you authorized to work in the US?",
          required: true,
          kind: "select",
          choices: [
            { label: "Yes", value: "1" },
            { label: "No", value: "0" },
          ],
          group: 3,
        },
        {
          fieldName: "question_222[]",
          label: "Which teams interest you?",
          required: false,
          kind: "multi_select",
          choices: [{ label: "Platform", value: "7" }],
          group: 4,
        },
        {
          fieldName: "source_token",
          label: "Source",
          required: false,
          kind: "hidden",
          choices: null,
          group: 5,
        },
      ],
      [URL],
    ]);
  });

  it("reads nothing from a field type it doesn't know, rather than guessing", async () => {
    const odd = {
      ...POSTING,
      questions: [{ required: true, label: "Signature", fields: [field("sig", "signature_pad")] }],
    };
    const web = fakeWeb({ [URL]: { body: odd } });
    expect(await readGreenhouseForm(web.deps, TARGET)).toBeNull();
  });

  it("never takes an object's built-in name for a field type", async () => {
    const odd = {
      ...POSTING,
      questions: [{ required: true, label: "Odd", fields: [field("x", "constructor")] }],
    };
    const web = fakeWeb({ [URL]: { body: odd } });
    expect(await readGreenhouseForm(web.deps, TARGET)).toBeNull();
  });

  it("reads nothing when the API doesn't answer 200 or the answer isn't a posting", async () => {
    const missing = fakeWeb({});
    const garbled = fakeWeb({ [URL]: { body: { questions: "no" } } });
    expect([
      await readGreenhouseForm(missing.deps, TARGET),
      await readGreenhouseForm(garbled.deps, TARGET),
    ]).toEqual([null, null]);
  });

  it("asks for the posting by its encoded board and id", async () => {
    const web = fakeWeb({});
    await readGreenhouseForm(web.deps, { board: "a b", postingId: "4/2" });
    expect(web.asked).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/a%20b/jobs/4%2F2?questions=true",
    ]);
  });
});
