import { type AtsAdapter, capture, pageText } from "./adapter.js";

// Greenhouse hosted job boards. Standard field names are Greenhouse's own; custom questions
// (`question_<id>`) come from the package's field map. The field names were checked against a
// recorded form (NS-142 slice 2, `test/recorded.ts`): the current board has them as ids, with no
// name attribute, which the driver can't read yet (#353). The confirmation markers are still
// hand-written: recording a confirmation page needs a submission.
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
