import { type AtsAdapter, capture, pageText } from "./adapter.js";

// Ashby hosted job boards. Ashby's standard fields use `_systemfield_*` names; custom questions
// are field ids from the package's field map. The standard names are RECORDED (NS-142 slice 3,
// `test/recorded.ts`): `_systemfield_name`, `_systemfield_email` and the resume's id. Phone is not
// a system field there (the board asks it as its own question), so it comes from the field map.
// The confirmation marker stays hand-written: recording it needs a submission.
export const ashby: AtsAdapter = {
  ats: "ashby",
  hosts: ["jobs.ashbyhq.com"],
  standardFields: (c) => ({
    _systemfield_name: `${c.firstName} ${c.lastName}`,
    _systemfield_email: c.email,
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
