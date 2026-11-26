import type { JobFormQuestion } from "@northstar/db";
import type { FormQuestion } from "./assemble.js";

// A stored Greenhouse form (NS-227 slice 1) as the questions a package answers (slice 4,
// APPLY-001). Plain code: the labels and choices are the employer's text, only compared here.

// Fields the Greenhouse adapter fills itself (packages/gateways, adapters/greenhouse.ts: its
// standard fields, resume field and cover letter field), plus the paste-in text alternatives that
// share a question with the two files. None of them is a question for the package to answer.
const CONTACT_FIELDS = new Set(["first_name", "last_name", "email", "phone"]);
const RESUME_FIELDS = new Set(["resume", "resume_text"]);
const COVER_LETTER_FIELDS = new Set(["cover_letter", "cover_letter_text"]);

export type FormQuestions = {
  questions: FormQuestion[];
  // The form requires a cover letter; no drafting exists, so assemblePackage makes it NeedsHuman.
  coverLetterRequired: boolean;
  // The form requires a phone: the caller stops when Paul has none stored.
  phoneRequired: boolean;
  // Required fields Northstar can't fill (an upload other than the resume or cover letter).
  unsupported: { fieldName: string; reason: "file_upload" }[];
};

export function formQuestions(form: readonly JobFormQuestion[]): FormQuestions {
  const result: FormQuestions = {
    questions: [],
    coverLetterRequired: false,
    phoneRequired: false,
    unsupported: [],
  };
  for (const q of form) {
    if (COVER_LETTER_FIELDS.has(q.fieldName)) {
      if (q.required) result.coverLetterRequired = true;
      continue;
    }
    if (q.fieldName === "phone" && q.required) result.phoneRequired = true;
    if (CONTACT_FIELDS.has(q.fieldName) || RESUME_FIELDS.has(q.fieldName)) continue;
    // The form fills hidden fields itself (tracking tokens and the like).
    if (q.kind === "hidden") continue;
    if (q.kind === "file") {
      // Only the resume and cover letter exist as files; another upload is Paul's to give.
      if (q.required) result.unsupported.push({ fieldName: q.fieldName, reason: "file_upload" });
      continue;
    }
    result.questions.push({
      fieldName: q.fieldName,
      label: q.label,
      required: q.required,
      // Greenhouse publishes no length limits.
      maxLength: null,
      // The labels: what an answer is compared with, and what the driver picks (NS-142).
      choices: q.choices === null ? null : q.choices.map((c) => c.label),
    });
  }
  return result;
}
