import { type AtsAdapter, capture, pageText } from "./adapter.js";

// Lever hosted postings (`jobs.lever.co/<company>/<posting>/apply`). Lever asks for one full
// name and has no cover letter upload. Markers are hand-written (follow-up: record real pages).
export const lever: AtsAdapter = {
  ats: "lever",
  hosts: ["jobs.lever.co"],
  standardFields: (c) => ({
    name: `${c.firstName} ${c.lastName}`,
    email: c.email,
    ...(c.phone === null ? {} : { phone: c.phone }),
  }),
  // `/<company>/<posting uuid>[/apply]`
  postingIdOf: capture(
    /^\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i,
  ),
  resumeField: "resume",
  coverLetterField: null,
  isConfirmation: ({ url, html }) =>
    new URL(url).pathname.endsWith("/thanks") || pageText(html).includes("application submitted"),
};
