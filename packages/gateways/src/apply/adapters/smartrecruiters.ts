import { type AtsAdapter, capture, pageText } from "./adapter.js";

// SmartRecruiters job pages (NS-173, APPLY-002 P2). HAND-WRITTEN: the field names and markers are
// synthetic, shaped after SmartRecruiters' public job pages, and must be checked against recorded
// pages (NS-142), like NS-120's adapters. Custom questions come from the package's field map.
export const smartrecruiters: AtsAdapter = {
  ats: "smartrecruiters",
  hosts: ["jobs.smartrecruiters.com"],
  standardFields: (c) => ({
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    ...(c.phone === null ? {} : { phoneNumber: c.phone }),
  }),
  // `/<Company>/<id>[-title-slug]`, the shape packages/sources' detectAts reads.
  postingIdOf: capture(/^\/[^/]+\/(\d{1,20})(?:-[^/]*)?\/?$/),
  resumeField: "resume",
  coverLetterField: "coverLetter",
  isConfirmation: ({ url, html }) => {
    const text = pageText(html);
    return (
      new URL(url).pathname.endsWith("/success") ||
      text.includes("thank you for applying") ||
      text.includes("application received")
    );
  },
};
