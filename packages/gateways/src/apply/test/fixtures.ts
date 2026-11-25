import { createHash } from "node:crypto";
import type { ApplicationPackage, ApplyAts } from "@northstar/domain";
import type { FormField } from "../driver.js";

// HAND-WRITTEN, synthetic fixtures (NS-120): form snapshots and confirmation pages shaped after
// each ATS's public board pages, with invented companies and people. They are not recordings;
// the Playwright driver follow-up replaces them with recorded pages.

export const RESUME = new TextEncoder().encode("%PDF-1.4 synthetic resume for tests");
export const COVER = new TextEncoder().encode("%PDF-1.4 synthetic cover letter for tests");
export const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export const FORMS: Record<ApplyAts, FormField[]> = {
  greenhouse: [
    { name: "first_name", type: "text", required: true },
    { name: "last_name", type: "text", required: true },
    { name: "email", type: "email", required: true },
    { name: "phone", type: "tel", required: false },
    { name: "resume", type: "file", required: true },
    { name: "cover_letter", type: "file", required: false },
    { name: "question_1001", type: "select", required: true, options: ["Yes", "No"] },
    { name: "question_1002", type: "textarea", required: false },
    { name: "authenticity_token", type: "hidden", required: true },
  ],
  lever: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true },
    { name: "phone", type: "tel", required: false },
    { name: "resume", type: "file", required: true },
    { name: "urls[LinkedIn]", type: "text", required: false },
    { name: "cards[aaaa][field0]", type: "radio", required: true, options: ["Yes", "No"] },
  ],
  ashby: [
    { name: "_systemfield_name", type: "text", required: true },
    { name: "_systemfield_email", type: "email", required: true },
    { name: "_systemfield_resume", type: "file", required: true },
    {
      name: "5f0c1e2a-0000-4000-8000-000000000001",
      type: "checkbox",
      required: true,
      options: ["New York", "Remote"],
    },
  ],
};

export const FIELDS: Record<ApplyAts, ApplicationPackage["fields"]> = {
  greenhouse: { question_1001: "Yes", question_1002: "Synthetic answer for a test." },
  lever: { "urls[LinkedIn]": "https://www.example.com/in/ada", "cards[aaaa][field0]": "Yes" },
  ashby: { "5f0c1e2a-0000-4000-8000-000000000001": ["Remote"] },
};

export const APPLY_URLS: Record<ApplyAts, string> = {
  greenhouse: "https://boards.greenhouse.io/examplecorp/jobs/4001",
  lever: "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002/apply",
  ashby: "https://jobs.ashbyhq.com/examplecorp/0b0b0b0b-0000-4000-8000-000000000003/application",
};

export const POSTING_IDS: Record<ApplyAts, string> = {
  greenhouse: "4001",
  lever: "0a0a0a0a-0000-4000-8000-000000000002",
  ashby: "0b0b0b0b-0000-4000-8000-000000000003",
};

export const CONFIRMATIONS: Record<ApplyAts, { url: string; html: string }> = {
  greenhouse: {
    url: "https://boards.greenhouse.io/examplecorp/jobs/4001/confirmation",
    html: "<html><body><div id='application_confirmation'><h1>Thank you for applying.</h1></div></body></html>",
  },
  lever: {
    url: "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002/thanks",
    html: "<html><body><h3>Application submitted!</h3></body></html>",
  },
  ashby: {
    url: "https://jobs.ashbyhq.com/examplecorp/0b0b0b0b-0000-4000-8000-000000000003/application",
    html: "<html><body><p>Your application was successfully submitted.</p></body></html>",
  },
};

export function makePackage(ats: ApplyAts, overrides: Partial<ApplicationPackage> = {}) {
  return {
    packageId: "11111111-1111-4111-8111-111111111111",
    applicationId: "22222222-2222-4222-8222-222222222222",
    ats,
    postingId: POSTING_IDS[ats],
    applyUrl: APPLY_URLS[ats],
    contact: { firstName: "Ada", lastName: "Example", email: "ada@example.com", phone: null },
    resume: { fileName: "resume.pdf", sha256: sha(RESUME) },
    coverLetter: null,
    fields: FIELDS[ats],
    ...overrides,
  } satisfies ApplicationPackage;
}
