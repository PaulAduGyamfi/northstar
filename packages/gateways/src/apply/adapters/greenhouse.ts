import { type AtsAdapter, capture, pageText } from "./adapter.js";

// Greenhouse hosted job boards. Standard field names are Greenhouse's own; custom questions
// (`question_<id>`) come from the package's field map. Markers are hand-written from Greenhouse's
// public board pages and must be checked against recorded pages (follow-up to NS-120).
export const greenhouse: AtsAdapter = {
  ats: "greenhouse",
  hosts: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
  standardFields: (c) => ({
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    ...(c.phone === null ? {} : { phone: c.phone }),
  }),
  // `/<board>/jobs/<id>`
  postingIdOf: capture(/^\/[^/]+\/jobs\/(\d+)\/?$/),
  resumeField: "resume",
  coverLetterField: "cover_letter",
  isConfirmation: ({ url, html }) =>
    new URL(url).pathname.endsWith("/confirmation") ||
    pageText(html).includes("thank you for applying"),
};
