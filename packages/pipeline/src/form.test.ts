import type { JobFormQuestion } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { formQuestions } from "./form.js";

// A stored Greenhouse form as the questions a package answers (NS-227 slice 4). Synthetic forms.

let group = 0;
const field = (over: Partial<JobFormQuestion>): JobFormQuestion => ({
  fieldName: "question_1",
  label: "A question",
  required: false,
  kind: "text",
  choices: null,
  group: group++,
  ...over,
});

// Greenhouse's usual top of a form: contact fields, then the resume and cover letter, each a file
// with a paste-in alternative in the same group.
const STANDARD = [
  field({ fieldName: "first_name", label: "First Name", required: true }),
  field({ fieldName: "last_name", label: "Last Name", required: true }),
  field({ fieldName: "email", label: "Email", required: true }),
  field({ fieldName: "phone", label: "Phone" }),
  field({ fieldName: "resume", label: "Resume/CV", required: true, kind: "file", group: 90 }),
  field({
    fieldName: "resume_text",
    label: "Resume/CV",
    required: true,
    kind: "textarea",
    group: 90,
  }),
  field({ fieldName: "cover_letter", label: "Cover Letter", kind: "file", group: 91 }),
  field({ fieldName: "cover_letter_text", label: "Cover Letter", kind: "textarea", group: 91 }),
];

describe("formQuestions", () => {
  it("asks nothing for the standard fields, which the adapter fills from the contact and files", () => {
    expect(formQuestions(STANDARD)).toEqual({
      questions: [],
      coverLetterRequired: false,
      phoneRequired: false,
      unsupported: [],
    });
  });

  it("flags a required cover letter", () => {
    const form = STANDARD.map((q) =>
      q.fieldName.startsWith("cover_letter") ? { ...q, required: true } : q,
    );
    expect(formQuestions(form).coverLetterRequired).toBe(true);
  });

  it("flags a required phone", () => {
    const form = STANDARD.map((q) => (q.fieldName === "phone" ? { ...q, required: true } : q));
    expect(formQuestions(form).phoneRequired).toBe(true);
  });

  it("turns text and select fields into questions, with the option labels as choices", () => {
    const form = [
      ...STANDARD,
      field({
        fieldName: "question_10",
        label: "Why this team?",
        required: true,
        kind: "textarea",
      }),
      field({
        fieldName: "question_11",
        label: "Are you authorized to work in the US?",
        required: true,
        kind: "select",
        choices: [
          { label: "Yes", value: "1" },
          { label: "No", value: "0" },
        ],
      }),
      field({
        fieldName: "question_12[]",
        label: "Which teams interest you?",
        kind: "multi_select",
        choices: [{ label: "Platform", value: "7" }],
      }),
      field({ fieldName: "question_13", label: "LinkedIn Profile" }),
    ];
    expect(formQuestions(form).questions).toEqual([
      {
        fieldName: "question_10",
        label: "Why this team?",
        required: true,
        maxLength: null,
        choices: null,
      },
      {
        fieldName: "question_11",
        label: "Are you authorized to work in the US?",
        required: true,
        maxLength: null,
        choices: ["Yes", "No"],
      },
      {
        fieldName: "question_12[]",
        label: "Which teams interest you?",
        required: false,
        maxLength: null,
        choices: ["Platform"],
      },
      {
        fieldName: "question_13",
        label: "LinkedIn Profile",
        required: false,
        maxLength: null,
        choices: null,
      },
    ]);
  });

  it("asks nothing for a hidden field, even a required one", () => {
    const form = [
      ...STANDARD,
      field({ fieldName: "source_token", label: "Source", kind: "hidden", required: true }),
    ];
    expect(formQuestions(form)).toEqual(formQuestions(STANDARD));
  });

  it("skips an optional upload it can't fill", () => {
    const form = [
      ...STANDARD,
      field({ fieldName: "question_20", label: "Portfolio (PDF)", kind: "file" }),
    ];
    expect(formQuestions(form)).toEqual(formQuestions(STANDARD));
  });

  it("hands a required upload it can't fill to Paul", () => {
    const form = [
      ...STANDARD,
      field({ fieldName: "question_21", label: "Writing sample", kind: "file", required: true }),
    ];
    expect(formQuestions(form).unsupported).toEqual([
      { fieldName: "question_21", reason: "file_upload" },
    ]);
  });
});
