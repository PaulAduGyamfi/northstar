import { type AtsAdapter, capture, pageText } from "./adapter.js";

// SmartRecruiters job pages (NS-173, APPLY-002 P2). HAND-WRITTEN: the field names and markers are
// synthetic, shaped after SmartRecruiters' public job pages, and must be checked against recorded
// pages (NS-142), like NS-120's adapters. Custom questions come from the package's field map.
// NS-142 slice 3 found the posting page has no form and its one-click apply flow answers a headless
// browser with a bot check, so the names stay hand-written and the driver hands off (ADR-0003).
export const smartrecruiters: AtsAdapter = {
  ats: "smartrecruiters",
  // careers.smartrecruiters.com links are refused (HostNotAllowed) until the package builder
  // rewrites them to this host, as packages/sources' boards/detect.ts does; widening the list
  // waits for a recorded page (NS-142).
  hosts: ["jobs.smartrecruiters.com"],
  standardFields: (c) => ({
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    ...(c.phone === null ? {} : { phoneNumber: c.phone }),
  }),
  // `/<Company>/<id>[-title-slug]`, the shape packages/sources' detectAts reads.
  // No leading zero, so "0744…" and "744…" can't be two postings (two requisition keys).
  postingIdOf: capture(/^\/[^/]+\/([1-9]\d{0,19})(?:-[^/]*)?\/?$/),
  resumeField: "resume",
  coverLetterField: "coverLetter",
  // The success page AND its message: the text alone could come from a job description the
  // employer wrote ("Thank you for applying!"), on a form page re-rendered after a failed submit.
  isConfirmation: ({ url, html }) =>
    new URL(url).pathname.endsWith("/success") && pageText(html).includes("thank you for applying"),
};
