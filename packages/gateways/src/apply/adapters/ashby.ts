import { type AtsAdapter, capture, pageText } from "./adapter.js";

// Ashby hosted job boards. Ashby's standard fields use `_systemfield_*` names; custom questions
// are field ids from the package's field map. Field names and markers are hand-written: Ashby's
// application page is built by JavaScript, so a plain GET has no form to record (NS-142 slice 2).
export const ashby: AtsAdapter = {
  ats: "ashby",
  hosts: ["jobs.ashbyhq.com"],
  standardFields: (c) => ({
    _systemfield_name: `${c.firstName} ${c.lastName}`,
    _systemfield_email: c.email,
    ...(c.phone === null ? {} : { _systemfield_phone: c.phone }),
  }),
  // `/<org>/<posting uuid>[/application]`
  postingIdOf: capture(
    /^\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/application)?\/?$/i,
  ),
  resumeField: "_systemfield_resume",
  coverLetterField: null,
  isConfirmation: ({ html }) =>
    pageText(html).includes("your application was successfully submitted"),
};
